import type { Database, TrackType } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Hierarchy, Level, TicketNode } from './hierarchy';

/**
 * Reading and copying the ticket configuration of a workspace (M1-007): hierarchy levels,
 * ticket types and type sets. The rules live in `hierarchy.ts`; the routes in
 * `routes/ticket-types.ts` and `routes/tracks.ts`.
 */
type Db = Kysely<Database> | Transaction<Database>;

/**
 * One hierarchy change at a time per workspace (inserting, moving or removing a level, or
 * putting a ticket type at a level), so two changes never compute ranks from the same ladder.
 * The second key keeps it apart from the group nesting lock (`routes/groups.ts`, key 1).
 */
export async function lockHierarchy(trx: Transaction<Database>, workspaceId: number) {
  await sql`SELECT pg_advisory_xact_lock(${workspaceId}, 2)`.execute(trx);
}

/**
 * The same lock, shared: ticket writes that check levels (a new ticket, a new type or parent, a
 * move, a restore) hold it until they commit, so the ladder they checked against cannot change
 * under them. Shared holders never wait for each other.
 */
export async function shareHierarchy(trx: Transaction<Database>, workspaceId: number) {
  await sql`SELECT pg_advisory_xact_lock_shared(${workspaceId}, 2)`.execute(trx);
}

/** The levels (top first) and the level of every ticket type, local ones included. */
export async function loadHierarchy(db: Db, workspaceId: number) {
  const [levels, types] = await Promise.all([
    db
      .selectFrom('hierarchy_level')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .orderBy('rank', 'desc')
      .execute(),
    db
      .selectFrom('ticket_type')
      .select(['id', 'name', 'level_id', 'owner_track_id'])
      .where('workspace_id', '=', workspaceId)
      .orderBy('id')
      .execute(),
  ]);
  const hierarchy: Hierarchy = {
    levels: levels.map((l): Level => ({ id: l.id, kind: l.kind, rank: l.rank })),
    types: types.map((t) => ({ id: t.id, levelId: t.level_id })),
  };
  return { hierarchy, levels, types };
}

/**
 * The tickets a hierarchy change is checked against: id, type and parent of every ticket of
 * the types whose level changes, with their parents and children. A link between two tickets
 * whose levels both stay cannot break, so nothing else needs reading. Tickets in the trash
 * count: they keep their links, so a restore never brings back a broken one.
 */
export async function hierarchyTickets(
  db: Db,
  workspaceId: number,
  typeIds: readonly number[],
): Promise<Map<number, TicketNode>> {
  const out = new Map<number, TicketNode>();
  if (typeIds.length === 0) return out;
  const { rows } = await sql<{ id: number; ticket_type_id: number; parent_id: number | null }>`
    WITH changed AS (
      SELECT id, ticket_type_id, parent_id FROM ticket
       WHERE workspace_id = ${workspaceId} AND ticket_type_id = ANY(${[...typeIds]}::int[]))
    SELECT id, ticket_type_id, parent_id FROM changed
    UNION
    SELECT p.id, p.ticket_type_id, p.parent_id FROM ticket p JOIN changed c ON p.id = c.parent_id
    UNION
    SELECT k.id, k.ticket_type_id, k.parent_id FROM ticket k JOIN changed c ON k.parent_id = c.id`.execute(
    db,
  );
  for (const r of rows) {
    out.set(r.id, { id: r.id, typeId: r.ticket_type_id, parentId: r.parent_id });
  }
  return out;
}

/**
 * How many tickets of these types sit in these tracks (all tracks when `trackIds` is null),
 * the trash included: a type with tickets cannot leave a set or be deleted until they are
 * mapped to another type (CORE-005 (2)).
 */
export async function ticketsOfTypes(
  db: Db,
  workspaceId: number,
  typeIds: readonly number[],
  trackIds: readonly number[] | null,
): Promise<number> {
  if (typeIds.length === 0 || trackIds?.length === 0) return 0;
  let query = db
    .selectFrom('ticket')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('workspace_id', '=', workspaceId)
    .where('ticket_type_id', 'in', [...typeIds]);
  if (trackIds !== null) query = query.where('track_id', 'in', [...trackIds]);
  const row = await query.executeTakeFirstOrThrow();
  return Number(row.n);
}

/**
 * A ticket type mapping as the API takes it: the new type of each type that leaves a track,
 * keyed by the leaving type's id (CORE-005 (2)).
 */
export const ticketTypeMapping = z
  .record(z.string().regex(/^[1-9][0-9]{0,9}$/), z.number().int().positive().max(2_147_483_647))
  .refine((m) => Object.keys(m).length <= 1000, 'at most 1,000 entries');

export type TypeMappingResult =
  | { ok: true; mapped: { fromTypeId: number; toTypeId: number; ticketCount: number }[] }
  | {
      ok: false;
      status: 409;
      body: { error: 'type_in_use'; ticketTypeIds: number[]; ticketCount: number };
    }
  | {
      ok: false;
      status: 400;
      body: {
        error: 'invalid_mapping';
        fromTypeId: number;
        toTypeId: number | null;
        problem: string;
      };
    };

/**
 * Types leave tracks (a type set drops them, or a track switches sets): their tickets in those
 * tracks, the trash included, take the types `mapping` names (CORE-005 (2)). A target must stay
 * in the tracks' types and sit at the level of the type it replaces, so no parent link changes.
 * A removed type with tickets and no mapping answers `type_in_use`. The caller holds the type
 * set or the track, so no new ticket of a removed type arrives meanwhile.
 */
export async function mapTicketTypes(
  trx: Transaction<Database>,
  workspaceId: number,
  trackIds: readonly number[],
  removed: readonly number[],
  kept: readonly number[],
  mapping: Readonly<Record<string, number>> | undefined,
  actorId: number | null,
): Promise<TypeMappingResult> {
  for (const [from, to] of Object.entries(mapping ?? {})) {
    if (!removed.includes(Number(from))) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'invalid_mapping',
          fromTypeId: Number(from),
          toTypeId: to,
          problem: 'not_removed',
        },
      };
    }
  }
  if (removed.length === 0 || trackIds.length === 0) return { ok: true, mapped: [] };
  const counts = await trx
    .selectFrom('ticket')
    .select(['ticket_type_id', (eb) => eb.fn.countAll<string>().as('n')])
    .where('workspace_id', '=', workspaceId)
    .where('track_id', 'in', [...trackIds])
    .where('ticket_type_id', 'in', [...removed])
    .groupBy('ticket_type_id')
    .orderBy('ticket_type_id')
    .execute();
  const unmapped = counts.filter((c) => mapping?.[String(c.ticket_type_id)] === undefined);
  if (unmapped.length > 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'type_in_use',
        ticketTypeIds: unmapped.map((c) => c.ticket_type_id),
        ticketCount: unmapped.reduce((n, c) => n + Number(c.n), 0),
      },
    };
  }
  const levels = new Map(
    (
      await trx
        .selectFrom('ticket_type')
        .select(['id', 'level_id'])
        .where('workspace_id', '=', workspaceId)
        .where('id', 'in', [...new Set([...removed, ...kept])])
        .execute()
    ).map((t) => [t.id, t.level_id]),
  );
  const mapped: { fromTypeId: number; toTypeId: number; ticketCount: number }[] = [];
  // One change set for the whole mapping, in each ticket's history (M1-009).
  let changeSet: string | null = null;
  for (const { ticket_type_id: from, n } of counts) {
    const to = mapping?.[String(from)] as number;
    const problem = !kept.includes(to)
      ? 'not_kept'
      : levels.get(to) !== levels.get(from)
        ? 'other_level'
        : null;
    if (problem) {
      return {
        ok: false,
        status: 400,
        body: { error: 'invalid_mapping', fromTypeId: from, toTypeId: to, problem },
      };
    }
    if (changeSet === null) {
      const { rows } = await sql<{
        n: string;
      }>`SELECT nextval('ticket_change_set_seq') AS n`.execute(trx);
      changeSet = rows[0]?.n as string;
    }
    await sql`
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, actor_id, field, from_value,
                                 to_value, from_display, to_display)
      SELECT k.workspace_id, k.id, ${changeSet}, ${actorId}, 'type', ${String(from)}, ${String(to)},
             f.name, t.name
        FROM ticket k, ticket_type f, ticket_type t
       WHERE k.workspace_id = ${workspaceId} AND k.track_id = ANY(${[...trackIds]}::int[])
         AND k.ticket_type_id = ${from} AND f.id = ${from} AND t.id = ${to}`.execute(trx);
    await trx
      .updateTable('ticket')
      .set((eb) => ({ ticket_type_id: to, version: eb('version', '+', 1), updated_at: new Date() }))
      .where('workspace_id', '=', workspaceId)
      .where('track_id', 'in', [...trackIds])
      .where('ticket_type_id', '=', from)
      .execute();
    mapped.push({ fromTypeId: from, toTypeId: to, ticketCount: Number(n) });
  }
  return { ok: true, mapped };
}

/** Ticket types with the level they sit at, as the API shows them. */
export function ticketTypeQuery(db: Db, workspaceId: number) {
  return db
    .selectFrom('ticket_type as t')
    .innerJoin('hierarchy_level as l', 'l.id', 't.level_id')
    .select([
      't.id',
      't.name',
      't.description',
      't.icon',
      't.color',
      't.level_id',
      'l.rank as level_rank',
      'l.name as level_name',
      't.owner_track_id',
      't.created_at',
      't.updated_at',
    ])
    .where('t.workspace_id', '=', workspaceId);
}
export type TicketTypeRow = Awaited<
  ReturnType<ReturnType<typeof ticketTypeQuery>['executeTakeFirstOrThrow']>
>;

export function ticketTypeView(row: TicketTypeRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    color: row.color,
    level: { id: row.level_id, rank: row.level_rank, name: row.level_name },
    trackId: row.owner_track_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The members of each set, in set order. */
export async function setMembers(
  db: Db,
  workspaceId: number,
  setIds: readonly number[],
): Promise<Map<number, TicketTypeRow[]>> {
  const out = new Map<number, TicketTypeRow[]>(setIds.map((id) => [id, []]));
  if (setIds.length === 0) return out;
  const rows = await ticketTypeQuery(db, workspaceId)
    .innerJoin('type_set_member as m', 'm.ticket_type_id', 't.id')
    .select('m.type_set_id')
    .where('m.type_set_id', 'in', [...setIds])
    .orderBy('m.type_set_id')
    .orderBy('m.sort_order')
    .execute();
  for (const { type_set_id, ...row } of rows) out.get(type_set_id)?.push(row);
  return out;
}

/** The set new tracks of this type use or copy; null in a workspace without one. */
export async function defaultTypeSetId(
  db: Db,
  workspaceId: number,
  trackType: TrackType,
): Promise<number | null> {
  const row = await db
    .selectFrom('type_set_default')
    .select('type_set_id')
    .where('workspace_id', '=', workspaceId)
    .where('track_type', '=', trackType)
    .executeTakeFirst();
  return row?.type_set_id ?? null;
}

/** A shared set of the workspace (never one that a local-mode track owns). */
export async function isSharedTypeSet(
  db: Db,
  workspaceId: number,
  typeSetId: number,
): Promise<boolean> {
  const row = await db
    .selectFrom('type_set')
    .select('id')
    .where('id', '=', typeSetId)
    .where('workspace_id', '=', workspaceId)
    .where('owner_track_id', 'is', null)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * A local-mode track's own type set: a copy of `sourceId`'s types, order and default, owned
 * by the track (section 1.1: nothing leaks to other tracks). Set names are unique per
 * workspace, so the track id is added when the plain name is already used.
 */
export async function copyTypeSet(
  trx: Transaction<Database>,
  workspaceId: number,
  sourceId: number,
  trackId: number,
  key: string,
): Promise<number> {
  const source = await trx
    .selectFrom('type_set')
    .select(['name', 'default_type_id'])
    .where('id', '=', sourceId)
    .executeTakeFirstOrThrow();
  for (const name of [`${key} local type set`, `${key} local type set ${trackId}`]) {
    const row = await trx
      .insertInto('type_set')
      .values({
        workspace_id: workspaceId,
        name,
        description: `Owned by track ${key}; copied from ${source.name}`,
        owner_track_id: trackId,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!row) continue;
    await sql`
      INSERT INTO type_set_member (workspace_id, type_set_id, ticket_type_id, sort_order)
      SELECT workspace_id, ${row.id}, ticket_type_id, sort_order
        FROM type_set_member WHERE type_set_id = ${sourceId}`.execute(trx);
    await trx
      .updateTable('type_set')
      .set({ default_type_id: source.default_type_id })
      .where('id', '=', row.id)
      .execute();
    return row.id;
  }
  throw new Error(`no free name for the local type set of track ${key}`);
}
