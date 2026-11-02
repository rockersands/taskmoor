import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';

/**
 * Storage quotas for attachments (M1-118; CORE-021; ASVS 12.1.3; ADR-110): a workspace total and
 * a limit per person, in bytes, set by a site administrator beside the maximum file size. Both
 * are off by default (CORE-021 keeps storage uncapped unless an administrator asks).
 *
 * - Usage is the size of the attachment files a workspace holds, and of those a person
 *   uploaded (thumbnails aside); a ticket in the trash keeps its files counted until it is
 *   purged. Imports count toward usage but are not refused: an import is a site
 *   administrator's own act.
 * - An upload is refused with 413 `storage_quota_exceeded` when it would take usage past a
 *   quota: at once when the person or workspace is already full, or when Content-Length says
 *   so, else as the stream passes the room left. The answer names the quota, the limit, the
 *   usage and the room left, in bytes.
 * - Two uploads at once cannot both take the last room: the insert re-checks under a lock per
 *   person and one per workspace, held to the end of its transaction.
 * - A lowered quota leaves what is stored and refuses further uploads.
 */
type Db = Kysely<Database> | Transaction<Database>;

export interface StorageQuota {
  workspace: number | null;
  person: number | null;
}

export interface StorageUsage {
  bytes: number;
  files: number;
}

export type QuotaScope = 'workspace' | 'person';

export interface QuotaRefusal {
  error: 'storage_quota_exceeded';
  quota: QuotaScope;
  limit: number;
  used: number;
  /** What is left before the quota; the file was larger. */
  available: number;
}

export async function storageQuota(db: Db, workspaceId: number): Promise<StorageQuota> {
  const row = await db
    .selectFrom('attachment_setting')
    .select(['workspace_quota', 'person_quota'])
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  return {
    workspace: row?.workspace_quota == null ? null : Number(row.workspace_quota),
    person: row?.person_quota == null ? null : Number(row.person_quota),
  };
}

/** What a workspace holds, or (with `authorId`) what one person uploaded there. */
export async function storageUsage(
  db: Db,
  workspaceId: number,
  authorId?: number,
): Promise<StorageUsage> {
  let query = db
    .selectFrom('attachment')
    .select([sql<string>`coalesce(sum(size), 0)`.as('bytes'), sql<string>`count(*)`.as('files')])
    .where('workspace_id', '=', workspaceId);
  if (authorId !== undefined) query = query.where('author_id', '=', authorId);
  const row = await query.executeTakeFirstOrThrow();
  return { bytes: Number(row.bytes), files: Number(row.files) };
}

/** The person who uses most, for the usage page. */
export async function topUploader(
  db: Db,
  workspaceId: number,
): Promise<{ id: number; name: string; bytes: number; files: number } | null> {
  const row = await db
    .selectFrom('attachment as a')
    .innerJoin('app_user as u', 'u.id', 'a.author_id')
    .select([
      'u.id',
      'u.name',
      sql<string>`sum(a.size)`.as('bytes'),
      sql<string>`count(*)`.as('files'),
    ])
    .where('a.workspace_id', '=', workspaceId)
    .groupBy(['u.id', 'u.name'])
    .orderBy(sql`sum(a.size)`, 'desc')
    .orderBy('u.id')
    .limit(1)
    .executeTakeFirst();
  return row
    ? { id: row.id, name: row.name, bytes: Number(row.bytes), files: Number(row.files) }
    : null;
}

/**
 * The room a person has left before the tighter quota, and which quota that is; null when no
 * quota is set.
 */
export async function quotaRoom(
  db: Db,
  workspaceId: number,
  authorId: number,
  quota: StorageQuota,
): Promise<{ quota: QuotaScope; limit: number; used: number; available: number } | null> {
  const rooms: { quota: QuotaScope; limit: number; used: number; available: number }[] = [];
  if (quota.person !== null) {
    const used = (await storageUsage(db, workspaceId, authorId)).bytes;
    rooms.push({
      quota: 'person',
      limit: quota.person,
      used,
      available: Math.max(0, quota.person - used),
    });
  }
  if (quota.workspace !== null) {
    const used = (await storageUsage(db, workspaceId)).bytes;
    rooms.push({
      quota: 'workspace',
      limit: quota.workspace,
      used,
      available: Math.max(0, quota.workspace - used),
    });
  }
  if (rooms.length === 0) return null;
  return rooms.reduce((a, b) => (b.available < a.available ? b : a));
}

export function quotaRefusal(room: {
  quota: QuotaScope;
  limit: number;
  used: number;
  available: number;
}): QuotaRefusal {
  return { error: 'storage_quota_exceeded', ...room };
}

/**
 * Inside the insert's transaction: locks the person's and the workspace's quota and refuses a
 * file of `size` that no longer fits (another upload took the room meanwhile).
 */
export async function holdQuota(
  trx: Transaction<Database>,
  workspaceId: number,
  authorId: number,
  size: number,
  quota: StorageQuota,
): Promise<QuotaRefusal | null> {
  if (quota.person === null && quota.workspace === null) return null;
  if (quota.person !== null) {
    await sql`SELECT pg_advisory_xact_lock(hashtext('storage-quota'), ${authorId})`.execute(trx);
  }
  if (quota.workspace !== null) {
    await sql`SELECT pg_advisory_xact_lock(hashtext('storage-quota-workspace'), ${workspaceId})`.execute(
      trx,
    );
  }
  const room = await quotaRoom(trx, workspaceId, authorId, quota);
  return room && size > room.available ? quotaRefusal(room) : null;
}

export async function setStorageQuota(
  trx: Transaction<Database>,
  workspaceId: number,
  quota: StorageQuota,
): Promise<void> {
  await trx
    .insertInto('attachment_setting')
    .values({
      workspace_id: workspaceId,
      workspace_quota: quota.workspace,
      person_quota: quota.person,
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column('workspace_id').doUpdateSet({
        workspace_quota: quota.workspace,
        person_quota: quota.person,
        updated_at: new Date(),
      }),
    )
    .execute();
}
