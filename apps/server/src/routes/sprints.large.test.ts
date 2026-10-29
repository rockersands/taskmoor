import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

/**
 * Sprints at size (M1-044): a Scrum board over 20,000 tickets of one track, read by a member
 * (the ticket filter is in every statement). 1,000 tickets go into a sprint in two requests of
 * 500, it starts, the backlog (2,000 rows: the sprint sections, then the backlog) and the
 * sprint report are read ten times each, and the sprint completes into the next one. Run with
 *   TASKMOOR_LARGE_SPRINTS=1 pnpm verify --only=tests -- apps/server/src/routes/sprints.large.test.ts
 * Measured on 2026-10-29: see the progress row of M1-044.
 */
const TICKETS = 20_000;
const p95 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] as number;

describe.skipIf(!process.env.TASKMOOR_LARGE_SPRINTS)('sprints at size (M1-044)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  let boardId = 0;
  let ticketIds: number[] = [];

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const password = `large-${randomBytes(18).toString('base64url')}`;
    const hash = await hashPassword(password);
    const ids: Record<string, number> = {};
    for (const [name, admin] of [
      ['admin', true],
      ['member', false],
    ] as const) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: admin,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids[name] = row.id;
    }
    const signIn = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email, password },
      });
      return (
        [res.headers['set-cookie'] ?? []]
          .flat()
          .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
          ?.split(';')[0] ?? ''
      );
    };
    const admin = await signIn('admin@example.com');
    cookie = await signIn('member@example.com');
    const track = await app.inject({
      method: 'POST',
      url: '/api/v1/tracks',
      headers: { cookie: admin },
      payload: { key: 'BIG', name: 'Big', mode: 'shared' },
    });
    expect(track.statusCode, track.body).toBe(201);
    const trackId = track.json().track.id as number;
    const members = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('track_role_actor')
      .values({ workspace_id: 1, track_id: trackId, role_id: members.id, user_id: ids.member })
      .execute();
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: { cookie: admin },
      payload: { track: 'BIG', summary: 'Template' },
    });
    expect(first.statusCode, first.body).toBe(201);
    const template = first.json().ticket.id as number;
    // Copies over New, Active and In Review, each with an estimate of one to four hours.
    await sql`
      WITH s AS (SELECT array_agg(id ORDER BY sort_order) AS a FROM status
                  WHERE name IN ('New', 'Active', 'In Review'))
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                          creator_id, rank, fields, labels, original_estimate, remaining_estimate)
      SELECT k.workspace_id, k.track_id, k.number + g, k.ticket_type_id, s.a[1 + g % 3],
             'Ticket ' || g, k.creator_id, k.rank || lpad(g::text, 6, '0'), k.fields, k.labels,
             3600 * (1 + g % 4), 3600 * (1 + g % 4)
        FROM ticket k, s, generate_series(1, ${TICKETS - 1}) AS g
       WHERE k.id = ${template}`.execute(database.db);
    await sql`ANALYZE`.execute(database.db);
    const board = await app.inject({
      method: 'POST',
      url: '/api/v1/boards',
      headers: { cookie },
      payload: { name: 'Big scrum', kind: 'scrum', trackId, source: { query: 'track = BIG' } },
    });
    expect(board.statusCode, board.body).toBe(201);
    boardId = board.json().board.id;
    ticketIds = (
      await database.db
        .selectFrom('ticket')
        .select('id')
        .where('track_id', '=', trackId)
        .orderBy('rank')
        .limit(1000)
        .execute()
    ).map((r) => r.id);
  }, 600_000);
  afterAll(async () => {
    await app.close();
  });

  it('[AGL-010] plans, reads, reports and completes a 1,000-ticket sprint on a 20,000-ticket board', async () => {
    const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const started = performance.now();
      const res = await app.inject({
        method,
        url,
        headers: { cookie },
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });
      expect(res.statusCode, res.body.slice(0, 300)).toBe(
        method === 'POST' && url.endsWith('/sprints') ? 201 : 200,
      );
      return { ms: performance.now() - started, body: res.json() };
    };
    const one = (await call('POST', `/api/v1/boards/${boardId}/sprints`, {})).body.sprint.id;
    const two = (await call('POST', `/api/v1/boards/${boardId}/sprints`, {})).body.sprint.id;
    const adds: number[] = [];
    for (const part of [ticketIds.slice(0, 500), ticketIds.slice(500, 1000)]) {
      adds.push((await call('POST', `/api/v1/sprints/${one}/tickets`, { tickets: part })).ms);
    }
    const started = await call('POST', `/api/v1/sprints/${one}/start`, {
      endAt: '2030-01-15T09:00:00Z',
    });
    const backlog: number[] = [];
    let read: { sprints: { tickets: unknown[] }[]; backlog: { tickets: unknown[] } } = {
      sprints: [],
      backlog: { tickets: [] },
    };
    for (let i = 0; i < 10; i++) {
      const r = await call('GET', `/api/v1/boards/${boardId}/backlog`);
      backlog.push(r.ms);
      read = r.body;
    }
    expect(read.sprints[0]?.tickets).toHaveLength(1000);
    expect(read.backlog.tickets).toHaveLength(1000);
    const reports: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await call('GET', `/api/v1/sprints/${one}/report`);
      reports.push(r.ms);
      expect(r.body.notCompleted).toHaveLength(1000);
    }
    const completed = await call('POST', `/api/v1/sprints/${one}/complete`, {
      moveTo: { type: 'sprint', sprintId: two },
    });
    expect(completed.body.carriedOver).toBe(1000);
    process.stdout.write(
      `M1-044 sprints on ${TICKETS} tickets: add 500 ${Math.round(Math.max(...adds))} ms; start with 1,000 ${Math.round(started.ms)} ms; backlog p95 ${Math.round(p95(backlog))} ms; report p95 ${Math.round(p95(reports))} ms; complete 1,000 ${Math.round(completed.ms)} ms\n`,
    );
    // Generous: a busy machine must not decide.
    expect(p95(backlog)).toBeLessThan(10_000);
  }, 900_000);
});
