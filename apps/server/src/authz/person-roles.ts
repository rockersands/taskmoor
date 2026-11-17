import type { Database } from '@taskmoor/db';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import type { GlobalPermission } from './permissions';

type Db = Kysely<Database> | Transaction<Database>;

/**
 * What Administration > People says about each person (T-331; IAM-008, IAM-009): the
 * administrator roles they hold (site, configuration, automation, AI and extensions), how many
 * tracks they run (IAM-028, ADR-121), and "Member" when neither. Everything here reads a whole
 * page of people in a constant number of statements, whatever its length.
 *
 * A role is held when something gives it: for the site administrator the account's own flag,
 * and for every role a global grant to the person, to a group they are in (directly or through
 * nested groups, a directory's groups included), or to everyone signed in. That is what the
 * authorizer reads (`globalPermissions`), with one difference: a site administrator also holds
 * every other role without a grant, and this lists only the roles that something gives, so a
 * row says "Site administrator" and not five roles. Roles are read for deactivated people too:
 * deactivation keeps them, and they come back with the person.
 *
 * An erased person (ADR-111) holds no role and runs no track, whatever rows erasure left behind
 * (their group memberships, grants and track roles stay, as do the tracks they owned): the same
 * as `runningNoTrack`, which counts them out. So their row carries no role, and every role
 * filter, Member included, leaves them out: an erased person is a placeholder, not a member.
 *
 * The roles are `ADMIN_GLOBAL_PERMISSIONS`, in the same order (a test holds them equal).
 *
 * Running a track is holding `administer_track` on a track not in the trash: through a role
 * there (directly or through a group), a grant to the person or a group of theirs, to everyone,
 * or as the track's owner. The same ways `runningNoTrack` and `trackKeepsAdministrator` count.
 */
export const ADMIN_ROLES = [
  'site_admin',
  'configuration_admin',
  'automation_admin',
  'ai_admin',
  'extension_admin',
] as const satisfies readonly GlobalPermission[];
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** What the People page's role filter offers: a role, running tracks, or none of these. */
export const ROLE_FILTERS = [...ADMIN_ROLES, 'runs_tracks', 'member'] as const;
export type RoleFilter = AdminRole | 'runs_tracks' | 'member';

/** Where a role comes from, for the person's page. */
export type RoleSource =
  | { kind: 'account' }
  | { kind: 'user' }
  | { kind: 'group'; group: { id: number; name: string } }
  | { kind: 'everyone' };

export interface HeldRole {
  role: AdminRole;
  sources: RoleSource[];
}

const ROLE_LIST = () => sql.join(ADMIN_ROLES.map((r) => sql`${r}`));
const ID_LIST = (ids: readonly number[]) => sql.join(ids.map((id) => sql`${id}::int`));

/** These of the people who are not erased, as a subquery of ids: the erased hold nothing. */
const LIVE_IDS = (workspaceId: number, ids: readonly number[]) => sql`
  SELECT p.id FROM app_user p
   WHERE p.workspace_id = ${workspaceId} AND p.erased_at IS NULL AND p.id IN (${ID_LIST(ids)})`;

/** Each of these people's groups, direct or through nesting: `mine(user_id, group_id)`. */
const MINE = (workspaceId: number, ids: readonly number[]) => sql`
  mine(user_id, group_id) AS (
    SELECT m.user_id, m.group_id FROM group_member m
     WHERE m.workspace_id = ${workspaceId} AND m.user_id IN (${LIVE_IDS(workspaceId, ids)})
    UNION
    SELECT mine.user_id, n.parent_id FROM group_nesting n JOIN mine ON n.child_id = mine.group_id
     WHERE n.workspace_id = ${workspaceId}
  )`;

/**
 * Every administrator role these people hold, with where each comes from, in one statement.
 * A person with none has no entry.
 */
export async function rolesOf(
  db: Db,
  workspaceId: number,
  ids: readonly number[],
): Promise<Map<number, HeldRole[]>> {
  const held = new Map<number, HeldRole[]>();
  if (ids.length === 0) return held;
  const { rows } = await sql<{
    user_id: number;
    permission: string;
    kind: RoleSource['kind'];
    group_id: number | null;
    group_name: string | null;
  }>`
    WITH RECURSIVE ${MINE(workspaceId, ids)}
    SELECT u.id AS user_id, 'site_admin' AS permission, 'account' AS kind,
           NULL::int AS group_id, NULL::text AS group_name
      FROM app_user u
     WHERE u.workspace_id = ${workspaceId} AND u.id IN (${ID_LIST(ids)}) AND u.is_site_admin
       AND u.erased_at IS NULL
    UNION
    SELECT g.user_id, g.permission, 'user', NULL::int, NULL::text
      FROM global_grant g
     WHERE g.workspace_id = ${workspaceId} AND g.grantee = 'user'
       AND g.user_id IN (${LIVE_IDS(workspaceId, ids)}) AND g.permission IN (${ROLE_LIST()})
    UNION
    SELECT mine.user_id, g.permission, 'group', ug.id, ug.name
      FROM global_grant g
      JOIN mine ON mine.group_id = g.group_id
      JOIN user_group ug ON ug.id = g.group_id
     WHERE g.workspace_id = ${workspaceId} AND g.grantee = 'group'
       AND g.permission IN (${ROLE_LIST()})
    UNION
    SELECT u.id, g.permission, 'everyone', NULL::int, NULL::text
      FROM global_grant g
      JOIN app_user u ON u.workspace_id = g.workspace_id
     WHERE g.workspace_id = ${workspaceId} AND g.grantee = 'any_user'
       AND u.id IN (${ID_LIST(ids)}) AND u.erased_at IS NULL
       AND g.permission IN (${ROLE_LIST()})`.execute(db);
  const order = (s: RoleSource) => ['account', 'user', 'group', 'everyone'].indexOf(s.kind);
  for (const row of rows) {
    const role = row.permission as AdminRole;
    const roles = held.get(row.user_id) ?? [];
    let entry = roles.find((r) => r.role === role);
    if (!entry) {
      entry = { role, sources: [] };
      roles.push(entry);
      held.set(row.user_id, roles);
    }
    entry.sources.push(
      row.kind === 'group'
        ? { kind: 'group', group: { id: row.group_id as number, name: row.group_name ?? '' } }
        : ({ kind: row.kind } as RoleSource),
    );
  }
  for (const roles of held.values()) {
    roles.sort((a, b) => ADMIN_ROLES.indexOf(a.role) - ADMIN_ROLES.indexOf(b.role));
    for (const r of roles) {
      r.sources.sort(
        (a, b) =>
          order(a) - order(b) ||
          (a.kind === 'group' && b.kind === 'group'
            ? a.group.name.localeCompare(b.group.name) || a.group.id - b.group.id
            : 0),
      );
    }
  }
  return held;
}

/**
 * The (person, track) pairs of these people and the live tracks they run, as a statement's
 * body after `WITH RECURSIVE mine …`: `runs(user_id, track_id)`.
 */
const RUNS = (workspaceId: number, ids: readonly number[]) => sql`
  admin_grants AS (
    SELECT g.policy_id, g.grantee, g.role_id, g.group_id, g.user_id
      FROM access_grant g
     WHERE g.workspace_id = ${workspaceId} AND g.permission = 'administer_track'
  ),
  live AS (
    SELECT t.id, t.owner_id, t.access_policy_id FROM track t
     WHERE t.workspace_id = ${workspaceId} AND t.deleted_at IS NULL
  ),
  runs(user_id, track_id) AS (
    SELECT a.user_id, a.track_id
      FROM track_role_actor a
      JOIN live t ON t.id = a.track_id
      JOIN admin_grants p ON p.policy_id = t.access_policy_id AND p.grantee = 'role'
                         AND p.role_id = a.role_id
     WHERE a.user_id IN (${LIVE_IDS(workspaceId, ids)})
    UNION
    SELECT mine.user_id, a.track_id
      FROM track_role_actor a
      JOIN mine ON mine.group_id = a.group_id
      JOIN live t ON t.id = a.track_id
      JOIN admin_grants p ON p.policy_id = t.access_policy_id AND p.grantee = 'role'
                         AND p.role_id = a.role_id
    UNION
    SELECT p.user_id, t.id
      FROM admin_grants p JOIN live t ON t.access_policy_id = p.policy_id
     WHERE p.grantee = 'user' AND p.user_id IN (${LIVE_IDS(workspaceId, ids)})
    UNION
    SELECT mine.user_id, t.id
      FROM admin_grants p
      JOIN mine ON mine.group_id = p.group_id
      JOIN live t ON t.access_policy_id = p.policy_id
     WHERE p.grantee = 'group'
    UNION
    SELECT t.owner_id, t.id
      FROM live t JOIN admin_grants p ON p.policy_id = t.access_policy_id
     WHERE p.grantee = 'track_owner' AND t.owner_id IN (${LIVE_IDS(workspaceId, ids)})
    UNION
    SELECT u.id, t.id
      FROM admin_grants p
      JOIN live t ON t.access_policy_id = p.policy_id
      JOIN app_user u ON u.workspace_id = ${workspaceId} AND u.id IN (${ID_LIST(ids)})
                     AND u.erased_at IS NULL
     WHERE p.grantee IN ('any_user', 'anyone')
  )`;

/** How many live tracks each of these people runs, in one statement; none is left out. */
export async function tracksRunBy(
  db: Db,
  workspaceId: number,
  ids: readonly number[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (ids.length === 0) return counts;
  const { rows } = await sql<{ user_id: number; n: string }>`
    WITH RECURSIVE ${MINE(workspaceId, ids)}, ${RUNS(workspaceId, ids)}
    SELECT user_id, count(*) AS n FROM runs GROUP BY user_id`.execute(db);
  for (const row of rows) counts.set(row.user_id, Number(row.n));
  return counts;
}

/** The live tracks one person runs, by key, at most `limit` of them. */
export async function tracksRunByOne(
  db: Db,
  workspaceId: number,
  userId: number,
  limit: number,
): Promise<{ id: number; key: string; name: string }[]> {
  const { rows } = await sql<{ id: number; key: string; name: string }>`
    WITH RECURSIVE ${MINE(workspaceId, [userId])}, ${RUNS(workspaceId, [userId])}
    SELECT t.id, t.key, t.name FROM runs r JOIN track t ON t.id = r.track_id
     ORDER BY t.key, t.id
     LIMIT ${limit}`.execute(db);
  return rows;
}

/**
 * The people of the workspace who hold a role, as an uncorrelated subquery of user ids (none is
 * null), for the list's filter: the database reads it once for the whole list.
 */
function holdersOf(workspaceId: number, role: AdminRole): RawBuilder<unknown> {
  return sql`
    SELECT u.id FROM app_user u
     WHERE u.workspace_id = ${workspaceId} AND ${role === 'site_admin' ? sql`u.is_site_admin` : sql`false`}
    UNION
    SELECT g.user_id FROM global_grant g
     WHERE g.workspace_id = ${workspaceId} AND g.grantee = 'user' AND g.permission = ${role}
       AND g.user_id IS NOT NULL
    UNION
    SELECT m.user_id FROM group_member m
     WHERE m.workspace_id = ${workspaceId} AND m.group_id IN (
       WITH RECURSIVE d(id) AS (
         SELECT g.group_id FROM global_grant g
          WHERE g.workspace_id = ${workspaceId} AND g.grantee = 'group' AND g.permission = ${role}
         UNION
         SELECT n.child_id FROM group_nesting n JOIN d ON n.parent_id = d.id
          WHERE n.workspace_id = ${workspaceId}
       )
       SELECT id FROM d)
    UNION
    SELECT u.id FROM app_user u
     WHERE u.workspace_id = ${workspaceId} AND EXISTS (
       SELECT 1 FROM global_grant g
        WHERE g.workspace_id = ${workspaceId} AND g.grantee = 'any_user' AND g.permission = ${role})`;
}

/** The people of the workspace who run a live track, as an uncorrelated subquery of user ids. */
function runnersOf(workspaceId: number): RawBuilder<unknown> {
  return sql`
    WITH RECURSIVE admin_grants AS (
      SELECT g.policy_id, g.grantee, g.role_id, g.group_id, g.user_id
        FROM access_grant g
       WHERE g.workspace_id = ${workspaceId} AND g.permission = 'administer_track'
    ),
    live AS (
      SELECT t.id, t.owner_id, t.access_policy_id FROM track t
       WHERE t.workspace_id = ${workspaceId} AND t.deleted_at IS NULL
    ),
    run_groups(id) AS (
      SELECT a.group_id
        FROM track_role_actor a
        JOIN live t ON t.id = a.track_id
        JOIN admin_grants p ON p.policy_id = t.access_policy_id AND p.grantee = 'role'
                           AND p.role_id = a.role_id
       WHERE a.group_id IS NOT NULL
      UNION
      SELECT p.group_id
        FROM admin_grants p JOIN live t ON t.access_policy_id = p.policy_id
       WHERE p.grantee = 'group' AND p.group_id IS NOT NULL
      UNION
      SELECT n.child_id FROM group_nesting n JOIN run_groups ON n.parent_id = run_groups.id
       WHERE n.workspace_id = ${workspaceId}
    )
    SELECT a.user_id
      FROM track_role_actor a
      JOIN live t ON t.id = a.track_id
      JOIN admin_grants p ON p.policy_id = t.access_policy_id AND p.grantee = 'role'
                         AND p.role_id = a.role_id
     WHERE a.user_id IS NOT NULL
    UNION
    SELECT m.user_id FROM group_member m JOIN run_groups r ON r.id = m.group_id
     WHERE m.workspace_id = ${workspaceId}
    UNION
    SELECT p.user_id
      FROM admin_grants p JOIN live t ON t.access_policy_id = p.policy_id
     WHERE p.grantee = 'user' AND p.user_id IS NOT NULL
    UNION
    SELECT t.owner_id
      FROM live t JOIN admin_grants p ON p.policy_id = t.access_policy_id
     WHERE p.grantee = 'track_owner' AND t.owner_id IS NOT NULL
    UNION
    SELECT u.id FROM app_user u
     WHERE u.workspace_id = ${workspaceId} AND EXISTS (
       SELECT 1 FROM admin_grants p JOIN live t ON t.access_policy_id = p.policy_id
        WHERE p.grantee IN ('any_user', 'anyone'))`;
}

/**
 * The list's role filter as a condition on `app_user.id`: holders of the role, people who run a
 * track, or people who are neither (Member). The subqueries are uncorrelated, so the database
 * reads each once, and paging and the total count stay right. They read the rows erasure keeps,
 * so the condition itself leaves erased people out of every filter, as `rolesOf` does.
 */
export function roleCondition(workspaceId: number, filter: RoleFilter): RawBuilder<boolean> {
  const live = sql<boolean>`app_user.erased_at IS NULL`;
  if (filter === 'runs_tracks') {
    return sql<boolean>`${live} AND app_user.id IN (${runnersOf(workspaceId)})`;
  }
  if (filter === 'member') {
    const holders = sql.join(
      ADMIN_ROLES.map((role) => sql`(${holdersOf(workspaceId, role)})`),
      sql` UNION `,
    );
    return sql<boolean>`${live} AND app_user.id NOT IN (${holders}) AND app_user.id NOT IN (${runnersOf(workspaceId)})`;
  }
  return sql<boolean>`${live} AND app_user.id IN (${holdersOf(workspaceId, filter)})`;
}

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}
