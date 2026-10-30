import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import type { AttachmentStores } from '../attachments/stores';
import { enqueue, extendLock, type JobRunner } from '../events/queue';
import type { FieldCatalogs } from '../fields/catalog';
import { csvFormat } from './csv';
import { dcBackupFormat } from './dc';
import type { ImportFormat } from './model';
import { finishRun, runImport } from './run';
import { syntheticFormat } from './synthetic';
import { exportFormat } from './taskmoor';

/** The task that runs an import, a part at a time (M1-086). */
export const IMPORT_TASK = 'import.run';

/** How long one part runs before it hands over to the next. */
const PART_MS = 50_000;
/** Attempts before a run that keeps failing is given up as failed. */
const MAX_ATTEMPTS = 10;

/** The source formats the server knows; later importers add theirs here. */
export const IMPORT_FORMATS: Readonly<Record<string, ImportFormat>> = {
  [syntheticFormat.importSource]: syntheticFormat,
  [csvFormat.importSource]: csvFormat,
  [exportFormat.importSource]: exportFormat,
  [dcBackupFormat.importSource]: dcBackupFormat,
};

export const importJob = (workspaceId: number, runId: string, part = 0) => ({
  workspaceId,
  task: IMPORT_TASK,
  payload: { runId, part },
  key: `import:${runId}:${part}`,
  maxAttempts: MAX_ATTEMPTS,
});

export function registerImportJobs(
  runner: JobRunner,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  options: {
    partMs?: number;
    batch?: number;
    formats?: Readonly<Record<string, ImportFormat>>;
    /** Where imported attachments go. */
    stores?: AttachmentStores | null;
  } = {},
): void {
  const deps = {
    db,
    catalogs,
    formats: options.formats ?? IMPORT_FORMATS,
    stores: options.stores ?? null,
  };
  runner.handle(IMPORT_TASK, async (job) => {
    const { runId, part } = job.payload as { runId: string; part: number };
    // A part runs for most of a minute: keep its lock, so no second worker takes it meanwhile.
    const keep = setInterval(() => void extendLock(db, job.id).catch(() => {}), 15_000);
    try {
      const state = await runImport(deps, runId, {
        until: Date.now() + (options.partMs ?? PART_MS),
        ...(options.batch ? { batch: options.batch } : {}),
      });
      if (state === 'more') await enqueue(db, [importJob(job.workspaceId, runId, part + 1)]);
    } catch (error) {
      // The batch rolled back; the retry resumes from the checkpoint. The error is kept on the
      // run, and a run that fails every attempt ends as failed with its report so far.
      const message = error instanceof Error ? error.message.slice(0, 500) : 'failed';
      await db
        .updateTable('import_run')
        .set({ last_error: message, updated_at: new Date() })
        .where('id', '=', runId)
        .execute();
      if (job.attempts >= job.maxAttempts) {
        await finishRun(db, runId, 'failed', message);
        return;
      }
      throw error;
    } finally {
      clearInterval(keep);
    }
  });
}
