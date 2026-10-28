import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import { enqueue, type JobRunner } from '../events/queue';
import { FieldCatalogs } from './catalog';
import {
  FORMULA_RECOMPUTE_TASK,
  FORMULA_REFRESH_TASK,
  formulaPlan,
  recomputeQueued,
  refreshBatch,
  workspacesWithFormulas,
} from './formulas';

/**
 * The worker's side of formula fields (M1-013; ADR-009 "Implementation (M1-013)"):
 *
 * - `formula.recompute` recomputes tickets a write could not take (their row was held) and
 *   climbs to their parents;
 * - `formula.refresh` walks the workspace's tickets in batches and recomputes every formula,
 *   after a formula or what it reads changed, and once a day for formulas that read today's
 *   date. A run stops after a while and queues the next from where it stopped.
 */
const RUN_MS = 60_000;

export async function runRefresh(
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  workspaceId: number,
  options: { after: number; trackIds?: readonly number[]; deadline?: number; now?: Date },
): Promise<{ next: number | null; changed: number }> {
  let after = options.after;
  let changed = 0;
  for (;;) {
    // The catalogue may move while a long walk runs: each batch reads the current one.
    const catalog = await catalogs.get(workspaceId);
    const step = await refreshBatch(db, catalog, workspaceId, {
      after,
      ...(options.trackIds ? { trackIds: options.trackIds } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    changed += step.changed;
    if (step.next === null) return { next: null, changed };
    after = step.next;
    if (options.deadline !== undefined && Date.now() > options.deadline) {
      return { next: after, changed };
    }
  }
}

/**
 * Queues the daily refresh of workspaces whose formulas read today's date, once per day (keyed
 * by the date). Runs with the worker's housekeeping every few minutes; the first after midnight
 * UTC queues it.
 */
export async function scheduleFormulaRefresh(
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  now = new Date(),
): Promise<number> {
  const jobs = [];
  for (const workspaceId of await workspacesWithFormulas(db)) {
    if (formulaPlan(await catalogs.get(workspaceId)).volatile.size === 0) continue;
    jobs.push({
      workspaceId,
      task: FORMULA_REFRESH_TASK,
      key: `${FORMULA_REFRESH_TASK}:daily:${workspaceId}:${now.toISOString().slice(0, 10)}`,
      payload: { after: 0, reason: 'daily' },
      maxAttempts: 5,
    });
  }
  return enqueue(db, jobs);
}

export function registerFormulaJobs(runner: JobRunner, db: Kysely<Database>): void {
  const catalogs = new FieldCatalogs(db);
  runner.handle(FORMULA_RECOMPUTE_TASK, async (job) => {
    const ids = (job.payload as { ticketIds?: unknown } | null)?.ticketIds;
    const ticketIds = Array.isArray(ids)
      ? ids.filter((id): id is number => Number.isInteger(id))
      : [];
    await recomputeQueued(db, await catalogs.get(job.workspaceId), job.workspaceId, ticketIds);
  });
  runner.handle(FORMULA_REFRESH_TASK, async (job) => {
    const payload = (job.payload ?? {}) as { after?: number; trackIds?: number[]; reason?: string };
    const run = await runRefresh(db, catalogs, job.workspaceId, {
      after: Number(payload.after ?? 0),
      ...(Array.isArray(payload.trackIds) ? { trackIds: payload.trackIds } : {}),
      deadline: Date.now() + RUN_MS,
    });
    if (run.next !== null) {
      await enqueue(db, [
        {
          workspaceId: job.workspaceId,
          task: FORMULA_REFRESH_TASK,
          key: `${FORMULA_REFRESH_TASK}:after:${job.id}`,
          payload: { ...payload, after: run.next },
          maxAttempts: 5,
        },
      ]);
    }
  });
}
