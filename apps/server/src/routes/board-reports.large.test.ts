import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

/**
 * Flow reports at size (M1-061: "100k tickets computed < 5 s"): a Kanban board over 100,000
 * tickets of one track, read by a member (the ticket filter is in every statement), each ticket
 * with a status history over the last 90 days: created, then four in five started, half in
 * review, two in five closed (about 370,000 status rows). Each report is read over 90 days,
 * three times after a first read. Run with
 *   TASKMOOR_LARGE_REPORTS=1 pnpm verify --only=tests -- apps/server/src/routes/board-reports.large.test.ts
 * Measured on 2026-10-29: see the progress row of M1-061.
 */
const TICKETS = 100_000;

describe.skipIf(!process.env.TASKMOOR_LARGE_REPORTS)('flow reports at size (M1-061)', () => {
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
    const status = Object.fromEntries(
      (await database.db.selectFrom('status').select(['id', 'name']).execute()).map((s) => [
        s.name,
        s.id,
      ]),
    ) as Record<string, number>;
    await sql`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                          creator_id, rank, fields, labels)
      SELECT k.workspace_id, k.track_id, k.number + g, k.ticket_type_id,
             CASE WHEN g % 5 < 2 THEN ${status.Closed}::int
                  WHEN g % 2 = 0 THEN ${status['In Review']}::int
                  WHEN g % 5 < 4 THEN ${status.Active}::int
                  ELSE ${status.New}::int END,
             'Ticket ' || g, k.creator_id, k.rank || lpad(g::text, 6, '0'), k.fields, k.labels
        FROM ticket k, generate_series(1, ${TICKETS - 1}) AS g
       WHERE k.id = ${template}`.execute(database.db);
    // The history: created over the last 90 days, then the moves the status above implies.
    await sql`
      WITH k AS (
        SELECT id, row_number() OVER (ORDER BY id) AS g,
               now() - interval '90 days' + (row_number() OVER (ORDER BY id)) * interval '60 seconds' AS born
          FROM ticket WHERE track_id = ${trackId}::int AND id <> ${template}::int
      ), moves AS (
        SELECT id, born AS at, NULL::int AS from_s, ${status.New}::int AS to_s FROM k
        UNION ALL
        SELECT id, born + interval '1 day' + (g % 7) * interval '1 hour', ${status.New}, ${status.Active}
          FROM k WHERE g % 5 <> 4
        UNION ALL
        SELECT id, born + interval '3 days' + (g % 11) * interval '1 hour', ${status.Active}, ${status['In Review']}
          FROM k WHERE g % 2 = 0 AND g % 5 <> 4
        UNION ALL
        SELECT id, born + interval '5 days' + (g % 13) * interval '1 hour',
               CASE WHEN g % 2 = 0 THEN ${status['In Review']}::int ELSE ${status.Active}::int END,
               ${status.Closed}
          FROM k WHERE g % 5 < 2
      )
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, field, from_value, to_value,
                                 from_display, to_display, at)
      SELECT 1, id, '1', 'status', from_s::text, to_s::text, '', '', at FROM moves`.execute(
      database.db,
    );
    await sql`ANALYZE`.execute(database.db);
    const board = await app.inject({
      method: 'POST',
      url: '/api/v1/boards',
      headers: { cookie },
      payload: {
        name: 'Big kanban',
        kind: 'kanban',
        trackId,
        source: { query: 'track = BIG' },
        columns: [
          { id: 'todo', name: 'To do', statusIds: [status.New] },
          { id: 'doing', name: 'Doing', statusIds: [status.Active] },
          { id: 'review', name: 'Review', statusIds: [status['In Review']] },
          { id: 'done', name: 'Done', statusIds: [status.Closed] },
        ],
      },
    });
    expect(board.statusCode, board.body).toBe(201);
    boardId = board.json().board.id;
  }, 900_000);
  afterAll(async () => {
    await app.close();
  });

  it('[RPT-001] computes each flow report of a 100,000-ticket board in under 5 s', async () => {
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const window = `from=${day(-89)}&to=${day(0)}&timeZone=UTC`;
    const timings: Record<string, number[]> = {};
    for (const report of ['cumulative-flow', 'cycle-time', 'time-in-status']) {
      timings[report] = [];
      for (let i = 0; i < 4; i++) {
        const started = performance.now();
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/boards/${boardId}/reports/${report}?${window}`,
          headers: { cookie },
        });
        const ms = performance.now() - started;
        expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
        if (i > 0) timings[report]?.push(ms);
        if (i === 0 && report === 'cumulative-flow') {
          const done = res.json().columns.at(-1).counts.at(-1);
          expect(done).toBeGreaterThan(30_000);
        }
        if (i === 0 && report === 'cycle-time') expect(res.json().total).toBeGreaterThan(30_000);
      }
    }
    const worst = Object.fromEntries(
      Object.entries(timings).map(([k, v]) => [k, Math.round(Math.max(...v))]),
    );
    process.stdout.write(
      `M1-061 flow reports on ${TICKETS} tickets over 90 days, worst of 3 (ms): ${JSON.stringify(worst)}\n`,
    );
    for (const ms of Object.values(worst)) expect(ms).toBeLessThan(5_000);
  }, 900_000);
});
