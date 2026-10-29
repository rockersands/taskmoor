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
 * The inbox at size (M1-058; NTF-003): one person with 50,000 inbox items over 2,000 tickets
 * of a track, a tenth of them about comments restricted to a group the reader is not in. The
 * first page with its counts, a later page and the counts alone stay quick: reads walk the
 * inbox index and judge the rows they meet. The track's activity (CORE-022 (2): a page within
 * 500 ms) reads 20,000 changes over those tickets. Measured on 2026-10-29, p95 of 30: see the
 * progress row of M1-058. Run with
 *   TASKMOOR_LARGE_INBOX=1 pnpm verify --only=tests -- apps/server/src/routes/inbox.large.test.ts
 */
const ITEMS = 50_000;
const TICKETS = 2_000;
/** Each read, at p95; ten times what was measured, so a busy machine does not decide. */
const BUDGET_MS = 250;
const p95 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] as number;

describe.skipIf(!process.env.TASKMOOR_LARGE_INBOX)('a large inbox (M1-058)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const password = `large-${randomBytes(18).toString('base64url')}`;
    const user = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'reader@example.com',
        name: 'Reader',
        password_hash: await hashPassword(password),
        is_site_admin: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'reader@example.com', password },
    });
    const header = [session.headers['set-cookie'] ?? []].flat();
    cookie =
      header
        .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
        ?.split(';')[0] ?? '';
    const track = await app.inject({
      method: 'POST',
      url: '/api/v1/tracks',
      headers: { cookie },
      payload: { key: 'BIG', name: 'Big', mode: 'shared' },
    });
    expect(track.statusCode, track.body).toBe(201);
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: { cookie },
      payload: { track: 'BIG', summary: 'Template' },
    });
    expect(first.statusCode, first.body).toBe(201);
    const template = first.json().ticket.id as number;
    // Tickets copied from the first one, numbered on; comments on every tenth.
    await sql`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                          creator_id, rank, fields, labels)
      SELECT workspace_id, track_id, number + g, ticket_type_id, status_id, 'Ticket ' || g,
             creator_id, rank || lpad(g::text, 6, '0'), fields, labels
        FROM ticket, generate_series(1, ${TICKETS - 1}) AS g
       WHERE id = ${template}`.execute(database.db);
    await sql`
      INSERT INTO ticket_comment (workspace_id, ticket_id, author_id, body, visible_group_id)
      SELECT 1, id, NULL, '{"type":"doc","content":[]}'::jsonb, 999999
        FROM ticket WHERE track_id = (SELECT id FROM track WHERE key = 'BIG')`.execute(database.db);
    await sql`
      WITH ids AS (SELECT array_agg(id ORDER BY id) AS a FROM ticket
                    WHERE track_id = (SELECT id FROM track WHERE key = 'BIG')),
           items AS (SELECT g, ids.a[1 + g % ${TICKETS}] AS ticket_id
                       FROM generate_series(1, ${ITEMS}) AS g, ids)
      INSERT INTO notification (workspace_id, user_id, channel, event, ticket_id,
                                domain_event_id, payload, direct, read_at, created_at)
      SELECT 1, ${user.id}, 'inbox',
             CASE WHEN g % 10 = 0 THEN 'ticket_commented' ELSE 'ticket_updated' END,
             ticket_id, 1000000 + g,
             CASE WHEN g % 10 = 0
                  THEN jsonb_build_object('type', 'comment.created', 'commentId',
                         (SELECT id FROM ticket_comment WHERE ticket_comment.ticket_id = items.ticket_id
                           LIMIT 1))
                  ELSE '{"type":"ticket.updated"}'::jsonb END,
             g % 7 = 0, CASE WHEN g % 3 = 0 THEN now() END,
             now() - make_interval(secs => g)
        FROM items`.execute(database.db);
    // History for the track's activity: ten changes per ticket.
    await sql`
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, field, from_value, to_value)
      SELECT 1, k.id, nextval('ticket_change_set_seq'), 'summary', 'Before ' || s, 'After ' || s
        FROM ticket k, generate_series(1, 10) AS s
       WHERE k.track_id = (SELECT id FROM track WHERE key = 'BIG')
       ORDER BY s, k.id`.execute(database.db);
    // Statistics as autovacuum would keep them after a load this size.
    await sql`ANALYZE`.execute(database.db);
  }, 600_000);
  afterAll(async () => {
    await app.close();
  });

  it('[NTF-003] reads pages and counts of a 50,000-item inbox quickly', async () => {
    const time = async (url: string) => {
      const started = performance.now();
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, res.body).toBe(200);
      return { ms: performance.now() - started, body: res.json() };
    };
    const firsts: number[] = [];
    const counts: number[] = [];
    const later: number[] = [];
    let cursor = '';
    for (let i = 0; i < 30; i++) {
      const page = await time('/api/v1/inbox?limit=50');
      firsts.push(page.ms);
      // Restricted comments the reader may not read (a group he is not in) are left out.
      expect(
        page.body.items.every((item: { event: string }) => item.event !== 'ticket_commented'),
      ).toBe(true);
      cursor = page.body.next;
      counts.push((await time('/api/v1/inbox/count')).ms);
      later.push((await time(`/api/v1/inbox?limit=50&cursor=${cursor}`)).ms);
    }
    // The track's activity: 20,000 changes over 2,000 tickets, newest first.
    const activity: number[] = [];
    for (let i = 0; i < 30; i++) {
      const page = await time('/api/v1/tracks/BIG/activity?limit=50');
      expect(page.body.activity).toHaveLength(50);
      activity.push(page.ms);
    }
    const result = {
      first: p95(firsts),
      count: p95(counts),
      later: p95(later),
      trackActivity: p95(activity),
    };
    const line = `inbox of ${ITEMS} items, p95 ms: ${JSON.stringify(result)}`;
    process.stdout.write(`${line}\n`);
    if (process.env.TASKMOOR_LARGE_INBOX_REPORT) {
      appendFileSync(process.env.TASKMOOR_LARGE_INBOX_REPORT, `${line}\n`);
    }
    expect(result.first).toBeLessThan(BUDGET_MS);
    expect(result.count).toBeLessThan(BUDGET_MS);
    expect(result.later).toBeLessThan(BUDGET_MS);
    expect(result.trackActivity).toBeLessThan(500);
  }, 600_000);
});
