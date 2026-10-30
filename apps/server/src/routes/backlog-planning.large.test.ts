import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { isRankKey } from '../tickets/rank';

/**
 * Ranking at size (M1-047): a Scrum board's backlog of 10,000 tickets, reordered by 300 random
 * block moves of one to twenty selected tickets (before or after another ticket, to the top or
 * to the bottom) through `POST /api/v1/boards/:id/backlog/rank`. The order in the database must
 * then equal the same moves applied to a list, every key must be a well-formed, unique rank key,
 * and keys must stay short (no rebalance is ever needed). Run with
 *   TASKMOOR_LARGE_BACKLOG=1 pnpm verify --only=tests -- apps/server/src/routes/backlog-planning.large.test.ts
 * Measured on 2026-10-29: see the progress row of M1-047.
 */
const TICKETS = 10_000;
const MOVES = 300;
const p95 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] as number;

/** A small seeded generator, so a failure can be replayed. */
function random(seed: number) {
  let state = seed >>> 0;
  return (below: number) => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state % below;
  };
}

describe.skipIf(!process.env.TASKMOOR_LARGE_BACKLOG)('ranking at size (M1-047)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  let boardId = 0;
  let trackId = 0;

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
      payload: { key: 'RNK', name: 'Ranked', mode: 'shared' },
    });
    expect(track.statusCode, track.body).toBe(201);
    trackId = track.json().track.id as number;
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
      payload: { track: 'RNK', summary: 'Template' },
    });
    expect(first.statusCode, first.body).toBe(201);
    const template = first.json().ticket.id as number;
    // Copies after the template, each with a key one fraction past it (never ending in 0).
    await sql`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                          creator_id, rank, fields, labels)
      SELECT k.workspace_id, k.track_id, k.number + g, k.ticket_type_id, k.status_id,
             'Ticket ' || g, k.creator_id, k.rank || lpad(g::text, 5, '0') || '1', k.fields,
             k.labels
        FROM ticket k, generate_series(1, ${TICKETS - 1}) AS g
       WHERE k.id = ${template}`.execute(database.db);
    await sql`ANALYZE`.execute(database.db);
    const board = await app.inject({
      method: 'POST',
      url: '/api/v1/boards',
      headers: { cookie },
      payload: { name: 'Ranked scrum', kind: 'scrum', trackId, source: { query: 'track = RNK' } },
    });
    expect(board.statusCode, board.body).toBe(201);
    boardId = board.json().board.id;
  }, 600_000);
  afterAll(async () => {
    await app.close();
  });

  const ranked = async () =>
    database.db
      .selectFrom('ticket')
      .select(['id', 'rank'])
      .where('track_id', '=', trackId)
      .orderBy('rank')
      .execute();

  it('[AGL-009] keeps 10,000 tickets in the order of 300 block moves, with short keys', async () => {
    let order = (await ranked()).map((r) => r.id);
    expect(order).toHaveLength(TICKETS);
    const next = random(47);
    const times: number[] = [];
    for (let move = 0; move < MOVES; move++) {
      const size = 1 + next(20);
      const block: number[] = [];
      while (block.length < size) {
        const ticket = order[next(order.length)] as number;
        if (!block.includes(ticket)) block.push(ticket);
      }
      const rest = order.filter((t) => !block.includes(t));
      const where = next(10);
      let payload: Record<string, unknown>;
      let at: number;
      if (where === 0) {
        payload = { position: 'top' };
        at = 0;
      } else if (where === 1) {
        payload = { position: 'bottom' };
        at = rest.length;
      } else {
        const index = next(rest.length);
        const anchor = rest[index] as number;
        const before = where % 2 === 0;
        payload = before ? { before: anchor } : { after: anchor };
        at = before ? index : index + 1;
      }
      const started = performance.now();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/boards/${boardId}/backlog/rank`,
        headers: { cookie },
        payload: { tickets: block, ...payload },
      });
      times.push(performance.now() - started);
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      expect(res.json().ranked).toBe(block.length);
      order = [...rest.slice(0, at), ...block, ...rest.slice(at)];
    }
    const rows = await ranked();
    expect(rows.map((r) => r.id)).toEqual(order);
    expect(rows.every((r) => isRankKey(r.rank))).toBe(true);
    expect(new Set(rows.map((r) => r.rank)).size).toBe(TICKETS);
    const longest = Math.max(...rows.map((r) => r.rank.length));
    process.stdout.write(
      `M1-047 ranking on ${TICKETS} tickets: ${MOVES} block moves, p95 ${Math.round(p95(times))} ms, max ${Math.round(Math.max(...times))} ms; longest key ${longest} characters\n`,
    );
    expect(longest).toBeLessThan(24);
  }, 900_000);
});
