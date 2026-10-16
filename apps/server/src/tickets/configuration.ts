import type { Database, TrackType } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
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
 * The tickets a hierarchy change is checked against: id, type and parent. There are no
 * tickets before M1-008, which reads them here from the ticket table.
 */
export async function hierarchyTickets(
  _db: Db,
  _workspaceId: number,
): Promise<Map<number, TicketNode>> {
  return new Map();
}

/**
 * How many tickets of these types sit in these tracks (all tracks when `trackIds` is null):
 * a type with tickets cannot leave a set or be deleted until they are mapped to another type
 * (CORE-005 (2)). Zero until M1-008 adds tickets and counts them here.
 */
export async function ticketsOfTypes(
  _db: Db,
  _workspaceId: number,
  _typeIds: readonly number[],
  _trackIds: readonly number[] | null,
): Promise<number> {
  return 0;
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
