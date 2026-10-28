import type { Database } from '@taskmoor/db';
import type { StorageKind } from '@taskmoor/storage';
import { type Kysely, sql, type Transaction } from 'kysely';
import { enqueue } from '../events/queue';
import type { AttachmentStores } from './stores';

/**
 * Deleting stored files after the database lets go of them (ADR-040).
 *
 * `storage_cleanup` lists objects to delete: the keys of attachment rows that went (a trigger
 * adds them in the deleting transaction, whoever deleted: a person, the purge of a ticket or a
 * track) and the keys of uploads in progress (added before the first byte is written, taken
 * out in the transaction that creates the attachment). The sweep deletes each due object and
 * then its row, holding the row's lock meanwhile: an upload that outlived its day finds its
 * row gone and fails rather than keep a file the sweep deletes. Deleting an object twice is
 * harmless, so a sweep that dies half way simply runs again; a store that is down keeps its
 * rows for the next run, with backoff.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** How long an upload may take before its object counts as abandoned. */
export const UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;
export const SWEEP_TASK = 'storage.sweep';

/** Registers an upload before its first byte is written (committed on its own). */
export async function registerUpload(
  db: Db,
  workspaceId: number,
  storage: StorageKind,
  key: string,
): Promise<void> {
  await db
    .insertInto('storage_cleanup')
    .values({
      workspace_id: workspaceId,
      storage,
      storage_key: key,
      reason: 'upload',
      not_before: new Date(Date.now() + UPLOAD_GRACE_MS),
    })
    .execute();
}

/**
 * Takes an upload's key out of the cleanup in the transaction that keeps its file. False when
 * the sweep got there first (the upload took longer than its grace): the file is gone.
 */
export async function keepUpload(
  trx: Transaction<Database>,
  storage: StorageKind,
  key: string,
): Promise<boolean> {
  const row = await trx
    .deleteFrom('storage_cleanup')
    .where('storage', '=', storage)
    .where('storage_key', '=', key)
    .where('reason', '=', 'upload')
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

/** An upload that will not be kept: its object goes now (or at the next sweep). */
export async function dropUpload(
  db: Kysely<Database>,
  stores: AttachmentStores,
  storage: StorageKind,
  key: string,
): Promise<void> {
  await db
    .updateTable('storage_cleanup')
    .set({ not_before: new Date(), reason: 'deleted' })
    .where('storage', '=', storage)
    .where('storage_key', '=', key)
    .execute();
  await sweepStorage(db, stores, { keys: [{ storage, key }] }).catch(() => undefined);
}

export interface SweepReport {
  deleted: number;
  failed: number;
  /** Rows of a store this process does not have; another process (or a later one) takes them. */
  skipped: number;
}

/**
 * Deletes due objects and their rows, one row per transaction. `keys` limits it to those (a
 * person's deletion, cleaned up at once); otherwise up to `limit` due rows go.
 */
export async function sweepStorage(
  db: Kysely<Database>,
  stores: AttachmentStores,
  options: { keys?: { storage: StorageKind; key: string }[]; limit?: number; now?: Date } = {},
): Promise<SweepReport> {
  const report: SweepReport = { deleted: 0, failed: 0, skipped: 0 };
  const now = options.now ?? new Date();
  let query = db
    .selectFrom('storage_cleanup')
    .select(['id', 'storage'])
    .where('not_before', '<=', now)
    .orderBy('not_before')
    .orderBy('id')
    .limit(options.limit ?? 500);
  if (options.keys) {
    if (options.keys.length === 0) return report;
    query = query.where((eb) =>
      eb.or(
        options.keys?.map((k) =>
          eb.and([eb('storage', '=', k.storage), eb('storage_key', '=', k.key)]),
        ) ?? [],
      ),
    );
  }
  const due = await query.execute();
  for (const candidate of due) {
    const store = stores.stores[candidate.storage];
    if (!store) {
      report.skipped += 1;
      continue;
    }
    try {
      const done = await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('storage_cleanup')
          .select(['id', 'storage_key'])
          .where('id', '=', candidate.id)
          .where('not_before', '<=', now)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!row) return false;
        await store.delete(row.storage_key);
        await trx.deleteFrom('storage_cleanup').where('id', '=', row.id).execute();
        return true;
      });
      if (done) report.deleted += 1;
    } catch (error) {
      report.failed += 1;
      // Backoff: an hour times the attempts so far, at most a day.
      await db
        .updateTable('storage_cleanup')
        .set((eb) => ({
          attempts: eb('attempts', '+', 1),
          last_error: String((error as Error).message ?? error).slice(0, 2000),
          not_before: sql<Date>`now() + least(interval '1 day', interval '1 hour' * (attempts + 1))`,
        }))
        .where('id', '=', candidate.id)
        .execute();
    }
  }
  return report;
}

/** Queues a sweep for the worker (after a purge); several in a row are harmless. */
export async function queueSweep(trx: Db, workspaceId: number): Promise<void> {
  await enqueue(trx, [{ workspaceId, task: SWEEP_TASK, maxAttempts: 5 }]);
}

/** The hourly sweep, once per hour across workers. */
export async function scheduleSweep(
  db: Kysely<Database>,
  workspaceId: number,
  now = new Date(),
): Promise<boolean> {
  const added = await enqueue(db, [
    {
      workspaceId,
      task: SWEEP_TASK,
      key: `${SWEEP_TASK}:${now.toISOString().slice(0, 13)}`,
      maxAttempts: 3,
    },
  ]);
  return added > 0;
}
