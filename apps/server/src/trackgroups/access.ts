import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuthzContext } from '../authz/authorizer';
import { roleRunsTrack, trackKeepsAdministrator } from '../authz/track-admins';

type Db = Kysely<Database> | Transaction<Database>;

/**
 * What sharing a track group gives (IAM-034; ADR-121). A share with a role gives that role on
 * each of the group's tracks where whoever shares may give it, by the People page's rules: they
 * run the track, and a role that runs it also needs `appoint_track_admins`. The role is an
 * ordinary `track_role_actor` row, so the authorizer, the People page and the audit log see it
 * like any other; `track_group_access` records which shares hold it.
 *
 * - A role the person lacks is added, and the share holds it.
 * - A role other shares hold is held by this share too, so it stays while any of them does.
 * - A role the person had otherwise is left alone: no share holds it, and none takes it away.
 *
 * Taking a share back, or a track out of a shared group, removes the roles no other share holds;
 * giving such a role on the People page or by an invitation makes it the person's own (`keepRole`).
 */
export interface AccessChange {
  trackId: number;
  userId: number;
  roleId: number;
}

/** A share's taking back would leave these tracks with no one to run them (IAM-028). */
export class LastTrackAdministrator extends Error {
  constructor(readonly trackIds: number[]) {
    super('last_track_admin');
  }
}

/** The tracks of these where the caller may give the role, as on each track's People page. */
export async function givableTracks(
  db: Db,
  authz: AuthzContext,
  roleId: number,
  trackIds: readonly number[],
): Promise<number[]> {
  if (trackIds.length === 0) return [];
  const live = await db
    .selectFrom('track')
    .select('id')
    .where('id', 'in', [...trackIds])
    .where('deleted_at', 'is', null)
    .execute();
  const out: number[] = [];
  for (const { id } of live) {
    const held = await authz.track(id);
    if (!held.has('administer_track')) continue;
    if (held.has('appoint_track_admins') || !(await roleRunsTrack(db, id, roleId))) out.push(id);
  }
  return out.sort((a, b) => trackIds.indexOf(a) - trackIds.indexOf(b));
}

const heldByShares = async (db: Db, trackId: number, roleId: number, userId: number) =>
  (await db
    .selectFrom('track_group_access')
    .select('share_id')
    .where('track_id', '=', trackId)
    .where('role_id', '=', roleId)
    .where('user_id', '=', userId)
    .executeTakeFirst()) !== undefined;

/**
 * Locks track rows in id order. Every change to a person's role in a track takes this lock
 * first, here, on the People page and in invitations, so a give, a take-back and a role made the
 * person's own (`keepRole`) on one track run one after another and the record stays exact.
 */
export async function lockTracks(db: Db, trackIds: readonly number[]): Promise<void> {
  if (trackIds.length === 0) return;
  await db
    .selectFrom('track')
    .select('id')
    .where('id', 'in', [...new Set(trackIds)])
    .orderBy('id')
    .forUpdate()
    .execute();
}

/**
 * Gives a share's role on tracks the caller has already checked with `givableTracks`. Returns
 * the roles it added; those the person already held are not changes.
 */
export async function giveThroughShare(
  trx: Transaction<Database>,
  share: { id: number; workspaceId: number; userId: number; roleId: number },
  trackIds: readonly number[],
): Promise<{ given: AccessChange[]; alreadyHeld: number }> {
  const given: AccessChange[] = [];
  let alreadyHeld = 0;
  const { workspaceId, userId, roleId } = share;
  await lockTracks(trx, trackIds);
  for (const trackId of trackIds) {
    const added = await trx
      .insertInto('track_role_actor')
      .values({ workspace_id: workspaceId, track_id: trackId, role_id: roleId, user_id: userId })
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    const isNew = Number(added.numInsertedOrUpdatedRows ?? 0) > 0;
    if (isNew) given.push({ trackId, userId, roleId });
    else alreadyHeld++;
    // A role held otherwise stays out of the shares' hands.
    if (isNew || (await heldByShares(trx, trackId, roleId, userId))) {
      await trx
        .insertInto('track_group_access')
        .values({
          workspace_id: workspaceId,
          share_id: share.id,
          track_id: trackId,
          role_id: roleId,
          user_id: userId,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  }
  return { given, alreadyHeld };
}

/**
 * Gives a role on tracks as an ordinary role, held by no share: what setting a group on someone
 * gives (ADR-121). A role shares held becomes the person's own, and is listed as `kept`.
 */
export async function giveOutright(
  trx: Transaction<Database>,
  workspaceId: number,
  userId: number,
  roleId: number,
  trackIds: readonly number[],
): Promise<{ given: AccessChange[]; kept: AccessChange[]; alreadyHeld: number }> {
  const given: AccessChange[] = [];
  const kept: AccessChange[] = [];
  let alreadyHeld = 0;
  await lockTracks(trx, trackIds);
  for (const trackId of trackIds) {
    const added = await trx
      .insertInto('track_role_actor')
      .values({ workspace_id: workspaceId, track_id: trackId, role_id: roleId, user_id: userId })
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    const isNew = Number(added.numInsertedOrUpdatedRows ?? 0) > 0;
    // A new row clears any record left behind; an existing one becomes the person's own.
    const fromShares = await keepRole(trx, trackId, roleId, userId);
    if (isNew) given.push({ trackId, userId, roleId });
    else {
      alreadyHeld++;
      if (fromShares) kept.push({ trackId, userId, roleId });
    }
  }
  return { given, kept, alreadyHeld };
}

/**
 * Takes back what shares hold on tracks: their records go, and a role no other share still
 * holds is removed. `shareIds` are the shares, `trackIds` limits it to some tracks (all when
 * null). Throws `LastTrackAdministrator`, inside the caller's transaction, when a removal would
 * leave a track with nobody to run it.
 */
export async function releaseShares(
  trx: Transaction<Database>,
  workspaceId: number,
  shareIds: readonly number[],
  trackIds: readonly number[] | null = null,
): Promise<AccessChange[]> {
  if (shareIds.length === 0 || trackIds?.length === 0) return [];
  let query = trx
    .selectFrom('track_group_access')
    .select(['share_id', 'track_id', 'role_id', 'user_id'])
    .where('share_id', 'in', [...shareIds]);
  if (trackIds) query = query.where('track_id', 'in', [...trackIds]);
  const held = await query.orderBy('track_id').orderBy('share_id').execute();
  if (held.length === 0) return [];
  // One change at a time per track, as on the People page, so two removals cannot both leave
  // the track with no one to run it.
  await lockTracks(
    trx,
    held.map((h) => h.track_id),
  );
  let release = trx.deleteFrom('track_group_access').where('share_id', 'in', [...shareIds]);
  if (trackIds) release = release.where('track_id', 'in', [...trackIds]);
  await release.execute();

  const removed: AccessChange[] = [];
  const last: number[] = [];
  const seen = new Set<string>();
  for (const h of held) {
    const key = `${h.track_id}:${h.role_id}:${h.user_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await heldByShares(trx, h.track_id, h.role_id, h.user_id)) continue;
    if (
      (await roleRunsTrack(trx, h.track_id, h.role_id)) &&
      !(await trackKeepsAdministrator(trx, workspaceId, h.track_id, {
        kind: 'actor',
        roleId: h.role_id,
        userId: h.user_id,
        groupId: null,
      }))
    ) {
      last.push(h.track_id);
      continue;
    }
    const result = await trx
      .deleteFrom('track_role_actor')
      .where('track_id', '=', h.track_id)
      .where('role_id', '=', h.role_id)
      .where('user_id', '=', h.user_id)
      .executeTakeFirst();
    if (Number(result.numDeletedRows) > 0) {
      removed.push({ trackId: h.track_id, userId: h.user_id, roleId: h.role_id });
    }
  }
  if (last.length > 0) throw new LastTrackAdministrator(last);
  return removed;
}

/**
 * A role given on the People page or by an invitation is the person's own from then on: shares
 * stop holding it, so taking them back leaves it. True when shares held it.
 */
export async function keepRole(
  db: Db,
  trackId: number,
  roleId: number,
  userId: number,
): Promise<boolean> {
  const result = await db
    .deleteFrom('track_group_access')
    .where('track_id', '=', trackId)
    .where('role_id', '=', roleId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}
