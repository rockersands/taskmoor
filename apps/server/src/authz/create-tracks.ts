import type { Database } from '@taskmoor/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import type { Authorizer } from './authorizer';

type Db = Kysely<Database> | Transaction<Database>;

/**
 * Who may create tracks (IAM-033; ADR-118). Giving someone a role that runs a track can also give
 * them the site-wide permission `create_local_tracks`, as a grant to that person. The box is the
 * giver's to tick only when they could give it anyway: a site administrator, or someone who holds
 * the permission themselves, as a group's sharer can give only what they could give. It writes a
 * site-wide grant, so a token needs the admin scope for it. Only a new role brings the grant;
 * taking the role away later leaves the grant, which a site administrator removes on the
 * Permissions page.
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
