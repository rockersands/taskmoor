import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { holdWorkflow } from './store';

/**
 * Workflow maps (M1-028; WF-001 (3); ADR-045): which workflow a ticket uses is the one its
 * track's map gives its ticket type, or the map's default workflow for a type it does not name.
 * A track without a map of its own uses the workspace's default map.
 *
 * Lock order, as for the other configuration values: a ticket write holds its track (key
 * share), then the track's map (key share), then the workflows it reads (key share), then the
 * ticket. A change of a map holds the map (update) before it reads the tickets it affects; a
 * track's switch of map holds the track (update), then both maps and their workflows.
 */
type Db = Kysely<Database> | Transaction<Database>;

export interface WorkflowMap {
  id: number;
  name: string;
  description: string;
  isDefault: boolean;
  /** The local-mode track that owns it; null for a shared map. */
  ownerTrackId: number | null;
  defaultWorkflowId: number;
  /** Ticket type to workflow, for the types the map names. */
  entries: ReadonlyMap<number, number>;
}

/** The workflow a map gives a ticket type. */
export const workflowForType = (map: WorkflowMap, ticketTypeId: number): number =>
  map.entries.get(ticketTypeId) ?? map.defaultWorkflowId;

/** Every workflow a map names, its default first. */
export const workflowsOf = (map: WorkflowMap): number[] => [
  ...new Set([map.defaultWorkflowId, ...map.entries.values()]),
];

export async function defaultMapId(db: Db, workspaceId: number): Promise<number> {
  const row = await db
    .selectFrom('workflow_map')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('is_default', '=', true)
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The map a track uses, or undefined for a track that does not exist. */
export async function trackMapId(
  db: Db,
  workspaceId: number,
  trackId: number,
): Promise<number | undefined> {
  const track = await db
    .selectFrom('track')
    .select('workflow_map_id')
    .where('id', '=', trackId)
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (!track) return undefined;
  return track.workflow_map_id ?? defaultMapId(db, workspaceId);
}

/**
 * A map with its entries; `hold` keeps the row until the transaction ends: key share for a
 * ticket write (a change of the map waits for it), update for a change of the map.
 */
export async function loadMap(
  db: Db,
  workspaceId: number,
  mapId: number,
  hold?: 'share' | 'update',
): Promise<WorkflowMap | null> {
  const query = db
    .selectFrom('workflow_map')
    .select(['id', 'name', 'description', 'is_default', 'owner_track_id', 'default_workflow_id'])
    .where('id', '=', mapId)
    .where('workspace_id', '=', workspaceId);
  const row = await (hold === 'share'
    ? query.forKeyShare()
    : hold === 'update'
      ? query.forUpdate()
      : query
  ).executeTakeFirst();
  if (!row) return null;
  const entries = await db
    .selectFrom('workflow_map_entry')
    .select(['ticket_type_id', 'workflow_id'])
    .where('map_id', '=', mapId)
    .execute();
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isDefault: row.is_default,
    ownerTrackId: row.owner_track_id,
    defaultWorkflowId: row.default_workflow_id,
    entries: new Map(entries.map((e) => [e.ticket_type_id, e.workflow_id])),
  };
}

/** A track's map, held (key share) until the transaction ends. */
export async function holdTrackMap(
  trx: Transaction<Database>,
  workspaceId: number,
  trackId: number,
): Promise<WorkflowMap | null> {
  const mapId = await trackMapId(trx, workspaceId, trackId);
  return mapId === undefined ? null : loadMap(trx, workspaceId, mapId, 'share');
}

/** A ticket's workflow, from its track and type (the database function the trigger uses). */
export async function ticketWorkflowId(
  db: Db,
  workspaceId: number,
  trackId: number,
  ticketTypeId: number,
): Promise<number> {
  const { rows } = await sql<{ id: number | null }>`
    SELECT ticket_workflow_id(${workspaceId}, ${trackId}, ${ticketTypeId}) AS id`.execute(db);
  const id = rows[0]?.id;
  if (id == null) throw new Error(`no workflow for track ${trackId}, type ${ticketTypeId}`);
  return id;
}

/**
 * The workflow a ticket of `ticketTypeId` in `trackId` moves through, with its published
 * definition, held as a ticket write holds it: the track's map, then the workflow (key share).
 * The caller holds the track.
 */
export async function holdTicketWorkflow(
  trx: Transaction<Database>,
  workspaceId: number,
  trackId: number,
  ticketTypeId: number,
) {
  const map = await holdTrackMap(trx, workspaceId, trackId);
  if (!map) return null;
  return holdWorkflow(trx, workflowForType(map, ticketTypeId), 'share');
}

/**
 * Every workflow of a track's map, held (key share) in id order with the map: for a write that
 * learns the ticket types it needs only after it locks its tickets (a move with subtickets).
 */
export async function holdMapWorkflows(
  trx: Transaction<Database>,
  workspaceId: number,
  trackId: number,
) {
  const map = await holdTrackMap(trx, workspaceId, trackId);
  if (!map) return null;
  const held = new Map<number, NonNullable<Awaited<ReturnType<typeof holdWorkflow>>>>();
  for (const id of workflowsOf(map).sort((a, b) => a - b)) {
    const workflow = await holdWorkflow(trx, id, 'share');
    if (!workflow) return null;
    held.set(id, workflow);
  }
  const forType = (ticketTypeId: number) =>
    held.get(workflowForType(map, ticketTypeId)) as NonNullable<
      Awaited<ReturnType<typeof holdWorkflow>>
    >;
  return { map, forType };
}

/** The tracks that use a map, the default map's included, the trash too. */
export async function tracksUsingMap(
  db: Db,
  workspaceId: number,
  map: Pick<WorkflowMap, 'id' | 'isDefault'>,
): Promise<{ id: number; key: string; name: string }[]> {
  return db
    .selectFrom('track')
    .select(['id', 'key', 'name'])
    .where('workspace_id', '=', workspaceId)
    .where((eb) =>
      map.isDefault
        ? eb.or([eb('workflow_map_id', '=', map.id), eb('workflow_map_id', 'is', null)])
        : eb('workflow_map_id', '=', map.id),
    )
    .orderBy('key')
    .execute();
}

/** The maps that name a workflow, as their default or for a ticket type. */
export async function mapsNaming(
  db: Db,
  workspaceId: number,
  workflowId: number,
): Promise<{ id: number; name: string; trackId: number | null; isDefault: boolean }[]> {
  const rows = await db
    .selectFrom('workflow_map as m')
    .select(['m.id', 'm.name', 'm.owner_track_id', 'm.is_default'])
    .where('m.workspace_id', '=', workspaceId)
    .where((eb) =>
      eb.or([
        eb('m.default_workflow_id', '=', workflowId),
        eb.exists(
          eb
            .selectFrom('workflow_map_entry as e')
            .select('e.map_id')
            .whereRef('e.map_id', '=', 'm.id')
            .where('e.workflow_id', '=', workflowId),
        ),
      ]),
    )
    .orderBy('m.is_default', 'desc')
    .orderBy(sql`lower(m.name)`)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    trackId: r.owner_track_id,
    isDefault: r.is_default,
  }));
}

/** The tracks whose map names a workflow (WF-002's "used by"), the trash included. */
export async function tracksUsingWorkflow(
  db: Db,
  workspaceId: number,
  workflowId: number,
): Promise<{ id: number; key: string; name: string }[]> {
  const maps = await mapsNaming(db, workspaceId, workflowId);
  if (maps.length === 0) return [];
  const ids = maps.map((m) => m.id);
  const withDefault = maps.some((m) => m.isDefault);
  return db
    .selectFrom('track')
    .select(['id', 'key', 'name'])
    .where('workspace_id', '=', workspaceId)
    .where((eb) =>
      withDefault
        ? eb.or([eb('workflow_map_id', 'in', ids), eb('workflow_map_id', 'is', null)])
        : eb('workflow_map_id', 'in', ids),
    )
    .orderBy('key')
    .execute();
}

/**
 * The published statuses, initial status and name of workflows, by id (from the index of the
 * statuses each version uses).
 */
export async function publishedStatuses(
  db: Db,
  workflowIds: readonly number[],
): Promise<Map<number, { name: string; statuses: Set<number>; initialStatusId: number }>> {
  const out = new Map<number, { name: string; statuses: Set<number>; initialStatusId: number }>();
  if (workflowIds.length === 0) return out;
  const rows = await db
    .selectFrom('workflow as w')
    .innerJoin('workflow_version as v', (j) =>
      j.onRef('v.workflow_id', '=', 'w.id').onRef('v.version', '=', 'w.published_version'),
    )
    .select([
      'w.id',
      'w.name',
      sql<number>`(v.definition ->> 'initialStatusId')::int`.as('initial'),
      (eb) =>
        eb
          .selectFrom('workflow_version_status as s')
          .select(sql<number[]>`coalesce(array_agg(s.status_id), '{}')`.as('ids'))
          .whereRef('s.workflow_id', '=', 'w.id')
          .whereRef('s.version', '=', 'w.published_version')
          .as('statuses'),
    ])
    .where('w.id', 'in', [...new Set(workflowIds)])
    .execute();
  for (const r of rows) {
    out.set(r.id, {
      name: r.name,
      statuses: new Set(r.statuses ?? []),
      initialStatusId: r.initial,
    });
  }
  return out;
}

/**
 * Tickets of `ticketTypeIds` in `trackIds` whose status the workflow their track's map gives
 * their type lacks take that workflow's initial status, with a history row in `changeSet`:
 * for writes that give many tickets another type at once (a type set change, CORE-005 (2)),
 * as a single move does without a status asked for. The caller holds the tracks; this holds
 * their maps and workflows. Returns how many tickets moved.
 */
export async function fitStatuses(
  trx: Transaction<Database>,
  workspaceId: number,
  actorId: number | null,
  trackIds: readonly number[],
  ticketTypeIds: readonly number[],
  changeSet: string,
): Promise<number> {
  if (trackIds.length === 0 || ticketTypeIds.length === 0) return 0;
  for (const trackId of [...new Set(trackIds)].sort((a, b) => a - b)) {
    await holdMapWorkflows(trx, workspaceId, trackId);
  }
  const { rows } = await sql<{ id: number }>`
    WITH lost AS (
      SELECT k.id, k.status_id AS from_status,
             (v.definition ->> 'initialStatusId')::int AS to_status
        FROM ticket k
        JOIN workflow w ON w.id = ticket_workflow_id(k.workspace_id, k.track_id, k.ticket_type_id)
        JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
       WHERE k.workspace_id = ${workspaceId}
         AND k.track_id = ANY(${[...trackIds]}::int[])
         AND k.ticket_type_id = ANY(${[...ticketTypeIds]}::int[])
         AND NOT EXISTS (SELECT 1 FROM workflow_version_status s
                          WHERE s.workflow_id = w.id AND s.version = w.published_version
                            AND s.status_id = k.status_id)
    ), moved AS (
      UPDATE ticket k SET status_id = l.to_status
        FROM lost l
       WHERE k.id = l.id
      RETURNING k.id, l.from_status, l.to_status
    )
    INSERT INTO ticket_change (workspace_id, ticket_id, change_set, actor_id, field, from_value,
                               to_value, from_display, to_display)
    SELECT ${workspaceId}::int, m.id, ${changeSet}::bigint, ${actorId}::int, 'status',
           m.from_status::text, m.to_status::text, f.name, t.name
      FROM moved m
      JOIN status f ON f.id = m.from_status
      JOIN status t ON t.id = m.to_status
    RETURNING ticket_id AS id`.execute(trx);
  return rows.length;
}
