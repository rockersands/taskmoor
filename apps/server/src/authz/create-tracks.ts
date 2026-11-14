import type { Database } from '@taskmoor/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Authorizer } from './authorizer';

type Db = Kysely<Database> | Transaction<Database>;

/**
 * Who may create tracks (IAM-033; ADR-118). Giving someone a role that runs a track can also give
 * them the site-wide permission `create_local_tracks`, as a grant to that person. The box is the
 * giver's to tick only when they could give it anyway: a site administrator, or someone who holds
 * the permission themselves, as a group's sharer can give only what they could give. It writes a
 * site-wide grant, so a token needs the admin scope for it. Only a new role brings the grant.
 *
 * The grant goes with the role (T-087b, the user's decision of 2026-11-13; ADR-118): once the
 * person runs no track any more, or is deactivated, the change that took it away removes the
 * grant that came with a role, and its event names it (`dropLapsedCreateTracks`). A grant a site
 * administrator gave on the Permissions page, or one the person already held when the box was
 * ticked, was given separately: it stays until a site administrator removes it.
 */
export const CREATE_TRACKS = 'create_local_tracks';

/** Whether the person asking may give the permission to create tracks. */
export async function mayGiveCreateTracks(request: FastifyRequest): Promise<boolean> {
  return request.authz.hasGlobal(CREATE_TRACKS);
}

/**
 * Answers and returns false when the request may not give the permission: a token without the
 * admin scope (403 `insufficient_scope`), or someone who neither administers the site nor holds
 * the permission (403 naming it).
 */
export async function checkGivingCreateTracks(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (request.authz.principal.withoutAdminRights) {
    await reply
      .code(403)
      .header(
        'www-authenticate',
        'Bearer realm="taskmoor", error="insufficient_scope", scope="admin"',
      )
      .send({ error: 'insufficient_scope', requiredScope: 'admin' });
    return false;
  }
  if (!(await mayGiveCreateTracks(request))) {
    await reply.code(403).send({ error: 'forbidden', permission: CREATE_TRACKS });
    return false;
  }
  return true;
}

/** Whether whoever backs an invitation may still give the permission when it is taken up. */
export async function inviterMayGiveCreateTracks(
  authorizer: Authorizer,
  workspaceId: number,
  invitedBy: number | null,
): Promise<boolean> {
  if (invitedBy === null) return false;
  return (await authorizer.globalPermissions(workspaceId, invitedBy)).has(CREATE_TRACKS);
}

/**
 * Grants the permission to one person, in the caller's transaction. The new grant's id, or null
 * when the person already had a grant of their own: nothing to write then. The caller's event
 * carries the id, so the change stays one event (M1-005).
 */
export async function giveCreateTracks(
  trx: Db,
  workspaceId: number,
  userId: number,
): Promise<number | null> {
  const row = await trx
    .insertInto('global_grant')
    .values({
      workspace_id: workspaceId,
      permission: CREATE_TRACKS,
      grantee: 'user',
      user_id: userId,
    })
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .executeTakeFirst();
  return row?.id ?? null;
}

/** An active person, who can hold the permission; not a service account. */
export async function isActivePerson(
  db: Db,
  workspaceId: number,
  userId: number,
): Promise<boolean> {
  const row = await db
    .selectFrom('app_user')
    .select('id')
    .where('id', '=', userId)
    .where('workspace_id', '=', workspaceId)
    .where('deactivated_at', 'is', null)
    .where('kind', '=', 'person')
    .executeTakeFirst();
  return row !== undefined;
}

/** A grant of the permission to create tracks that went with the role it came with. */
export interface LapsedCreateTracks {
  userId: number;
  grantId: number;
}

/**
 * The events that record a grant given with a role (IAM-033): the role given on the People page,
 * an invitation to an existing person, or one taken up. Each carries the grant's id.
 */
const GRANT_EVENTS = [
  'track_role.actor_added',
  'track_invitation.created',
  'track_invitation.accepted',
] as const;

/**
 * The people of these who run no track now, read in the caller's transaction: deactivated, or
 * holding `administer_track` on no live track through a role (directly or through a group,
 * nested groups included), a grant to them or a group of theirs, or as a track's owner. The
 * same ways to run a track that `trackKeepsAdministrator` counts, over every track.
 */
async function runningNoTrack(
  db: Db,
  workspaceId: number,
  userIds: readonly number[],
): Promise<number[]> {
  const ids = sql.join(userIds.map((u) => sql`${u}::int`));
  const { rows } = await sql<{ id: number }>`
    WITH RECURSIVE mine(user_id, group_id) AS (
      SELECT m.user_id, m.group_id FROM group_member m
       WHERE m.workspace_id = ${workspaceId} AND m.user_id IN (${ids})
      UNION
      SELECT mine.user_id, n.parent_id FROM group_nesting n JOIN mine ON n.child_id = mine.group_id
       WHERE n.workspace_id = ${workspaceId}
    )
    SELECT u.id FROM app_user u
     WHERE u.workspace_id = ${workspaceId} AND u.id IN (${ids})
       AND (u.deactivated_at IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM track t
           JOIN access_grant g ON g.policy_id = t.access_policy_id
                               AND g.permission = 'administer_track'
          WHERE t.workspace_id = ${workspaceId} AND t.deleted_at IS NULL
            AND (
              (g.grantee = 'role' AND EXISTS (
                 SELECT 1 FROM track_role_actor a
                  WHERE a.track_id = t.id AND a.role_id = g.role_id
                    AND (a.user_id = u.id OR a.group_id IN (
                      SELECT mine.group_id FROM mine WHERE mine.user_id = u.id))))
              OR (g.grantee = 'user' AND g.user_id = u.id)
              OR (g.grantee = 'group' AND g.group_id IN (
                    SELECT mine.group_id FROM mine WHERE mine.user_id = u.id))
              OR (g.grantee = 'track_owner' AND t.owner_id = u.id))))`.execute(db);
  return rows.map((r) => r.id);
}

/**
 * Removes, in the caller's transaction, the permission to create tracks of each of these people
 * who no longer runs a track (or is deactivated), when it came with a role: a grant one of
 * `GRANT_EVENTS` names. A grant given separately stays. Returns what it removed, for the
 * caller's one event (M1-005), which the audit log records; call it after the change that may
 * have taken the person's last role away, and only with the people that change touched.
 */
export async function dropLapsedCreateTracks(
  trx: Db,
  workspaceId: number,
  userIds: readonly number[],
): Promise<LapsedCreateTracks[]> {
  const people = [...new Set(userIds)];
  if (people.length === 0) return [];
  const grants = await trx
    .selectFrom('global_grant')
    .select(['id', 'user_id'])
    .where('workspace_id', '=', workspaceId)
    .where('permission', '=', CREATE_TRACKS)
    .where('grantee', '=', 'user')
    .where('user_id', 'in', people)
    .orderBy('user_id')
    .execute();
  if (grants.length === 0) return [];
  const idle = new Set(
    await runningNoTrack(
      trx,
      workspaceId,
      grants.map((g) => g.user_id as number),
    ),
  );
  const lapsed: LapsedCreateTracks[] = [];
  for (const grant of grants) {
    const userId = grant.user_id as number;
    if (!idle.has(userId)) continue;
    // Only a grant that came with a role goes; the events are the record of where it came from.
    const withRole = await trx
      .selectFrom('domain_event')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('subject_type', '=', 'track')
      .where('type', 'in', [...GRANT_EVENTS])
      .where(sql<boolean>`payload -> 'createTracksGrantId' = to_jsonb(${grant.id}::int)`)
      .limit(1)
      .executeTakeFirst();
    if (!withRole) continue;
    const removed = await trx
      .deleteFrom('global_grant')
      .where('id', '=', grant.id)
      .executeTakeFirst();
    if (Number(removed.numDeletedRows) > 0) lapsed.push({ userId, grantId: grant.id });
  }
  return lapsed;
}

/** The field a change's event carries for what `dropLapsedCreateTracks` removed, if anything. */
export const lapsedPayload = (lapsed: readonly LapsedCreateTracks[]) =>
  lapsed.length > 0 ? { createTracksGrantsRemoved: [...lapsed] } : {};
