import { appendFileSync } from 'node:fs';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { registerBulkJobs } from './jobs';

/**
 * The backlog's measure for bulk changes (M1-021): a 10,000-ticket bulk edit finishes in under
 * two minutes, with a history row for every ticket and the request in the audit trail. It
 * writes 10,000 tickets, so it runs only when asked:
 *
 *   TASKMOOR_LARGE_BULK=1 pnpm verify --only=tests -- apps/server/src/bulk/bulk.large.test.ts
 *
 * TASKMOOR_LARGE_BULK_REPORT names a file the measurement is appended to.
 */
const TICKETS = 10_000;
const BUDGET_MS = 120_000;

describe.skipIf(!process.env.TASKMOOR_LARGE_BULK)('a 10,000-ticket bulk edit (M1-021)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  let userId = 0;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const user = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'bulk@example.com',
        name: 'Bulk',
        password_hash: await hashPassword('ladder violet harbour'),
        is_site_admin: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    userId = user.id;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'bulk@example.com', password: 'ladder violet harbour' },
    });
    cookie =
      [res.headers['set-cookie']]
        .flat()
        .find((c) => c?.startsWith(`${SESSION_COOKIE}=`))
        ?.split(';')[0] ?? '';
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-024] edits 10,000 tickets in under two minutes, with history and audit', async () => {
    const track = await app.inject({
      method: 'POST',
      url: '/api/v1/tracks',
      headers: { cookie },
      payload: { key: 'BIG', name: 'Big', mode: 'shared' },
    });
    expect(track.statusCode, track.body).toBe(201);
    const trackId = track.json().track.id as number;
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: { cookie },
      payload: { track: 'BIG', summary: 'First' },
    });
    expect(first.statusCode, first.body).toBe(201);
    const seed = await database.db
      .selectFrom('ticket')
      .select(['ticket_type_id', 'status_id'])
      .where('track_id', '=', trackId)
      .executeTakeFirstOrThrow();
    await sql`INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary,
          requester_id, creator_id, rank, status_id)
        SELECT 1, ${trackId}, g, ${seed.ticket_type_id}, 'Bulk ' || g, ${userId}, ${userId},
               'zbig' || lpad(g::text, 6, '0'), ${seed.status_id}
          FROM generate_series(2, ${TICKETS}) g`.execute(database.db);
    await sql`UPDATE ticket_counter SET last_number = ${TICKETS} WHERE track_id = ${trackId}`.execute(
      database.db,
    );
    const keys = Array.from({ length: TICKETS }, (_, i) => `BIG-${i + 1}`);

    const started = Date.now();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/bulk-operations',
      headers: { cookie },
      payload: { action: 'edit', tickets: keys, edit: { labels: ['bulk-10k'] } },
    });
    expect(created.statusCode, created.body).toBe(202);
    const id = created.json().bulkOperation.id as number;
    const authorizer = new Authorizer(database.db);
    const runner = new JobRunner(database.db, 'bulk-large');
    registerBulkJobs(runner, database.db, authorizer, new FieldCatalogs(database.db));
    while ((await runner.runOnce()) > 0) {}
    const elapsed = Date.now() - started;

    const op = (
      await app.inject({ method: 'GET', url: `/api/v1/bulk-operations/${id}`, headers: { cookie } })
    ).json().bulkOperation;
    const history = await sql<{ n: number }>`
      SELECT count(DISTINCT ticket_id)::int AS n FROM ticket_change
       WHERE field = 'labels' AND actor_id = ${userId}`.execute(database.db);
    const audited = await database.db
      .selectFrom('domain_event')
      .select('id')
      .where('type', '=', 'bulk_operation.created')
      .execute();
    const line = `bulk edit of ${TICKETS} tickets: ${(elapsed / 1000).toFixed(1)} s (${Math.round(
      TICKETS / (elapsed / 1000),
    )} tickets/s)`;
    process.stdout.write(`${line}\n`);
    if (process.env.TASKMOOR_LARGE_BULK_REPORT) {
      appendFileSync(process.env.TASKMOOR_LARGE_BULK_REPORT, `${line}\n`);
    }
    expect(op).toMatchObject({ status: 'done', total: TICKETS, succeeded: TICKETS, failed: 0 });
    expect(history.rows[0]?.n).toBe(TICKETS);
    expect(audited).toHaveLength(1);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  }, 600_000);
});
