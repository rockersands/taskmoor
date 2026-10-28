import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { requireSiteAdmin } from '../auth';
import {
  type BackupSchedule,
  backupSchedule,
  backupScheduleShape,
  backupStatus,
  recentRuns,
  setBackupSchedule,
} from '../backups/schedule';
import { diff, withEvent } from '../events/bus';

/**
 * Scheduled backups for site administrators (M1-101, OPS-008):
 *
 * - `GET /api/v1/admin/backups`: the schedule, the next run, the last success, failure and
 *   restore drill, how many scheduled backups are kept, and the recent runs.
 * - `PUT /api/v1/admin/backups/schedule`: on or off, the time of day (UTC), how many to keep,
 *   and the weekly verification. Where backups go is the operator's choice
 *   (`TASKMOOR_BACKUP_DIR`), never the API's.
 */
const scheduleBody = backupScheduleShape.partial().strict();

export function registerBackupRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  app.get('/api/v1/admin/backups', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const [status, recent] = await Promise.all([backupStatus(db), recentRuns(db)]);
    return { ...status, recent };
  });

  app.put('/api/v1/admin/backups/schedule', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = scheduleBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const asked: Partial<BackupSchedule> = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined),
    );
    const schedule = await withEvent(
      db,
      { workspaceId: request.workspaceId, actorId: admin.id },
      async (trx) => {
        const before = await backupSchedule(trx);
        const next: BackupSchedule = { ...before, ...asked };
        const changes = diff({ ...before }, asked);
        if (Object.keys(changes).length === 0) return { result: before, event: null };
        await setBackupSchedule(trx, next);
        return {
          result: next,
          event: {
            type: 'backup_schedule.updated',
            subjectId: request.workspaceId,
            payload: { changes },
          },
        };
      },
    );
    return { schedule };
  });
}
