import type { Database } from '@taskmoor/db';
import { sql, type Transaction } from 'kysely';
import { dropLapsedCreateTracks, type LapsedCreateTracks } from '../authz/create-tracks';
import { activeAdminCount } from '../directory';

/**
 * Deactivating and reactivating accounts for directories (M1-082), by the same rules as
 * SCIM (ADR-038) and user administration (IAM-008): deactivation keeps the account and its
 * work, ends its sessions and unused password links; break-glass accounts and the last active
 * site administrator are never deactivated by a directory, since they are how people get in
 * when the directory is wrong.
 *
 * Like every deactivation, it keeps the person's roles and the permission to create tracks that
 * came with them (T-259; IAM-033, ADR-118), unusable while deactivated and theirs again on
 * reactivation; it takes only one whose roles are already gone (T-087b): `lapsed`, for the
 * caller's event.
 */
export type Protected = 'break_glass' | 'last_admin';

export interface Deactivation {
  deactivated: boolean;
  endedSessions: number;
  refused: Protected | null;
  lapsed: LapsedCreateTracks[];
}

export async function deactivateAccount(
  trx: Transaction<Database>,
  workspaceId: number,
  userId: number,
  now: Date,
): Promise<Deactivation> {
  const row = await trx
    .selectFrom('app_user')
    .select(['deactivated_at', 'is_site_admin', 'break_glass'])
    .where('id', '=', userId)
    .where('workspace_id', '=', workspaceId)
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.deactivated_at !== null) {
    return { deactivated: false, endedSessions: 0, refused: null, lapsed: [] };
  }
  if (row.break_glass) {
    return { deactivated: false, endedSessions: 0, refused: 'break_glass', lapsed: [] };
  }
  if (row.is_site_admin && (await activeAdminCount(trx, workspaceId)) <= 1) {
    return { deactivated: false, endedSessions: 0, refused: 'last_admin', lapsed: [] };
  }
  await trx
    .updateTable('app_user')
    .set({ deactivated_at: now, updated_at: now })
    .where('id', '=', userId)
    .execute();
  const endedSessions = await endSessions(trx, userId);
  const lapsed = await dropLapsedCreateTracks(trx, workspaceId, [userId]);
  return { deactivated: true, endedSessions, refused: null, lapsed };
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
