import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';
import {
  DEFAULT_TRASH_RETENTION_DAYS,
  MAX_TRASH_RETENTION_DAYS,
  MIN_TRASH_RETENTION_DAYS,
} from '../tickets/model';

/**
 * The workspace's trash retention (M1-101, CORE-025 (3)): how many days a deleted ticket or
 * track stays restorable before the purge removes it for good. Site administrators set it
 * between 1 and 365 days; a workspace without a row keeps the default of 30.
 */
type Db = Kysely<Database> | Transaction<Database>;

export const TRASH_RETENTION_LIMITS = {
  min: MIN_TRASH_RETENTION_DAYS,
  max: MAX_TRASH_RETENTION_DAYS,
  default: DEFAULT_TRASH_RETENTION_DAYS,
} as const;

export async function trashRetentionDays(db: Db, workspaceId: number): Promise<number> {
  const row = await db
    .selectFrom('trash_policy')
    .select('retention_days')
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  return row?.retention_days ?? DEFAULT_TRASH_RETENTION_DAYS;
}

export async function setTrashRetentionDays(
  trx: Transaction<Database>,
  workspaceId: number,
  days: number,
): Promise<void> {
  await trx
    .insertInto('trash_policy')
    .values({ workspace_id: workspaceId, retention_days: days, updated_at: new Date() })
    .onConflict((oc) =>
      oc.column('workspace_id').doUpdateSet({ retention_days: days, updated_at: new Date() }),
    )
    .execute();
}

/** The moment before which deletions have outlived the retention. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 86_400_000);
}

/** Whether a track is in the trash, for routes that must not touch one. */
export async function trackInTrash(db: Db, trackId: number): Promise<boolean> {
  const row = await db
    .selectFrom('track')
    .select('deleted_at')
    .where('id', '=', trackId)
    .executeTakeFirst();
  return Boolean(row?.deleted_at);
}
