import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { MIGRATION_TASK, registerWorkflowMigrationJobs } from './migration';

/**
 * The backlog's measure for workflow maps (M1-028): switching the workflow map of a
 * 100,000-ticket track, whose new workflow lacks the tickets' status, completes in under five
 * minutes, with a history row for every ticket moved. It writes 100,000 tickets, so it runs only
 * when asked:
 *
 *   TASKMOOR_LARGE_MIGRATION=1 pnpm verify --only=tests -- apps/server/src/workflows/migration.large.test.ts
 *
 * TASKMOOR_LARGE_MIGRATION_REPORT names a file the measurement is appended to.
 */
const TICKETS = 100_000;
const BUDGET_MS = 5 * 60_000;
/** Made per run: no password is written down. */
const PASSWORD = randomBytes(18).toString('base64url');

describe.skipIf(!process.env.TASKMOOR_LARGE_MIGRATION)(
  'a workflow map switch on a 100,000-ticket track (M1-028)',
  () => {
    const database = useMigratedDatabase();
    let app: FastifyInstance;
    let cookie = '';
    let userId = 0;
    const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
      app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

    beforeAll(async () => {
      app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
      const user = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: 'maps@example.com',
          name: 'Maps',
          password_hash: await hashPassword(PASSWORD),
          is_site_admin: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      userId = user.id;
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: 'maps@example.com', password: PASSWORD },
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

    it('[WF-001] moves 100,000 tickets to the new workflow in under five minutes, with history', async () => {
      const statuses = (await call('GET', '/api/v1/statuses')).json().statuses as {
        id: number;
        name: string;
      }[];
      const S = (name: string) => statuses.find((s) => s.name === name)?.id as number;
      const type = await database.db
        .selectFrom('ticket_type')
        .select('id')
        .where('name', '=', 'Bug')
        .executeTakeFirstOrThrow();
      const workflow = await call('POST', '/api/v1/workflows', {
        name: 'Bug flow',
        definition: {
          initialStatusId: S('Open'),
          statuses: [{ statusId: S('Open') }, { statusId: S('Active') }, { statusId: S('Closed') }],
          transitions: [
            { id: 1, name: 'Triage', from: [S('Open')], to: S('Active') },
            { id: 2, name: 'Fix', from: [S('Active')], to: S('Closed') },
          ],
        },
      });
      expect(workflow.statusCode, workflow.body).toBe(201);
      const map = await call('POST', '/api/v1/workflow-maps', {
        name: 'Bugs apart',
        defaultWorkflowId: workflow.json().workflow.id,
      });
      expect(map.statusCode, map.body).toBe(201);
      const track = await call('POST', '/api/v1/tracks', {
        key: 'BIG',
        name: 'Big',
        mode: 'shared',
      });
      expect(track.statusCode, track.body).toBe(201);
      const trackId = track.json().track.id as number;
      // 100,000 bugs In Review, a status the new workflow lacks.
      await sql`INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary,
            requester_id, creator_id, rank, status_id)
          SELECT 1, ${trackId}, g, ${type.id}, 'Bug ' || g, ${userId}, ${userId},
                 'zbig' || lpad(g::text, 7, '0'), ${S('In Review')}
            FROM generate_series(1, ${TICKETS}::int) g`.execute(database.db);
      await sql`INSERT INTO ticket_counter (track_id, workspace_id, last_number)
          VALUES (${trackId}, 1, ${TICKETS})`.execute(database.db);
      await sql`ANALYZE ticket`.execute(database.db);

      const started = Date.now();
      const switched = await call('PATCH', `/api/v1/tracks/${trackId}`, {
        workflowMapId: map.json().workflowMap.id,
        statusMapping: { [S('In Review')]: S('Active') },
      });
      const answered = Date.now() - started;
      expect(switched.statusCode, switched.body).toBe(200);
      const migrationId = switched.json().statusMigration.id as number;
      expect(switched.json().statusMigration).toMatchObject({ status: 'queued', total: TICKETS });
      const runner = new JobRunner(database.db, 'maps-large', { tasks: [MIGRATION_TASK] });
      registerWorkflowMigrationJobs(runner, database.db, new FieldCatalogs(database.db));
      while ((await runner.runOnce()) > 0) {}
      const elapsed = Date.now() - started;

      const progress = (await call('GET', `/api/v1/workflow-migrations/${migrationId}`)).json()
        .statusMigration;
      const left = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM ticket
         WHERE track_id = ${trackId} AND status_id = ${S('In Review')}`.execute(database.db);
      const history = await sql<{ n: number; tickets: number }>`
        SELECT count(*)::int AS n, count(DISTINCT ticket_id)::int AS tickets FROM ticket_change
         WHERE field = 'status' AND from_value = ${String(S('In Review'))}
           AND to_value = ${String(S('Active'))} AND actor_id = ${userId}`.execute(database.db);
      const audited = await database.db
        .selectFrom('domain_event')
        .select('payload')
        .where('type', '=', 'track.updated')
        .where('subject_id', '=', String(trackId))
        .execute();
      const line = `workflow map switch of ${TICKETS} tickets: ${(elapsed / 1000).toFixed(
        1,
      )} s (request ${(answered / 1000).toFixed(1)} s, ${Math.round(
        TICKETS / (elapsed / 1000),
      )} tickets/s)`;
      process.stdout.write(`${line}\n`);
      if (process.env.TASKMOOR_LARGE_MIGRATION_REPORT) {
        appendFileSync(process.env.TASKMOOR_LARGE_MIGRATION_REPORT, `${line}\n`);
      }
      expect(progress).toMatchObject({ status: 'done', total: TICKETS, migrated: TICKETS });
      expect(left.rows[0]?.n).toBe(0);
      expect(history.rows[0]).toEqual({ n: TICKETS, tickets: TICKETS });
      expect(audited).toHaveLength(1);
      expect(audited[0]?.payload).toMatchObject({
        statusMapped: TICKETS,
        statusMigrationId: migrationId,
      });
      expect(elapsed).toBeLessThan(BUDGET_MS);
    }, 900_000);
  },
);
