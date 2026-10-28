import type { Database } from '@taskmoor/db';
import { sql, type Transaction } from 'kysely';
import { activeAdminCount } from '../directory';

/**
 * Deactivating and reactivating accounts for directories (M1-082), by the same rules as
 * SCIM (ADR-038) and user administration (IAM-008): deactivation keeps the account and its
 * work, ends its sessions and unused password links; break-glass accounts and the last active
 * site administrator are never deactivated by a directory, since they are how people get in
 * when the directory is wrong.
 */
export type Protected = 'break_glass' | 'last_admin';

export async function deactivateAccount(
  trx: Transaction<Database>,
  workspaceId: number,
  userId: number,
  now: Date,
): Promise<{ deactivated: boolean; endedSessions: number; refused: Protected | null }> {
  const row = await trx
    .selectFrom('app_user')
    .select(['deactivated_at', 'is_site_admin', 'break_glass'])
    .where('id', '=', userId)
    .where('workspace_id', '=', workspaceId)
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.deactivated_at !== null) {
    return { deactivated: false, endedSessions: 0, refused: null };
  }
  if (row.break_glass) return { deactivated: false, endedSessions: 0, refused: 'break_glass' };
  if (row.is_site_admin && (await activeAdminCount(trx, workspaceId)) <= 1) {
    return { deactivated: false, endedSessions: 0, refused: 'last_admin' };
  }
  await trx
    .updateTable('app_user')
    .set({ deactivated_at: now, updated_at: now })
    .where('id', '=', userId)
    .execute();
  return { deactivated: true, endedSessions: await endSessions(trx, userId), refused: null };
}

/** Ends a person's sessions and unused password links; returns how many sessions ended. */
export async function endSessions(trx: Transaction<Database>, userId: number): Promise<number> {
  const ended = await trx
    .deleteFrom('user_session')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  await trx
    .deleteFrom('password_link')
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .execute();
  return Number(ended.numDeletedRows);
}

export async function reactivateAccount(
  trx: Transaction<Database>,
  userId: number,
  now: Date,
): Promise<boolean> {
  const result = await trx
    .updateTable('app_user')
    .set({ deactivated_at: null, updated_at: now })
    .where('id', '=', userId)
    .where('deactivated_at', 'is not', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Takes the workspace's nesting lock, which group routes take too (no two changes build a loop). */
export async function lockNesting(trx: Transaction<Database>, workspaceId: number): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${workspaceId}, 1)`.execute(trx);
}
