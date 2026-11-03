import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Authorizer, AuthzContext } from './authorizer';

type Db = Kysely<Database> | Transaction<Database>;

/**
 * Who runs a track, and who may say so (IAM-028; ADR-118). A role that runs the track is one
 * its access policy gives `administer_track`; that is decided by the grants, not by the role's
 * name, so a renamed "Administrators" stays protected. Giving or taking such a role needs
 * `appoint_track_admins`, which a site administrator always holds. Everything here is about one
 * track: nothing touches a person's global permissions or their access to any other track.
 */
export async function roleRunsTrack(db: Db, trackId: number, roleId: number): Promise<boolean> {
  const row = await db
    .selectFrom('access_grant as g')
    .innerJoin('track as t', 't.access_policy_id', 'g.policy_id')
    .select('g.id')
    .where('t.id', '=', trackId)
    .where('g.permission', '=', 'administer_track')
    .where('g.grantee', '=', 'role')
    .where('g.role_id', '=', roleId)
    .executeTakeFirst();
  return row !== undefined;
}

/** Whether the person asking may give or take this role in this track. */
export async function mayGiveRole(
  db: Db,
  authz: AuthzContext,
  trackId: number,
  roleId: number,
): Promise<boolean> {
  if (!(await roleRunsTrack(db, trackId, roleId))) return true;
  return authz.can('appoint_track_admins', trackId);
}

/** What a change would take away, for the question below. */
export type LeavingAdministrator =
  | { kind: 'actor'; roleId: number; userId: number | null; groupId: number | null }
  | { kind: 'grant'; grantId: number };

/**
 * Whether the track would still have someone to run it after the change: an active person who
 * holds `administer_track` through a role, a group, a direct grant or as its owner. Like the
 * last site administrator (`activeAdminCount`), the last administrator of a track cannot be
 * removed by mistake; site administrators do not count, they run every track anyway.
 */
export async function trackKeepsAdministrator(
  db: Db,
  workspaceId: number,
  trackId: number,
  leaving: LeavingAdministrator,
): Promise<boolean> {
  const { rows } = await sql<{ found: number }>`
    WITH RECURSIVE track_row AS (
      SELECT id, owner_id, access_policy_id FROM track
       WHERE id = ${trackId} AND workspace_id = ${workspaceId}
    ),
    runs AS (
      SELECT g.id, g.grantee, g.role_id, g.group_id, g.user_id
        FROM access_grant g JOIN track_row t ON t.access_policy_id = g.policy_id
       WHERE g.permission = 'administer_track'
         AND ${leaving.kind === 'grant' ? sql`g.id <> ${leaving.grantId}` : sql`true`}
    ),
    actors AS (
      SELECT a.user_id, a.group_id
        FROM track_role_actor a JOIN runs r ON r.grantee = 'role' AND r.role_id = a.role_id
       WHERE a.track_id = ${trackId}
         AND ${
           leaving.kind === 'actor'
             ? sql`NOT (a.role_id = ${leaving.roleId}
                   AND a.user_id IS NOT DISTINCT FROM ${leaving.userId}::int
                   AND a.group_id IS NOT DISTINCT FROM ${leaving.groupId}::int)`
             : sql`true`
         }
    ),
    groups(id) AS (
      SELECT group_id FROM actors WHERE group_id IS NOT NULL
      UNION SELECT group_id FROM runs WHERE grantee = 'group'
      UNION
      SELECT n.child_id FROM group_nesting n JOIN groups ON n.parent_id = groups.id
    ),
    people(id) AS (
      SELECT user_id FROM actors WHERE user_id IS NOT NULL
      UNION SELECT user_id FROM runs WHERE grantee = 'user'
      UNION SELECT m.user_id FROM group_member m JOIN groups ON m.group_id = groups.id
      UNION SELECT t.owner_id FROM track_row t, runs r
             WHERE r.grantee = 'track_owner' AND t.owner_id IS NOT NULL
    )
    SELECT 1 AS found
     WHERE EXISTS (SELECT 1 FROM runs WHERE grantee IN ('any_user', 'anyone'))
        OR EXISTS (
          SELECT 1 FROM people p JOIN app_user u ON u.id = p.id
           WHERE u.deactivated_at IS NULL AND u.kind = 'person')`.execute(db);
  return rows.length > 0;
}

/**
 * Whether a person may still invite into this track with this role: what backs an open
 * invitation. Taking the permission away, or the inviter leaving, ends their open invitations.
 */
export async function inviterStillBacks(
  db: Db,
  authorizer: Authorizer,
  invitation: { workspaceId: number; trackId: number; roleId: number; invitedBy: number | null },
): Promise<boolean> {
  if (invitation.invitedBy === null) return false;
  const held = await authorizer.trackPermissions(
    invitation.workspaceId,
    { userId: invitation.invitedBy },
    invitation.trackId,
  );
  if (!held.has('administer_track') || !held.has('invite_people')) return false;
  if (!(await roleRunsTrack(db, invitation.trackId, invitation.roleId))) return true;
  return held.has('appoint_track_admins');
}
