import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import type { Authorizer } from '../authz/authorizer';
import { enqueue, extendLock, type JobRunner } from '../events/queue';
import type { FieldCatalogs } from '../fields/catalog';
import { ticketRoutes } from '../routes/tickets';
import { runBulkOperation } from './run';

/** The task that runs a bulk operation, a part at a time (M1-021). */
export const BULK_TASK = 'bulk.run';

/** How long one part runs before it hands over to the next. */
const PART_MS = 50_000;

export const bulkJob = (workspaceId: number, operationId: string, part = 0) => ({
  workspaceId,
  task: BULK_TASK,
  payload: { operationId, part },
  key: `bulk:${operationId}:${part}`,
});

export function registerBulkJobs(
  runner: JobRunner,
  db: Kysely<Database>,
  authorizer: Authorizer,
  catalogs: FieldCatalogs,
  options: { partMs?: number; concurrency?: number } = {},
): void {
  const routes = ticketRoutes(db, authorizer, catalogs);
  runner.handle(BULK_TASK, async (job) => {
    const { operationId, part } = job.payload as { operationId: string; part: number };
    // A part runs for most of a minute: keep its lock, so no second worker takes it meanwhile.
    const keep = setInterval(() => void extendLock(db, job.id).catch(() => {}), 15_000);
    try {
      const state = await runBulkOperation({ db, authorizer, routes }, operationId, {
        until: Date.now() + (options.partMs ?? PART_MS),
        ...(options.concurrency ? { concurrency: options.concurrency } : {}),
      });
      if (state === 'more') await enqueue(db, [bulkJob(job.workspaceId, operationId, part + 1)]);
    } finally {
      clearInterval(keep);
    }
  });
}
