import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { changesOf, recordChanges } from './history';
import { loadTickets } from './store';

/**
 * Ticket fields that point at the workspace's lists or the track's objects (M1-014;
 * CORE-014 to CORE-017): priority, close reason, labels, target and found-in releases, areas.
 * The routes check values here and write them with the ticket.
 */
type Db = Kysely<Database> | Transaction<Database>;

export const LABEL_MAX = 255;
export const LABELS_PER_TICKET = 100;
export const RELEASES_PER_TICKET = 100;
export const AREAS_PER_TICKET = 50;

export type LabelProblem = 'invalid' | 'too_long' | 'too_many';

/**
 * Labels as a ticket keeps them: trimmed, without repeats, in the order given. A label is one
 * word (no spaces), so a list of them reads as one line.
 */
export function checkLabels(
  labels: readonly string[],
): { ok: true; labels: string[] } | { ok: false; problem: LabelProblem } {
  const out: string[] = [];
  for (const raw of labels) {
    const label = raw.trim();
    const control = [...label].some((c) => (c.codePointAt(0) as number) < 0x20);
    if (label === '' || /\s/.test(label) || control) {
      return { ok: false, problem: 'invalid' };
    }
    if ([...label].length > LABEL_MAX) return { ok: false, problem: 'too_long' };
    if (!out.includes(label)) out.push(label);
  }
  if (out.length > LABELS_PER_TICKET) return { ok: false, problem: 'too_many' };
  return { ok: true, labels: out };
}

/** Adds labels to the workspace's vocabulary, for autocomplete. */
export async function rememberLabels(
  trx: Transaction<Database>,
  workspaceId: number,
  labels: readonly string[],
): Promise<void> {
  if (labels.length === 0) return;
  await trx
    .insertInto('label')
    .values(labels.map((name) => ({ workspace_id: workspaceId, name })))
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/** The priority set a track offers: its own, or the workspace's default set. */
export async function trackPrioritySet(
  db: Db,
  workspaceId: number,
  trackId: number,
): Promise<{ id: number; defaultPriorityId: number | null; priorityIds: Set<number> } | null> {
  const set = await db
    .selectFrom('priority_set as s')
    .select(['s.id', 's.default_priority_id'])
    .where('s.workspace_id', '=', workspaceId)
    .where((eb) =>
      eb.or([
        eb('s.id', '=', eb.selectFrom('track').select('priority_set_id').where('id', '=', trackId)),
        eb.and([
          eb('s.is_default', '=', true),
          eb.not(
            eb.exists(
              eb
                .selectFrom('track')
                .select('id')
                .where('id', '=', trackId)
                .where('priority_set_id', 'is not', null),
            ),
          ),
        ]),
      ]),
    )
    .executeTakeFirst();
  if (!set) return null;
  const members = await db
    .selectFrom('priority_set_member')
    .select('priority_id')
    .where('priority_set_id', '=', set.id)
    .execute();
  return {
    id: set.id,
    defaultPriorityId: set.default_priority_id,
    priorityIds: new Set(members.map((m) => m.priority_id)),
  };
}

/** A release or an area a ticket write points at, as it is now. */
interface HeldValue {
  trackId: number;
  archived: boolean;
}

/**
 * Holds (key share) the priority, close reason, releases and areas a ticket write points at,
 * until the transaction ends, so none is deleted or merged under it: those changes lock the
 * value first and its tickets after, and ticket writes take these locks before the ticket's.
 * Returns what exists in the workspace.
 */
export async function holdValues(
  trx: Transaction<Database>,
  workspaceId: number,
  values: {
    priorityId?: number | null | undefined;
    closeReasonId?: number | null | undefined;
    releaseIds?: readonly number[] | undefined;
    areaIds?: readonly number[] | undefined;
  },
): Promise<{
  priority: boolean;
  closeReason: boolean;
  releases: Map<number, HeldValue>;
  areas: Map<number, HeldValue>;
}> {
  const out = {
    priority: false,
    closeReason: false,
    releases: new Map<number, HeldValue>(),
    areas: new Map<number, HeldValue>(),
  };
  if (values.priorityId != null) {
    const row = await trx
      .selectFrom('priority')
      .select('id')
      .where('id', '=', values.priorityId)
      .where('workspace_id', '=', workspaceId)
      .forKeyShare()
      .executeTakeFirst();
    out.priority = row !== undefined;
  }
  if (values.closeReasonId != null) {
    const row = await trx
      .selectFrom('close_reason')
      .select('id')
      .where('id', '=', values.closeReasonId)
      .where('workspace_id', '=', workspaceId)
      .forKeyShare()
      .executeTakeFirst();
    out.closeReason = row !== undefined;
  }
  for (const [table, ids, into] of [
    ['release', values.releaseIds ?? [], out.releases],
    ['area', values.areaIds ?? [], out.areas],
  ] as const) {
    if (ids.length === 0) continue;
    const rows = await trx
      .selectFrom(table)
      .select(['id', 'track_id', 'archived_at'])
      .where('id', 'in', [...new Set(ids)])
      .where('workspace_id', '=', workspaceId)
      .orderBy('id')
      .forKeyShare()
      .execute();
    for (const r of rows) into.set(r.id, { trackId: r.track_id, archived: r.archived_at !== null });
  }
  return out;
}

/**
 * Why a ticket in `trackId` may not point at these releases or areas, or null when it may:
 * each must be the track's own, and those it does not have yet must not be archived (one it
 * keeps may be).
 */
export function placementOf(
  held: ReadonlyMap<number, HeldValue>,
  trackId: number,
  ids: readonly number[],
  current: readonly number[],
): 'not_in_track' | 'archived' | null {
  for (const id of ids) {
    const value = held.get(id);
    if (!value || value.trackId !== trackId) return 'not_in_track';
    if (value.archived && !current.includes(id)) return 'archived';
  }
  return null;
}

/** The same ids, whatever their order. */
export function sameIds(a: readonly number[], b: readonly number[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * Rewrites tickets for an administrator's change (a value replaced, merged or removed, open
 * tickets moved to another release): locks them in id order, applies the change a slice at a
 * time, counts a new version for each and records their history as one change set. The caller
 * holds the value first, so no ticket starts pointing at it meanwhile. Returns the number of
 * tickets.
 */
export async function rewriteTickets(
  trx: Transaction<Database>,
  workspaceId: number,
  actorId: number | null,
  ticketIds: readonly number[],
  apply: (ids: number[]) => Promise<void>,
): Promise<number> {
  const all = [...new Set(ticketIds)].sort((a, b) => a - b);
  let changeSet: string | null = null;
  for (let i = 0; i < all.length; i += REWRITE_SLICE) {
    const ids = all.slice(i, i + REWRITE_SLICE);
    await trx
      .selectFrom('ticket')
      .select('id')
      .where('id', 'in', ids)
      .orderBy('id')
      .forUpdate()
      .execute();
    const before = await loadTickets(trx, workspaceId, ids);
    await apply(ids);
    await trx
      .updateTable('ticket')
      .set((eb) => ({ version: eb('version', '+', 1), updated_at: new Date() }))
      .where('id', 'in', ids)
      .execute();
    const changes = changesOf(before, await loadTickets(trx, workspaceId, ids));
    changeSet = (await recordChanges(trx, workspaceId, actorId, changes, changeSet)) ?? changeSet;
  }
  return all.length;
}
const REWRITE_SLICE = 1000;

/** Replaces a ticket's releases of one role. */
export async function setTicketReleases(
  trx: Transaction<Database>,
  workspaceId: number,
  ticketId: number,
  role: 'target' | 'found',
  releaseIds: readonly number[],
): Promise<void> {
  await trx
    .deleteFrom('ticket_release')
    .where('ticket_id', '=', ticketId)
    .where('role', '=', role)
    .execute();
  if (releaseIds.length === 0) return;
  await trx
    .insertInto('ticket_release')
    .values(
      [...new Set(releaseIds)].map((release_id) => ({
        workspace_id: workspaceId,
        ticket_id: ticketId,
        release_id,
        role,
      })),
    )
    .execute();
}

/** Replaces a ticket's areas. */
export async function setTicketAreas(
  trx: Transaction<Database>,
  workspaceId: number,
  ticketId: number,
  areaIds: readonly number[],
): Promise<void> {
  await trx.deleteFrom('ticket_area').where('ticket_id', '=', ticketId).execute();
  if (areaIds.length === 0) return;
  await trx
    .insertInto('ticket_area')
    .values(
      [...new Set(areaIds)].map((area_id) => ({
        workspace_id: workspaceId,
        ticket_id: ticketId,
        area_id,
      })),
    )
    .execute();
}

/**
 * The assignee a new ticket without one gets from its areas (CORE-015 (1)): the first area,
 * in the order given, whose rule names someone: its owner, or the track's owner.
 */
export async function areaDefaultAssignee(
  db: Db,
  trackId: number,
  areaIds: readonly number[],
): Promise<number | null> {
  if (areaIds.length === 0) return null;
  const rows = await db
    .selectFrom('area as a')
    .innerJoin('track as t', 't.id', 'a.track_id')
    .select(['a.id', 'a.owner_id', 'a.default_assignee', 't.owner_id as track_owner_id'])
    .where('a.track_id', '=', trackId)
    .where('a.id', 'in', [...areaIds])
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of areaIds) {
    const area = byId.get(id);
    if (!area) continue;
    if (area.default_assignee === 'area_owner' && area.owner_id !== null) return area.owner_id;
    if (area.default_assignee === 'track_owner' && area.track_owner_id !== null) {
      return area.track_owner_id;
    }
  }
  return null;
}

/**
 * One change at a time to a workspace's ordered list, so two never take the same position.
 * Keys 3 and 4 sit beside the group nesting (1) and hierarchy (2) locks.
 */
export async function lockList(
  trx: Transaction<Database>,
  workspaceId: number,
  list: 'priority' | 'close_reason',
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${workspaceId}, ${list === 'priority' ? 3 : 4})`.execute(
    trx,
  );
}

/** Writes a gapless order: each id takes its position from 1. */
export async function writeOrder(
  trx: Transaction<Database>,
  table: 'priority' | 'close_reason' | 'release',
  ids: readonly number[],
): Promise<void> {
  if (ids.length === 0) return;
  await sql`
    UPDATE ${sql.table(table)} AS t SET sort_order = o.position, updated_at = now()
      FROM unnest(${[...ids]}::int[]) WITH ORDINALITY AS o (id, position)
     WHERE t.id = o.id`.execute(trx);
}
