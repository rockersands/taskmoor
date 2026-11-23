import type { GranteeKind } from '@taskmoor/db';
import { type RawBuilder, sql } from 'kysely';
import type { TrackPermission } from './permissions';

/**
 * Who sees which ticket (M1-020; IAM-010, IAM-011, ADR-012): visibility levels and the
 * ticket-level grantees of access policies, judged one ticket at a time.
 *
 * A ticket is seen by a person who may browse its track, either for the whole track or through
 * a ticket-level grant (requester, assignee, a user or group field), and who is a member of the
 * ticket's visibility level when it has one. Levels apply to everyone, site administrators
 * included: a hidden ticket is hidden from all but its level's members. What a person may do
 * to a ticket they see is what they hold in its track plus the ticket-level grants it matches.
 *
 * The same rules are written twice: `memberOf` and `ticketGrantsHeld` judge one row in memory,
 * and `TicketFilter.sql` is the predicate lists put in their statement, so a page is never
 * filtered after the fact (QRY-008). A property test keeps the two in agreement.
 */

/** What a ticket's visibility and ticket-level grants are judged on. */
export interface TicketAccessRow {
  id: number;
  track_id: number;
  requester_id: number | null;
  assignee_id: number | null;
  visibility_level_id: number | null;
  /** Custom values by field id (`fields/types.ts` forms): ids for user and group fields. */
  fields: Readonly<Record<string, unknown>>;
}

export interface Member {
  grantee: GranteeKind;
  role_id: number | null;
  group_id: number | null;
  user_id: number | null;
  field_key: string | null;
}

export const TICKET_GRANTEES = ['requester', 'assignee', 'user_field', 'group_field'] as const;
export type TicketGrantee = (typeof TICKET_GRANTEES)[number];
export const isTicketGrantee = (g: string): g is TicketGrantee =>
  (TICKET_GRANTEES as readonly string[]).includes(g);

/** A grant of a track permission to a ticket-level grantee. */
export interface TicketGrant {
  permission: TrackPermission;
  grantee: TicketGrantee;
  field_key: string | null;
}

/** The person a ticket is judged for. */
export interface Viewer {
  /** Null for anonymous visitors. */
  userId: number | null;
  /** Signed in with an active account. */
  active: boolean;
  /** Every group they are in, nested ones included. */
  groups: ReadonlySet<number>;
}

const CUSTOM_KEY = /^cf\[(\d{1,10})\]$/;
/** Field ids are 32-bit integers; a larger one names no field (and the database refuses it). */
const MAX_FIELD_ID = 2_147_483_647;

/** The field id of a user or group field grantee (`cf[12]`); null for anything else. */
export function fieldIdOf(fieldKey: string | null): number | null {
  const m = fieldKey === null ? null : CUSTOM_KEY.exec(fieldKey);
  const id = m ? Number(m[1]) : null;
  return id !== null && id <= MAX_FIELD_ID ? id : null;
}

/** Whether a ticket's user or group field holds one of `ids`. */
export function fieldHolds(
  fields: Readonly<Record<string, unknown>>,
  fieldKey: string | null,
  ids: ReadonlySet<number>,
): boolean {
  const id = fieldIdOf(fieldKey);
  if (id === null) return false;
  const value = fields[String(id)];
  if (typeof value === 'number') return ids.has(value);
  return Array.isArray(value) && value.some((v) => typeof v === 'number' && ids.has(v));
}

/** Members that need no track and no ticket to decide. */
const TRACK_FREE = new Set<GranteeKind>(['anyone', 'any_user', 'user', 'group']);

/** Whether a member that needs no track or ticket includes the viewer. */
function freeMemberIncludes(m: Member, viewer: Viewer): boolean {
  if (m.grantee === 'anyone') return true;
  if (!viewer.active || viewer.userId === null) return false;
  if (m.grantee === 'any_user') return true;
  if (m.grantee === 'user') return m.user_id === viewer.userId;
  return m.grantee === 'group' && m.group_id !== null && viewer.groups.has(m.group_id);
}

/**
 * Whether the viewer is a member of a ticket's level. `roles` are the viewer's roles in the
 * ticket's track and `ownerId` its owner; both are asked for only when a member needs them.
 */
export async function memberOf(
  members: readonly Member[],
  viewer: Viewer,
  row: TicketAccessRow,
  track: { roles: () => Promise<ReadonlySet<number>>; ownerId: () => Promise<number | null> },
): Promise<boolean> {
  for (const m of members) {
    if (TRACK_FREE.has(m.grantee)) {
      if (freeMemberIncludes(m, viewer)) return true;
      continue;
    }
    const userId = viewer.active ? viewer.userId : null;
    if (userId === null) continue;
    switch (m.grantee) {
      case 'requester':
        if (row.requester_id === userId) return true;
        break;
      case 'assignee':
        if (row.assignee_id === userId) return true;
        break;
      case 'user_field':
        if (fieldHolds(row.fields, m.field_key, new Set([userId]))) return true;
        break;
      case 'group_field':
        if (fieldHolds(row.fields, m.field_key, viewer.groups)) return true;
        break;
      case 'track_owner':
        if ((await track.ownerId()) === userId) return true;
        break;
      case 'role':
        if (m.role_id !== null && (await track.roles()).has(m.role_id)) return true;
        break;
    }
  }
  return false;
}

/** The permissions a ticket's own grantees give the viewer on it. */
export function ticketGrantsHeld(
  grants: readonly TicketGrant[],
  viewer: Viewer,
  row: TicketAccessRow,
): Set<TrackPermission> {
  const held = new Set<TrackPermission>();
  const userId = viewer.active ? viewer.userId : null;
  if (userId === null) return held;
  for (const g of grants) {
    if (held.has(g.permission)) continue;
    const matches =
      (g.grantee === 'requester' && row.requester_id === userId) ||
      (g.grantee === 'assignee' && row.assignee_id === userId) ||
      (g.grantee === 'user_field' && fieldHolds(row.fields, g.field_key, new Set([userId]))) ||
      (g.grantee === 'group_field' && fieldHolds(row.fields, g.field_key, viewer.groups));
    if (matches) held.add(g.permission);
  }
  return held;
}

/** A SQL test that ticket `k`'s field holds one of `ids` (as `fieldHolds` reads it). */
function fieldHoldsSql(fieldKey: string, ids: readonly number[]): RawBuilder<boolean> {
  const id = fieldIdOf(fieldKey);
  if (id === null || ids.length === 0) return sql<boolean>`false`;
  const value = sql`k.fields -> ${String(id)}`;
  return sql<boolean>`EXISTS (SELECT 1 FROM unnest(${[...ids]}::int[]) AS h(id)
    WHERE ${value} = to_jsonb(h.id) OR ${value} @> jsonb_build_array(h.id))`;
}

const or = (parts: RawBuilder<boolean>[]): RawBuilder<boolean> =>
  parts.length === 0 ? sql<boolean>`false` : sql<boolean>`(${sql.join(parts, sql` OR `)})`;
const ids = (values: Iterable<number>) => [...new Set(values)].sort((a, b) => a - b);

/** The condition, on ticket `k`, that one member who needs the track or ticket matches. */
function memberSql(m: Member, userId: number, groups: readonly number[]): RawBuilder<boolean> {
  switch (m.grantee) {
    case 'requester':
      return sql<boolean>`k.requester_id = ${userId}`;
    case 'assignee':
      return sql<boolean>`k.assignee_id = ${userId}`;
    case 'user_field':
      return fieldHoldsSql(m.field_key ?? '', [userId]);
    case 'group_field':
      return fieldHoldsSql(m.field_key ?? '', groups);
    case 'track_owner':
      return sql<boolean>`EXISTS (SELECT 1 FROM track o
        WHERE o.id = k.track_id AND o.owner_id = ${userId})`;
    case 'role':
      return sql<boolean>`EXISTS (SELECT 1 FROM track_role_actor a
        WHERE a.track_id = k.track_id AND a.role_id = ${m.role_id}
          AND (a.user_id = ${userId} OR a.group_id = ANY(${[...groups]}::int[])))`;
    default:
      return sql<boolean>`false`;
  }
}

/**
 * The level part of the predicate: ticket `k` has no level, or one whose members include the
 * viewer. Levels the viewer belongs to whatever the ticket are listed once; the rest add a
 * condition per kind of member that depends on the ticket.
 */
export function levelSql(
  levels: ReadonlyMap<number, readonly Member[]>,
  viewer: Viewer,
): RawBuilder<boolean> {
  const always: number[] = [];
  // Conditions keyed by member, each with the levels it opens.
  const conditional = new Map<string, { member: Member; levels: number[] }>();
  const userId = viewer.active ? viewer.userId : null;
  for (const [levelId, members] of levels) {
    if (members.some((m) => TRACK_FREE.has(m.grantee) && freeMemberIncludes(m, viewer))) {
      always.push(levelId);
      continue;
    }
    if (userId === null) continue;
    for (const m of members) {
      if (TRACK_FREE.has(m.grantee)) continue;
      const key = `${m.grantee}:${m.role_id ?? ''}:${m.field_key ?? ''}`;
      const entry = conditional.get(key) ?? { member: m, levels: [] };
      entry.levels.push(levelId);
      conditional.set(key, entry);
    }
  }
  const parts: RawBuilder<boolean>[] = [sql<boolean>`k.visibility_level_id IS NULL`];
  if (always.length > 0) {
    parts.push(sql<boolean>`k.visibility_level_id = ANY(${ids(always)}::int[])`);
  }
  if (userId !== null) {
    const groups = ids(viewer.groups);
    for (const { member, levels: opened } of conditional.values()) {
      parts.push(
        sql<boolean>`(k.visibility_level_id = ANY(${ids(opened)}::int[])
          AND ${memberSql(member, userId, groups)})`,
      );
    }
  }
  return or(parts);
}

/**
 * The browse part: ticket `k` is in a track the viewer browses, or in one whose policy lets
 * one of the ticket's own grantees browse and the viewer is that grantee.
 */
export function browseSql(
  browse: readonly number[] | 'all',
  ticketBrowse: ReadonlyMap<number, readonly TicketGrant[]>,
  viewer: Viewer,
): RawBuilder<boolean> {
  if (browse === 'all') return sql<boolean>`true`;
  const parts: RawBuilder<boolean>[] = [];
  if (browse.length > 0) parts.push(sql<boolean>`k.track_id = ANY(${ids(browse)}::int[])`);
  const userId = viewer.active ? viewer.userId : null;
  if (userId !== null) {
    const seen = new Set(browse);
    const byGrant = new Map<string, { grant: TicketGrant; tracks: number[] }>();
    for (const [trackId, grants] of ticketBrowse) {
      if (seen.has(trackId)) continue;
      for (const g of grants) {
        const key = `${g.grantee}:${g.field_key ?? ''}`;
        const entry = byGrant.get(key) ?? { grant: g, tracks: [] };
        entry.tracks.push(trackId);
        byGrant.set(key, entry);
      }
    }
    const groups = ids(viewer.groups);
    for (const { grant, tracks } of byGrant.values()) {
      const member: Member = {
        grantee: grant.grantee,
        role_id: null,
        group_id: null,
        user_id: null,
        field_key: grant.field_key,
      };
      parts.push(
        sql<boolean>`(k.track_id = ANY(${ids(tracks)}::int[])
          AND ${memberSql(member, userId, groups)})`,
      );
    }
  }
  return or(parts);
}

/** What lists put in their statement for a viewer: the browse and level parts together. */
export interface TicketFilter {
  /** True for a ticket row `k` the viewer may see. */
  sql: RawBuilder<boolean>;
  /** Only the level part, for lists whose tracks are chosen by another permission. */
  level: RawBuilder<boolean>;
  /** The tracks with tickets the viewer may see; 'all' for every track. */
  tracks: readonly number[] | 'all';
}
