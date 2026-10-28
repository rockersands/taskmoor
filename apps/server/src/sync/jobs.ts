import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import { enqueue, type JobRunner } from '../events/queue';
import { trimChangeLog } from './log';

/** The change log's retention (M1-031): once an hour per workspace, keyed by the hour. */
export const CHANGE_LOG_TRIM_TASK = 'change_log.trim';

export async function scheduleChangeLogTrim(
  db: Kysely<Database>,
  now = new Date(),
): Promise<number> {
  const workspaces = await db.selectFrom('workspace').select('id').execute();
  return enqueue(
    db,
    workspaces.map((w) => ({
      workspaceId: w.id,
      task: CHANGE_LOG_TRIM_TASK,
      key: `${CHANGE_LOG_TRIM_TASK}:${w.id}:${now.toISOString().slice(0, 13)}`,
      payload: {},
      maxAttempts: 3,
    })),
  );
}

export function registerChangeLogJobs(runner: JobRunner, db: Kysely<Database>): void {
  runner.handle(CHANGE_LOG_TRIM_TASK, async (job) => {
    await trimChangeLog(db, job.workspaceId);
  });
}
