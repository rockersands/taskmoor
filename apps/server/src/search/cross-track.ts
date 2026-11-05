import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';
import type { Authorizer } from '../authz/authorizer';
import type { TrackPermission } from '../authz/permissions';

/**
 * Who sees a release across tracks (PLN-007; ADR-122 stage 4): its owner, site and configuration
 * administrators, and anyone who may see one of its linked tracks by the release page's rule
 * (browse or administer the track). A ticket-level grant shows single tickets, never the track,
 * so it shows no release across tracks. A track in the trash shows nobody anything.
 *
 * Every read goes through this, the query field's binding too, so a name or id the person may not
 * see reads exactly as one that does not exist.
 */
type Db = Kysely<Database> | Transaction<Database>;

export interface CrossTrackSight {
  /** Site and configuration administrators see every one. */
  admin(): Promise<boolean>;
  /** The live tracks where the person holds a permission; never a ticket-level grant. */
  allowed(permission: TrackPermission): Promise<readonly number[] | 'all'>;
  /** Whether they browse or administer this track, archived or not. */
  track(trackId: number): Promise<boolean>;
}

/** No viewer: a board's queries as they show to anyone (`workspaceScope`). */
export const SEES_EVERY: CrossTrackSight = {
  admin: async () => true,
  allowed: async () => 'all',
  track: async () => true,
};

/** What the signed-in or token caller of a request sees. */
export function requestSight(request: {
  authz: {
    global(): Promise<ReadonlySet<string>>;
    track(trackId: number): Promise<ReadonlySet<TrackPermission>>;
    allowedTracks(permission: TrackPermission): Promise<readonly number[] | 'all'>;
  };
}): CrossTrackSight {
  return {
    admin: async () => {
      const global = await request.authz.global();
      return global.has('site_admin') || global.has('configuration_admin');
    },
    allowed: (permission) => request.authz.allowedTracks(permission),
    track: async (trackId) => {
      const held = await request.authz.track(trackId);
      return held.has('browse_track') || held.has('administer_track');
    },
  };
}

/** What a person sees when the worker runs their saved search (`search/subscriptions.ts`). */
export function authorizerSight(
  authorizer: Authorizer,
  workspaceId: number,
  principal: { userId: number },
): CrossTrackSight {
  return {
    admin: async () => {
      const global = await authorizer.globalPermissions(workspaceId, principal.userId);
      return global.has('site_admin') || global.has('configuration_admin');
    },
    allowed: (permission) => authorizer.allowedTracks(workspaceId, principal, permission),
    track: async (trackId) => {
      const held = await authorizer.trackPermissions(workspaceId, principal, trackId);
      return held.has('browse_track') || held.has('administer_track');
    },
  };
}

/**
 * The linked tracks the person may see, or `all` for an administrator. Live tracks come from the
 * permission lists in one statement each; only an archived linked track is asked about alone.
 */
export async function seenLinkedTracks(
  db: Db,
  workspaceId: number,
  sight: CrossTrackSight,
): Promise<ReadonlySet<number> | 'all'> {
  if (await sight.admin()) return 'all';
  const linked = await db
    .selectFrom('cross_track_release_member as m')
    .innerJoin('track as t', 't.id', 'm.track_id')
    .select(['t.id', 't.archived_at'])
    .distinct()
    .where('m.workspace_id', '=', workspaceId)
    .where('t.deleted_at', 'is', null)
    .execute();
  const [browse, administer] = await Promise.all([
    sight.allowed('browse_track'),
    sight.allowed('administer_track'),
  ]);
  const listed = (list: readonly number[] | 'all', id: number) =>
    list === 'all' || list.includes(id);
  const seen = new Set<number>();
  for (const t of linked) {
    if (listed(browse, t.id) || listed(administer, t.id)) seen.add(t.id);
    else if (t.archived_at && (await sight.track(t.id))) seen.add(t.id);
  }
  return seen;
}

/** The releases across tracks the person sees, by id and name. Without a sight, none. */
export async function seenCrossTrackReleases(
  db: Db,
  workspaceId: number,
  userId: number | null,
  sight: CrossTrackSight | undefined,
): Promise<{ id: number; name: string }[]> {
  if (!sight) return [];
  const rows = await db
    .selectFrom('cross_track_release')
    .select(['id', 'name', 'owner_id'])
    .where('workspace_id', '=', workspaceId)
    .execute();
  if (rows.length === 0) return [];
  const tracks = await seenLinkedTracks(db, workspaceId, sight);
  if (tracks === 'all') return rows.map((r) => ({ id: r.id, name: r.name }));
  const members =
    tracks.size === 0
      ? []
      : await db
          .selectFrom('cross_track_release_member')
          .select('cross_track_release_id')
          .distinct()
          .where('workspace_id', '=', workspaceId)
          .where('track_id', 'in', [...tracks])
          .execute();
  const seen = new Set(members.map((m) => m.cross_track_release_id));
  return rows
    .filter((r) => r.owner_id === userId || seen.has(r.id))
    .map((r) => ({ id: r.id, name: r.name }));
}
