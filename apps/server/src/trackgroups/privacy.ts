import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';
import type { Authorizer } from '../authz/authorizer';
import { type AccessChange, lockArrangements, releaseShares } from './access';

type Db = Kysely<Database>;

/**
 * Track groups in a person's data download and their erasure (T-205; ADR-111, ADR-121).
 *
 * The download's `track-groups.json` holds the groups the person owns (name, tracks by key, who
 * gave a copy, and whom they shared each with and with which role), and the groups others shared
 * with them (name, owner, role, the tracks by key and the roles the share gave). A download the
 * person asked for lists only the tracks they may see in the track list now, as their Tracks
 * page does; a site administrator's lists every track.
 *
 * Erasing the person deletes their groups, taking back what the shares of those groups gave by
 * the rules of taking a share back (never the last one to run a track: the erasure is refused),
 * and removes the shares they received with what those gave them.
 */
export interface PersonalTrackGroups {
  groups: {
    name: string;
    createdAt: string;
    minimized: boolean;
    /** Who set this group on the person, for a copy. */
    givenBy: string | null;
    tracks: string[];
    sharedWith: { person: string; role: string | null; since: string }[];
  }[];
  sharedWithMe: {
    name: string;
    owner: string;
    role: string | null;
    since: string;
    minimized: boolean;
    tracks: string[];
    /** The roles the share gave the person, by track. */
    rolesGiven: { track: string; role: string }[];
  }[];
}

/** The tracks of these that the person sees in the track list: active, and browsed or run. */
async function seenBy(
  db: Db,
  authorizer: Authorizer,
  workspaceId: number,
  userId: number,
  trackIds: readonly number[],
): Promise<Set<number>> {
  if (trackIds.length === 0) return new Set();
  const [browse, administer] = await Promise.all([
    authorizer.allowedTracks(workspaceId, { userId }, 'browse_track'),
    authorizer.allowedTracks(workspaceId, { userId }, 'administer_track'),
  ]);
  const allowed =
    browse === 'all' || administer === 'all' ? null : new Set([...browse, ...administer]);
  const rows = await db
    .selectFrom('track')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('id', 'in', [...new Set(trackIds)])
    .where('archived_at', 'is', null)
    .where('deleted_at', 'is', null)
    .execute();
  return new Set(rows.map((r) => r.id).filter((t) => allowed === null || allowed.has(t)));
}

export async function personalTrackGroups(
  db: Db,
  authorizer: Authorizer,
  options: { workspaceId: number; userId: number; self: boolean },
): Promise<PersonalTrackGroups> {
  const { workspaceId: ws, userId } = options;
  const [owned, received] = await Promise.all([
    db
      .selectFrom('track_group as g')
      .leftJoin('app_user as gb', 'gb.id', 'g.given_by')
      .select(['g.id', 'g.name', 'g.created_at', 'g.minimized', 'gb.name as given_by'])
      .where('g.workspace_id', '=', ws)
      .where('g.owner_id', '=', userId)
      .orderBy('g.position')
      .orderBy('g.id')
      .execute(),
    db
      .selectFrom('track_group_share as s')
      .innerJoin('track_group as g', 'g.id', 's.group_id')
      .innerJoin('app_user as o', 'o.id', 'g.owner_id')
      .leftJoin('role as r', 'r.id', 's.role_id')
      .select([
        's.id as share_id',
        'g.id',
        'g.name',
        'o.name as owner',
        'r.name as role',
        's.created_at',
        's.minimized',
      ])
      .where('s.workspace_id', '=', ws)
      .where('s.user_id', '=', userId)
      .orderBy('s.position')
      .orderBy('s.id')
      .execute(),
  ]);
  const groupIds = [...owned.map((g) => g.id), ...received.map((g) => g.id)];
  const shareIds = received.map((s) => s.share_id);
  const [members, given, roles] = await Promise.all([
    groupIds.length === 0
      ? []
      : db
          .selectFrom('track_group_track as m')
          .innerJoin('track as t', 't.id', 'm.track_id')
          .select(['m.group_id', 't.id', 't.key'])
          .where('m.group_id', 'in', groupIds)
          .orderBy('m.group_id')
          .orderBy('m.position')
          .execute(),
    owned.length === 0
      ? []
      : db
          .selectFrom('track_group_share as s')
          .innerJoin('app_user as u', 'u.id', 's.user_id')
          .leftJoin('role as r', 'r.id', 's.role_id')
          .select(['s.group_id', 'u.name as person', 'r.name as role', 's.created_at'])
          .where(
            's.group_id',
            'in',
            owned.map((g) => g.id),
          )
          .orderBy('s.id')
          .execute(),
    shareIds.length === 0
      ? []
      : db
          .selectFrom('track_group_access as a')
          .innerJoin('track as t', 't.id', 'a.track_id')
          .innerJoin('role as r', 'r.id', 'a.role_id')
          .select(['a.share_id', 't.id as track_id', 't.key', 'r.name'])
          .where('a.share_id', 'in', shareIds)
          .orderBy('t.key')
          .execute(),
  ]);
  const seen = options.self
    ? await seenBy(db, authorizer, ws, userId, [
        ...members.map((m) => m.id),
        ...roles.map((r) => r.track_id),
      ])
    : null;
  const shows = (trackId: number) => seen === null || seen.has(trackId);
  const keysOf = (groupId: number) =>
    members.filter((m) => m.group_id === groupId && shows(m.id)).map((m) => m.key);
  const iso = (d: Date) => d.toISOString();
  return {
    groups: owned.map((g) => ({
      name: g.name,
      createdAt: iso(g.created_at),
      minimized: g.minimized,
      givenBy: g.given_by,
      tracks: keysOf(g.id),
      sharedWith: given
        .filter((s) => s.group_id === g.id)
        .map((s) => ({ person: s.person, role: s.role, since: iso(s.created_at) })),
    })),
    sharedWithMe: received.map((s) => ({
      name: s.name,
      owner: s.owner,
      role: s.role,
      since: iso(s.created_at),
      minimized: s.minimized,
      tracks: keysOf(s.id),
      rolesGiven: roles
        .filter((r) => r.share_id === s.share_id && shows(r.track_id))
        .map((r) => ({ track: r.key, role: r.name })),
    })),
  };
}

export interface ErasedTrackGroups {
  groups: number;
  sharesGiven: number;
  sharesReceived: number;
  /** The roles that went with them. */
  removed: AccessChange[];
}

/**
 * Removes a person's track groups in the caller's transaction, before the person is erased:
 * their groups go, taking back what the groups' shares gave by the rules of taking a share back
 * (throws `LastTrackAdministrator` when that would leave a track with nobody to run it), and the
 * shares they received go with what those gave them.
 */
export async function eraseTrackGroups(
  trx: Transaction<Database>,
  workspaceId: number,
  userId: number,
): Promise<ErasedTrackGroups> {
  const received = await trx
    .selectFrom('track_group_share as s')
    .innerJoin('track_group as g', 'g.id', 's.group_id')
    .select(['s.id', 'g.owner_id'])
    .where('s.workspace_id', '=', workspaceId)
    .where('s.user_id', '=', userId)
    .execute();
  // The person's arrangement and that of everyone whose group they received, as the routes
  // take them, so no change to these groups runs alongside.
  await lockArrangements(trx, [userId, ...received.map((r) => r.owner_id)]);
  const owned = await trx
    .selectFrom('track_group')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('owner_id', '=', userId)
    .orderBy('id')
    .forUpdate()
    .execute();
  const given =
    owned.length === 0
      ? []
      : await trx
          .selectFrom('track_group_share')
          .select('id')
          .where(
            'group_id',
            'in',
            owned.map((g) => g.id),
          )
          .execute();
  // Read again under the locks: a share made meanwhile goes too.
  const receivedNow = await trx
    .selectFrom('track_group_share')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .execute();
  const removed = [
    ...(await releaseShares(
      trx,
      workspaceId,
      given.map((s) => s.id),
    )),
    // The person is deactivated with the erasure: their roles run no track either way.
    ...(await releaseShares(
      trx,
      workspaceId,
      receivedNow.map((s) => s.id),
      null,
      { keepAdministrators: false },
    )),
  ];
  if (receivedNow.length > 0) {
    await trx
      .deleteFrom('track_group_share')
      .where(
        'id',
        'in',
        receivedNow.map((s) => s.id),
      )
      .execute();
  }
  if (owned.length > 0) {
    await trx
      .deleteFrom('track_group')
      .where(
        'id',
        'in',
        owned.map((g) => g.id),
      )
      .execute();
  }
  return {
    groups: owned.length,
    sharesGiven: given.length,
    sharesReceived: receivedNow.length,
    removed,
  };
}
