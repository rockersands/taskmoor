import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import {
  ADMIN_GLOBAL_PERMISSIONS,
  ARCHIVED_TRACK_PERMISSIONS,
  CONFIGURATION_PERMISSIONS,
  GLOBAL_PERMISSIONS,
  type GlobalPermission,
  isReadOnlyPermission,
  TRACK_PERMISSIONS,
  type TrackPermission,
} from './permissions';

/**
 * The authorization service (M1-002; ADR-012, IAM-009 to IAM-012). Permissions live in ordinary
 * tables; one statement answers every permission a person holds in a track, nested groups
 * included. Answers are cached per process and carry the workspace's epoch, which triggers move
 * on every change to grants, roles, memberships, nesting, tracks' policies or owners, and the
 * admin flag; a cached answer from an older epoch is not used.
 *
 * Site administrators hold every permission everywhere; configuration administrators hold the
 * configuration permissions of every track. Ticket-level grantees (requester, assignee, user and
 * group fields) never grant at track level; M1-020 applies them to each ticket.
 *
 * Archived tracks (M1-006, CORE-025) are read-only for everyone, site administrators included:
 * whatever a person held there shrinks to the read permissions of ARCHIVED_TRACK_PERMISSIONS,
 * and the search pre-filter leaves them out unless a site administrator asks for them.
 */
export interface Principal {
  /** Null for anonymous visitors, who hold only what is granted to "anyone". */
  userId: number | null;
  /**
   * True for a request made with an API token that lacks the admin scope (IAM-007, ADR-035):
   * the person acts as an ordinary user, without the administrator permissions they hold.
   */
  withoutAdminRights?: boolean;
}

/** Drops the administrator permissions from a set when the principal may not use them. */
function forPrincipal(
  set: ReadonlySet<GlobalPermission>,
  principal: Principal,
): ReadonlySet<GlobalPermission> {
  if (!principal.withoutAdminRights) return set;
  return new Set([...set].filter((p) => !ADMIN_GLOBAL_PERMISSIONS.includes(p)));
}

export interface Explanation {
  allowed: boolean;
  /** The track is archived: only read permissions hold there, whatever the grants say. */
  trackArchived: boolean;
  /** Why it is allowed: the grants or administrator rights that decided it. */
  reasons: Reason[];
  /** Grants that may allow it for single tickets (requester, assignee, fields). */
  ticketLevel: { grantId: number; grantee: string; fieldKey: string | null }[];
}

export type Reason =
  | { kind: 'site_admin' }
  | { kind: 'configuration_admin' }
  | {
      kind: 'grant';
      grantId: number;
      grantee: string;
      roleId?: number;
      roleName?: string;
      groupId?: number;
      groupName?: string;
    };

/** The groups a user is in, directly or through nesting, as a CTE named g. */
const GROUPS_CTE = (workspaceId: number, userId: number) => sql`
  g(id) AS (
    SELECT group_id FROM group_member WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    UNION
    SELECT n.parent_id FROM group_nesting n JOIN g ON n.child_id = g.id
     WHERE n.workspace_id = ${workspaceId}
  )`;

/** The grantee test of a grant `gr` on track `t` for user `userId`. */
const GRANTEE_MATCHES = (userId: number) => sql`(
     gr.grantee IN ('anyone', 'any_user')
  OR (gr.grantee = 'user' AND gr.user_id = ${userId})
  OR (gr.grantee = 'group' AND gr.group_id IN (SELECT id FROM g))
  OR (gr.grantee = 'track_owner' AND t.owner_id = ${userId})
  OR (gr.grantee = 'role' AND EXISTS (
        SELECT 1 FROM track_role_actor a
         WHERE a.track_id = t.id AND a.role_id = gr.role_id
           AND (a.user_id = ${userId} OR a.group_id IN (SELECT id FROM g))))
)`;

interface Cached<T> {
  epoch: string;
  value: T;
}

/** A small LRU: Map keeps insertion order, so the first key is the least recently used. */
class Lru<T> {
  private readonly map = new Map<string, Cached<T>>();
  constructor(private readonly size: number) {}
  get(key: string, epoch: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit || hit.epoch !== epoch) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key: string, epoch: string, value: T): void {
    this.map.delete(key);
    this.map.set(key, { epoch, value });
    if (this.map.size > this.size) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

export interface AllowedTracksOptions {
  /**
   * Site administrators only, and only for read permissions: include archived tracks (an
   * explicit search of the archive). Ignored for everyone else.
   */
  includeArchived?: boolean;
}

/** Keeps what may still be done in an archived track. */
function readOnly(permissions: Iterable<TrackPermission>): Set<TrackPermission> {
  return new Set([...permissions].filter(isReadOnlyPermission));
}

export class Authorizer {
  private readonly trackCache: Lru<ReadonlySet<TrackPermission>>;
  private readonly globalCache: Lru<ReadonlySet<GlobalPermission>>;

  constructor(
    private readonly db: Kysely<Database>,
    options: { cacheSize?: number; trackCacheSize?: number } = {},
  ) {
    this.trackCache = new Lru(options.trackCacheSize ?? options.cacheSize ?? 50_000);
    this.globalCache = new Lru(options.cacheSize ?? 50_000);
  }

  /** The workspace's current epoch; every cached answer is checked against it. */
  async epoch(workspaceId: number): Promise<string> {
    const row = await this.db
      .selectFrom('authz_epoch')
      .select('epoch')
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    return String(row?.epoch ?? '0');
  }

  /** A per-request view: reads the epoch once, then answers from the cache where it can. */
  context(workspaceId: number, principal: Principal): AuthzContext {
    return new AuthzContext(this, workspaceId, principal);
  }

  async globalPermissions(
    workspaceId: number,
    userId: number | null,
    epoch?: string,
  ): Promise<ReadonlySet<GlobalPermission>> {
    if (userId === null) return new Set();
    const at = epoch ?? (await this.epoch(workspaceId));
    const key = `${workspaceId}:${userId}`;
    const hit = this.globalCache.get(key, at);
    if (hit) return hit;
    const user = await this.db
      .selectFrom('app_user')
      .select(['is_site_admin', 'deactivated_at'])
      .where('id', '=', userId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    let result: Set<GlobalPermission>;
    if (!user || user.deactivated_at) {
      result = new Set();
    } else {
      const { rows } = await sql<{ permission: string }>`
        WITH RECURSIVE ${GROUPS_CTE(workspaceId, userId)}
        SELECT DISTINCT permission FROM global_grant
         WHERE workspace_id = ${workspaceId}
           AND (grantee = 'any_user'
                OR (grantee = 'user' AND user_id = ${userId})
                OR (grantee = 'group' AND group_id IN (SELECT id FROM g)))`.execute(this.db);
      const granted = new Set(rows.map((r) => r.permission));
      const admin = user.is_site_admin || granted.has('site_admin');
      result = new Set(GLOBAL_PERMISSIONS.filter((p) => admin || granted.has(p)));
    }
    this.globalCache.set(key, at, result);
    return result;
  }

  /** Every permission the principal holds in one track: one statement, cached by epoch. */
  async trackPermissions(
    workspaceId: number,
    principal: Principal,
    trackId: number,
    epoch?: string,
  ): Promise<ReadonlySet<TrackPermission>> {
    const at = epoch ?? (await this.epoch(workspaceId));
    const limited = principal.withoutAdminRights ? ':limited' : '';
    const key = `${workspaceId}:${principal.userId ?? 'anon'}${limited}:${trackId}`;
    const hit = this.trackCache.get(key, at);
    if (hit) return hit;
    const result = await this.computeTrackPermissions(workspaceId, principal, trackId, at);
    this.trackCache.set(key, at, result);
    return result;
  }

  private async computeTrackPermissions(
    workspaceId: number,
    principal: Principal,
    trackId: number,
    epoch: string,
  ): Promise<ReadonlySet<TrackPermission>> {
    const { userId } = principal;
    if (userId === null) {
      const { rows } = await sql<{ permission: TrackPermission; archived: boolean }>`
        SELECT DISTINCT gr.permission, t.archived_at IS NOT NULL AS archived FROM track t
          JOIN access_grant gr ON gr.policy_id = t.access_policy_id
         WHERE t.id = ${trackId} AND t.workspace_id = ${workspaceId}
           AND gr.grantee = 'anyone'`.execute(this.db);
      const held = rows.map((r) => r.permission);
      return rows[0]?.archived ? readOnly(held) : new Set(held);
    }
    const global = forPrincipal(
      await this.globalPermissions(workspaceId, userId, epoch),
      principal,
    );
    if (global.has('site_admin')) {
      const track = await this.db
        .selectFrom('track')
        .select(['id', 'archived_at'])
        .where('id', '=', trackId)
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      if (!track) return new Set();
      return track.archived_at ? new Set(ARCHIVED_TRACK_PERMISSIONS) : new Set(TRACK_PERMISSIONS);
    }
    // One round trip: the grants that match, for an active person only, plus a marker row
    // when the track exists ('' or '!archived'; configuration administrators need to know).
    // The person's roles in this track are found once, then matched against the grants.
    const { rows } = await sql<{ permission: string }>`
      WITH RECURSIVE ${GROUPS_CTE(workspaceId, userId)},
      r AS (
        SELECT role_id FROM track_role_actor a
         WHERE a.track_id = ${trackId}
           AND (a.user_id = ${userId} OR a.group_id IN (SELECT id FROM g))
      )
      SELECT DISTINCT gr.permission FROM track t
        JOIN app_user u ON u.id = ${userId} AND u.workspace_id = ${workspaceId}
                       AND u.deactivated_at IS NULL
        JOIN access_grant gr ON gr.policy_id = t.access_policy_id
       WHERE t.id = ${trackId} AND t.workspace_id = ${workspaceId}
         AND (gr.grantee IN ('anyone', 'any_user')
              OR (gr.grantee = 'user' AND gr.user_id = ${userId})
              OR (gr.grantee = 'group' AND gr.group_id IN (SELECT id FROM g))
              OR (gr.grantee = 'track_owner' AND t.owner_id = ${userId})
              OR (gr.grantee = 'role' AND gr.role_id IN (SELECT role_id FROM r)))
      UNION
      SELECT CASE WHEN t.archived_at IS NULL THEN '' ELSE '!archived' END FROM track t
        JOIN app_user u ON u.id = ${userId} AND u.deactivated_at IS NULL
       WHERE t.id = ${trackId} AND t.workspace_id = ${workspaceId}`.execute(this.db);
    const archived = rows.some((r) => r.permission === '!archived');
    const exists = archived || rows.some((r) => r.permission === '');
    const result = new Set(
      rows
        .map((r) => r.permission)
        .filter((p): p is TrackPermission => p !== '' && p !== '!archived'),
    );
    if (exists && global.has('configuration_admin')) {
      for (const p of CONFIGURATION_PERMISSIONS) result.add(p);
    }
    return archived ? readOnly(result) : result;
  }

  /**
   * The tracks where the principal holds a permission: the search pre-filter (QRY-008).
   * Archived tracks are left out (CORE-025). 'all' means no filter is needed: a site
   * administrator while no track is archived, or one who asks to include the archive.
   */
  async allowedTracks(
    workspaceId: number,
    principal: Principal,
    permission: TrackPermission = 'browse_track',
    epoch?: string,
    options: AllowedTracksOptions = {},
  ): Promise<number[] | 'all'> {
    const { userId } = principal;
    if (userId === null) {
      const { rows } = await sql<{ id: number }>`
        SELECT DISTINCT t.id FROM track t
          JOIN access_grant gr ON gr.policy_id = t.access_policy_id
         WHERE t.workspace_id = ${workspaceId} AND gr.permission = ${permission}
           AND gr.grantee = 'anyone' AND t.archived_at IS NULL
         ORDER BY t.id`.execute(this.db);
      return rows.map((r) => r.id);
    }
    const global = forPrincipal(
      await this.globalPermissions(workspaceId, userId, epoch),
      principal,
    );
    if (global.has('site_admin')) {
      if (options.includeArchived && isReadOnlyPermission(permission)) return 'all';
      const archived = await this.db
        .selectFrom('track')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('archived_at', 'is not', null)
        .limit(1)
        .executeTakeFirst();
      if (!archived) return 'all';
      const rows = await this.db
        .selectFrom('track')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('archived_at', 'is', null)
        .orderBy('id')
        .execute();
      return rows.map((r) => r.id);
    }
    if (global.size === 0) {
      // Deactivated or unknown: nothing. (Active people always hold the any_user defaults or none.)
      const active = await this.db
        .selectFrom('app_user')
        .select('id')
        .where('id', '=', userId)
        .where('workspace_id', '=', workspaceId)
        .where('deactivated_at', 'is', null)
        .executeTakeFirst();
      if (!active) return [];
    }
    const configuration =
      global.has('configuration_admin') &&
      (CONFIGURATION_PERMISSIONS as readonly string[]).includes(permission);
    if (configuration) {
      const rows = await this.db
        .selectFrom('track')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('archived_at', 'is', null)
        .orderBy('id')
        .execute();
      return rows.map((r) => r.id);
    }
    // Three set-based legs, each driven from an index (ADR-012's spike): grants to everyone, the
    // person or their groups; grants to a role the person acts in; grants to the track owner.
    const { rows } = await sql<{ id: number }>`
      WITH RECURSIVE ${GROUPS_CTE(workspaceId, userId)}
      SELECT DISTINCT id FROM (
        SELECT t.id FROM access_grant gr JOIN track t ON t.access_policy_id = gr.policy_id
         WHERE gr.permission = ${permission} AND t.workspace_id = ${workspaceId}
           AND t.archived_at IS NULL
           AND (gr.grantee IN ('anyone', 'any_user')
                OR (gr.grantee = 'user' AND gr.user_id = ${userId})
                OR (gr.grantee = 'group' AND gr.group_id IN (SELECT id FROM g)))
        UNION ALL
        SELECT t.id FROM track_role_actor a
          JOIN track t ON t.id = a.track_id
          JOIN access_grant gr ON gr.policy_id = t.access_policy_id
               AND gr.permission = ${permission} AND gr.grantee = 'role' AND gr.role_id = a.role_id
         WHERE t.workspace_id = ${workspaceId} AND t.archived_at IS NULL
           AND (a.user_id = ${userId} OR a.group_id IN (SELECT id FROM g))
        UNION ALL
        SELECT t.id FROM track t
          JOIN access_grant gr ON gr.policy_id = t.access_policy_id
               AND gr.permission = ${permission} AND gr.grantee = 'track_owner'
         WHERE t.workspace_id = ${workspaceId} AND t.owner_id = ${userId}
           AND t.archived_at IS NULL
      ) allowed
      ORDER BY id`.execute(this.db);
    return rows.map((r) => r.id);
  }

  /** IAM-012: why a person can or cannot do something in a track. */
  async explain(
    workspaceId: number,
    principal: Principal,
    trackId: number,
    permission: TrackPermission,
  ): Promise<Explanation> {
    const reasons: Reason[] = [];
    const { userId } = principal;
    const global =
      userId === null
        ? new Set<GlobalPermission>()
        : await this.globalPermissions(workspaceId, userId);
    if (global.has('site_admin')) reasons.push({ kind: 'site_admin' });
    if (global.has('configuration_admin') && CONFIGURATION_PERMISSIONS.includes(permission)) {
      reasons.push({ kind: 'configuration_admin' });
    }
    const grants = await sql<{
      id: number;
      grantee: string;
      role_id: number | null;
      role_name: string | null;
      group_id: number | null;
      group_name: string | null;
      field_key: string | null;
      matches: boolean;
    }>`
      WITH RECURSIVE ${GROUPS_CTE(workspaceId, userId ?? 0)}
      SELECT gr.id, gr.grantee, gr.role_id, r.name AS role_name, gr.group_id, ug.name AS group_name,
             gr.field_key,
             CASE WHEN ${userId === null ? sql`gr.grantee = 'anyone'` : GRANTEE_MATCHES(userId)}
                  THEN true ELSE false END AS matches
        FROM track t
        JOIN access_grant gr ON gr.policy_id = t.access_policy_id AND gr.permission = ${permission}
        LEFT JOIN role r ON r.id = gr.role_id
        LEFT JOIN user_group ug ON ug.id = gr.group_id
       WHERE t.id = ${trackId} AND t.workspace_id = ${workspaceId}
       ORDER BY gr.id`.execute(this.db);
    const active =
      userId === null ||
      (await this.db
        .selectFrom('app_user')
        .select('id')
        .where('id', '=', userId)
        .where('deactivated_at', 'is', null)
        .executeTakeFirst()) !== undefined;
    const ticketLevel: Explanation['ticketLevel'] = [];
    for (const g of grants.rows) {
      if (['requester', 'assignee', 'user_field', 'group_field'].includes(g.grantee)) {
        ticketLevel.push({ grantId: g.id, grantee: g.grantee, fieldKey: g.field_key });
      } else if (g.matches && active) {
        reasons.push({
          kind: 'grant',
          grantId: g.id,
          grantee: g.grantee,
          ...(g.role_id !== null ? { roleId: g.role_id, roleName: g.role_name ?? '' } : {}),
          ...(g.group_id !== null ? { groupId: g.group_id, groupName: g.group_name ?? '' } : {}),
        });
      }
    }
    const track = await this.db
      .selectFrom('track')
      .select('archived_at')
      .where('id', '=', trackId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    const trackArchived = Boolean(track?.archived_at);
    const allowed = reasons.length > 0 && (!trackArchived || isReadOnlyPermission(permission));
    return { allowed, trackArchived, reasons, ticketLevel };
  }
}

/** Authorization for one request: the epoch is read once and shared by every check. */
export class AuthzContext {
  private epochValue: Promise<string> | undefined;

  constructor(
    private readonly authorizer: Authorizer,
    readonly workspaceId: number,
    readonly principal: Principal,
  ) {}

  private epoch(): Promise<string> {
    this.epochValue ??= this.authorizer.epoch(this.workspaceId);
    return this.epochValue;
  }

  async global(): Promise<ReadonlySet<GlobalPermission>> {
    return forPrincipal(
      await this.authorizer.globalPermissions(
        this.workspaceId,
        this.principal.userId,
        await this.epoch(),
      ),
      this.principal,
    );
  }

  async isSiteAdmin(): Promise<boolean> {
    return (await this.global()).has('site_admin');
  }

  async hasGlobal(permission: GlobalPermission): Promise<boolean> {
    return (await this.global()).has(permission);
  }

  async track(trackId: number): Promise<ReadonlySet<TrackPermission>> {
    return this.authorizer.trackPermissions(
      this.workspaceId,
      this.principal,
      trackId,
      await this.epoch(),
    );
  }

  async can(permission: TrackPermission, trackId: number): Promise<boolean> {
    return (await this.track(trackId)).has(permission);
  }

  async allowedTracks(
    permission: TrackPermission = 'browse_track',
    options: AllowedTracksOptions = {},
  ): Promise<number[] | 'all'> {
    return this.authorizer.allowedTracks(
      this.workspaceId,
      this.principal,
      permission,
      await this.epoch(),
      options,
    );
  }
}
