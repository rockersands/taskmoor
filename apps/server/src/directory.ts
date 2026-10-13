import type { Database } from '@taskmoor/db';
import { newToken, tokenHash } from '@taskmoor/iam';
import { type Kysely, sql, type Transaction } from 'kysely';

/** Users and groups of a workspace (IAM-008): the views the API returns and the queries M1-002 reuses. */

export interface UserView {
  id: number;
  email: string;
  name: string;
  isSiteAdmin: boolean;
  /** May sign in with a password where single sign-on is enforced (IAM-001). */
  breakGlass: boolean;
  timeZone: string | null;
  locale: string | null;
  active: boolean;
  hasPassword: boolean;
  createdAt: string;
  deactivatedAt: string | null;
  lastSignInAt: string | null;
}

export const USER_COLUMNS = [
  'id',
  'email',
  'name',
  'is_site_admin',
  'break_glass',
  'time_zone',
  'locale',
  'password_hash',
  'created_at',
  'deactivated_at',
  'last_sign_in_at',
] as const;

interface UserRow {
  id: number;
  email: string;
  name: string;
  is_site_admin: boolean;
  break_glass: boolean;
  time_zone: string | null;
  locale: string | null;
  password_hash: string | null;
  created_at: Date;
  deactivated_at: Date | null;
  last_sign_in_at: Date | null;
}

export function toUserView(row: UserRow): UserView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isSiteAdmin: row.is_site_admin,
    breakGlass: row.break_glass,
    timeZone: row.time_zone,
    locale: row.locale,
    active: row.deactivated_at === null,
    hasPassword: row.password_hash !== null,
    createdAt: row.created_at.toISOString(),
    deactivatedAt: row.deactivated_at?.toISOString() ?? null,
    lastSignInAt: row.last_sign_in_at?.toISOString() ?? null,
  };
}

type Db = Kysely<Database> | Transaction<Database>;

/** Groups a user belongs to directly or through nesting (a member of a child is in the parent). */
export async function effectiveGroupIds(
  db: Db,
  workspaceId: number,
  userId: number,
): Promise<number[]> {
  const { rows } = await sql<{ id: number }>`
    WITH RECURSIVE g(id) AS (
      SELECT group_id FROM group_member WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
      UNION
      SELECT n.parent_id FROM group_nesting n JOIN g ON n.child_id = g.id
       WHERE n.workspace_id = ${workspaceId}
    )
    SELECT id FROM g ORDER BY id`.execute(db);
  return rows.map((r) => r.id);
}

/** Users in a group directly or through any group nested inside it. */
export async function effectiveMemberIds(
  db: Db,
  workspaceId: number,
  groupId: number,
): Promise<number[]> {
  const { rows } = await sql<{ user_id: number }>`
    WITH RECURSIVE d(id) AS (
      SELECT ${groupId}::int
      UNION
      SELECT n.child_id FROM group_nesting n JOIN d ON n.parent_id = d.id
       WHERE n.workspace_id = ${workspaceId}
    )
    SELECT DISTINCT m.user_id FROM group_member m JOIN d ON m.group_id = d.id
     WHERE m.workspace_id = ${workspaceId}
     ORDER BY m.user_id`.execute(db);
  return rows.map((r) => r.user_id);
}

/** True when putting `childId` inside `parentId` would close a loop. */
export async function nestingWouldCycle(
  db: Db,
  workspaceId: number,
  parentId: number,
  childId: number,
): Promise<boolean> {
  if (parentId === childId) return true;
  const { rows } = await sql<{ found: number }>`
    WITH RECURSIVE d(id) AS (
      SELECT ${childId}::int
      UNION
      SELECT n.child_id FROM group_nesting n JOIN d ON n.parent_id = d.id
       WHERE n.workspace_id = ${workspaceId}
    )
    SELECT 1 AS found FROM d WHERE id = ${parentId} LIMIT 1`.execute(db);
  return rows.length > 0;
}

/** Active site administrators of the workspace; the last one cannot be demoted or deactivated. */
export async function activeAdminCount(db: Db, workspaceId: number): Promise<number> {
  const row = await db
    .selectFrom('app_user')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('workspace_id', '=', workspaceId)
    .where('is_site_admin', '=', true)
    .where('deactivated_at', 'is', null)
    .where('kind', '=', 'person')
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The spelling `Intl` uses for a time zone it accepts in any letter case ("europe/madrid"). */
export function canonicalTimeZone(zone: string): string {
  return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
}

export function validLocale(locale: string): boolean {
  try {
    return Intl.getCanonicalLocales(locale).length === 1;
  } catch {
    return false;
  }
}

/** One-time password links stay valid for three days. */
export const PASSWORD_LINK_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Makes a one-time link for a person to set a password (activation for a new account, reset
 * otherwise). Earlier unused links of the same person stop working. Returns the token, shown
 * once; the database keeps its hash.
 */
export async function createPasswordLink(
  db: Db,
  options: {
    workspaceId: number;
    userId: number;
    purpose: 'activate' | 'reset';
    createdBy: number | null;
    now?: Date;
  },
): Promise<{ token: string; expiresAt: Date }> {
  const now = options.now ?? new Date();
  const token = newToken();
  const expiresAt = new Date(now.getTime() + PASSWORD_LINK_TTL_MS);
  await db
    .deleteFrom('password_link')
    .where('workspace_id', '=', options.workspaceId)
    .where('user_id', '=', options.userId)
    .where('used_at', 'is', null)
    .execute();
  await db
    .insertInto('password_link')
    .values({
      workspace_id: options.workspaceId,
      user_id: options.userId,
      token_hash: tokenHash(token),
      purpose: options.purpose,
      created_by: options.createdBy,
      created_at: now,
      expires_at: expiresAt,
    })
    .execute();
  return { token, expiresAt };
}

/** The page that redeems a password link, under the instance's public URL. */
export function passwordLinkUrl(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/#/password?token=${encodeURIComponent(token)}`;
}
