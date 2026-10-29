import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

/**
 * A board at size (M1-043; AGL-013): 50,000 tickets of one track, read by a member (so the
 * ticket filter is in every statement) on a board with query lanes, query colours and the
 * days-in-column marker. The first 5,000 cards in rank order with every count, and all
 * 50,000 cards at once (AGL-013 (2): loads without errors). Run with
 *   TASKMOOR_LARGE_BOARD=1 pnpm verify --only=tests -- apps/server/src/routes/boards.large.test.ts
 * Measured on 2026-10-29: see the progress row of M1-043.
 */
const TICKETS = 50_000;
const p95 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] as number;

describe.skipIf(!process.env.TASKMOOR_LARGE_BOARD)('a large board (M1-043)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  let boardId = 0;

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
    // Copies of the first ticket over the four statuses, every 20th urgent, every 3rd assigned.
    await sql`
      WITH s AS (SELECT array_agg(id ORDER BY sort_order) AS a FROM status
                  WHERE name IN ('New', 'Active', 'In Review', 'Closed')),
           p AS (SELECT id FROM priority WHERE name = 'Urgent')
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                          creator_id, assignee_id, priority_id, rank, fields, labels)
      SELECT k.workspace_id, k.track_id, k.number + g, k.ticket_type_id, s.a[1 + g % 4],
             'Ticket ' || g, k.creator_id,
             CASE WHEN g % 3 = 0 THEN ${ids.member}::int END,
             CASE WHEN g % 20 = 0 THEN p.id ELSE k.priority_id END,
             k.rank || lpad(g::text, 6, '0'), k.fields, k.labels
        FROM ticket k, s, p, generate_series(1, ${TICKETS - 1}) AS g
       WHERE k.id = ${template}`.execute(database.db);
    // Two status changes for every tenth ticket, for days in column.
    await sql`
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, field, from_value, to_value)
      SELECT 1, k.id, nextval('ticket_change_set_seq'), 'status', k.status_id::text,
             k.status_id::text
        FROM ticket k, generate_series(1, 2)
       WHERE k.track_id = ${trackId} AND k.number % 10 = 0`.execute(database.db);
    await sql`ANALYZE`.execute(database.db);
    const board = await app.inject({
      method: 'POST',
      url: '/api/v1/boards',
      headers: { cookie: admin },
      payload: {
        name: 'Big board',
        kind: 'kanban',
        trackId,
        source: { query: 'track = BIG' },
        swimlanes: {
          mode: 'queries',
          lanes: [{ name: 'Expedite', query: 'priority = Urgent' }],
        },
        cardRules: {
          colourBy: 'queries',
          colours: [{ query: 'assignee IS EMPTY', colour: '#5c6b7a' }],
          fields: ['assignee', 'priority'],
        },
      },
    });
    expect(board.statusCode, board.body).toBe(201);
    boardId = board.json().board.id;
  }, 600_000);
  afterAll(async () => {
    await app.close();
  });

  it('[AGL-013] reads 5,000 cards of a 50,000-ticket board, and all 50,000', async () => {
    const time = async (url: string) => {
      const started = performance.now();
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      return { ms: performance.now() - started, body: res.json() };
    };
    const samples: number[] = [];
    let first: { body: { cards: unknown[]; columns: { count: number }[]; truncated: boolean } } = {
      body: { cards: [], columns: [], truncated: false },
    };
    for (let i = 0; i < 10; i++) {
      const read = await time(`/api/v1/boards/${boardId}/data`);
      samples.push(read.ms);
      first = read;
    }
    expect(first.body.cards).toHaveLength(5000);
    expect(first.body.truncated).toBe(true);
    expect(first.body.columns.reduce((sum, c) => sum + c.count, 0)).toBe(TICKETS);
    const filtered: number[] = [];
    for (let i = 0; i < 10; i++) {
      filtered.push((await time(`/api/v1/boards/${boardId}/data?filters=mine`)).ms);
    }
    const all = await time(`/api/v1/boards/${boardId}/data?limit=50000`);
    expect(all.body.cards).toHaveLength(TICKETS);
    const line = `M1-043 board at ${TICKETS}: 5,000 cards p95 ${Math.round(p95(samples))} ms; with "Only my tickets" p95 ${Math.round(p95(filtered))} ms; all ${TICKETS} cards ${Math.round(all.ms)} ms`;
    process.stdout.write(`${line}\n`);
    if (process.env.TASKMOOR_LARGE_BOARD_REPORT) {
      appendFileSync(process.env.TASKMOOR_LARGE_BOARD_REPORT, `${line}\n`);
    }
    // Generous: a busy machine must not decide; the UI budget of M1-046 is the real one.
    expect(p95(samples)).toBeLessThan(10_000);
  }, 900_000);
});
