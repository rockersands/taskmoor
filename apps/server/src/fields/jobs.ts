import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import { enqueue, type JobRunner } from '../events/queue';
import { FieldCatalogs } from './catalog';
import { analyzeFieldValues, verifyFieldValues } from './storage';

/**
 * The repair job of ADR-008 (M1-011): once a day each workspace's side rows are checked against
 * `ticket.fields` in batches and rewritten where they differ. Writes keep them in step, so a
 * mismatch means a bug or a hand-made change; the report names the tickets.
 */
export const FIELD_VALUES_TASK = 'field_values.verify';
/** One run stops after this long and the next goes on from where it stopped. */
const RUN_MS = 3 * 60 * 1000;

export interface FieldValuesRun {
  workspaceId: number;
  tickets: number;
  repaired: number[];
  more: boolean;
}

/** Checks (and repairs) from ticket `after` until the end or the deadline. */
export async function checkFieldValues(
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  workspaceId: number,
  options: { after?: number; repair: boolean; deadline?: number },
): Promise<FieldValuesRun & { next: number | null; mismatched: number[] }> {
  const catalog = await catalogs.get(workspaceId);
  let after = options.after ?? 0;
  let tickets = 0;
  const mismatched: number[] = [];
  for (;;) {
    const report = await verifyFieldValues(db, catalog, workspaceId, {
      after,
      repair: options.repair,
    });
    tickets += report.tickets;
    mismatched.push(...report.mismatched);
    if (report.next === null) {
      if (options.repair && mismatched.length > 0) await analyzeFieldValues(db);
      return {
        workspaceId,
        tickets,
        mismatched,
        repaired: options.repair ? mismatched : [],
        more: false,
        next: null,
      };
    }
    after = report.next;
    if (options.deadline !== undefined && Date.now() > options.deadline) {
      return {
        workspaceId,
        tickets,
        mismatched,
        repaired: options.repair ? mismatched : [],
        more: true,
        next: after,
      };
    }
  }
}

export async function scheduleFieldValueCheck(
  db: Kysely<Database>,
  now = new Date(),
): Promise<number> {
  const workspaces = await db.selectFrom('workspace').select('id').execute();
  return enqueue(
    db,
    workspaces.map((w) => ({
      workspaceId: w.id,
      task: FIELD_VALUES_TASK,
      key: `${FIELD_VALUES_TASK}:${w.id}:${now.toISOString().slice(0, 10)}`,
      payload: { after: 0 },
      maxAttempts: 3,
    })),
  );
}

export function registerFieldValueJobs(
  runner: JobRunner,
  db: Kysely<Database>,
  onRepaired: (run: FieldValuesRun) => void = () => {},
): void {
  const catalogs = new FieldCatalogs(db);
  runner.handle(FIELD_VALUES_TASK, async (job) => {
    const after = Number((job.payload as { after?: number } | null)?.after ?? 0);
    const run = await checkFieldValues(db, catalogs, job.workspaceId, {
      after,
      repair: true,
      deadline: Date.now() + RUN_MS,
    });
    if (run.repaired.length > 0) onRepaired(run);
    if (run.more) {
      await enqueue(db, [
        {
          workspaceId: job.workspaceId,
          task: FIELD_VALUES_TASK,
          key: `${FIELD_VALUES_TASK}:after:${job.id}`,
          payload: { after: run.next },
          maxAttempts: 3,
        },
      ]);
    }
  });
}
