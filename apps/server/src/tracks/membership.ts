import { type RawBuilder, sql } from 'kysely';
import type { Viewer } from '../authz/visibility';

/**
 * The tracks a person belongs to (T-194; AGL-019; ADR-046), for Home's "Your tracks" and
 * `GET /api/v1/tracks?member=true`. A person belongs to a track when:
 *
 * - they hold a role on it, given to them directly or to a group they are in (nested groups
 *   included);
 * - they own it;
 * - they are in a team (ADR-076) that one of its boards belongs to, or that owns one of its
 *   areas that is not archived. A team grants nothing, so this never makes a track visible: it
 *   only says who works there.
 *
 * Seeing a track is not belonging to it: a track open to everyone or to every signed-in person,
 * a grant of the access policy to a person or a group (a policy is often shared by many tracks),
 * and the rights of site and configuration administrators all let a person see tracks they do
 * not belong to. The list applies this on top of what the person may see.
 *
 * A predicate on track `t`; an anonymous or deactivated person belongs to nothing.
 */
export function belongsSql(workspaceId: number, viewer: Viewer): RawBuilder<boolean> {
  if (viewer.userId === null || !viewer.active) return sql<boolean>`false`;
  const userId = viewer.userId;
  const groups = [...viewer.groups];
  return sql<boolean>`(
    t.owner_id = ${userId}
    OR t.id IN (
      SELECT a.track_id FROM track_role_actor a
       WHERE a.workspace_id = ${workspaceId}
         AND (a.user_id = ${userId} OR a.group_id = ANY(${groups}::int[]))
      UNION
      SELECT b.location_track_id FROM board b
        JOIN team_member m ON m.team_id = b.team_id
       WHERE m.workspace_id = ${workspaceId} AND m.user_id = ${userId}
         AND b.location_track_id IS NOT NULL
      UNION
      SELECT ar.track_id FROM area ar
        JOIN team_member m ON m.team_id = ar.owner_team_id
       WHERE m.workspace_id = ${workspaceId} AND m.user_id = ${userId}
         AND ar.archived_at IS NULL
    )
  )`;
}
