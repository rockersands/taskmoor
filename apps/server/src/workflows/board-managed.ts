import type { Database, StatusStage } from '@taskmoor/db';
import { sql, type Transaction } from 'kysely';
import type { Column } from '../boards/model';
import { lockList } from '../tickets/fields';
import { loadMap, trackMapId } from './maps';
import { runningMigration } from './migration';
import type { Transition, WorkflowDefinition } from './model';
import { loadDefinition, remapStatuses, ticketsInStatuses, writeVersion } from './store';

/**
 * Board-managed workflows (M1-126; WF-010; spec 01a section 3.6; ADR-079). A board of a
 * local-mode track can manage its track's workflow: each column is one status, in order; any
 * card moves to any column; the rightmost column closes a ticket as Completed and leaving it
 * clears the close reason. The workflow stays an ordinary versioned workflow, which the board
 * rewrites and publishes whenever its columns change:
 *
 * - one global transition per column, named after it, from any status to the column's status;
 * - the rightmost column's transition sets the close reason Completed (made when the workspace
 *   has none), the others clear it;
 * - a column without a status gets one named after it (an existing status of that name, or a
 *   new one: the first column's stage is new, the rightmost's closed, the rest active);
 * - tickets in a status the columns drop go to the leftmost column's status, or where the
 *   caller says.
 */
export type BoardWorkflowProblem =
  | 'not_a_track_board'
  | 'shared_mode_track'
  | 'per_type_workflows'
  | 'shared_workflow'
  | 'one_status_per_column'
  | 'migration_running';

/**
 * What a board did to its workflow, for its one event (`board.updated`): a mutation emits one
 * event (M1-005), so the statuses, the workflow version and the moved tickets are told there.
 */
export interface BoardWorkflowChange {
  workflowId: number;
  version: number;
  createdWorkflow: boolean;
  createdStatusIds: number[];
  removedStatusIds: number[];
  ticketsMoved: number;
}

export class BoardWorkflowError extends Error {
  constructor(readonly problem: BoardWorkflowProblem) {
    super(problem);
  }
}

type Trx = Transaction<Database>;
interface Actor {
  workspaceId: number;
  actorId: number | null;
}

/**
 * The track's own map and the workflow it gives every type: null when that is still a shared
 * workflow (a new local-mode track starts on the workspace's default), which the board then
 * replaces with one of the track's own.
 */
export async function trackWorkflow(
  trx: Trx,
  ws: number,
  trackId: number | null,
): Promise<{ mapId: number; workflowId: number | null; sharedWorkflowId: number }> {
  if (trackId === null) throw new BoardWorkflowError('not_a_track_board');
  const track = await trx
    .selectFrom('track')
    .select('mode')
    .where('id', '=', trackId)
    .where('workspace_id', '=', ws)
    .executeTakeFirst();
  if (!track) throw new BoardWorkflowError('not_a_track_board');
  if (track.mode !== 'local') throw new BoardWorkflowError('shared_mode_track');
  const mapId = await trackMapId(trx, ws, trackId);
  const map = mapId === undefined ? null : await loadMap(trx, ws, mapId, 'update');
  if (!map || map.ownerTrackId !== trackId) throw new BoardWorkflowError('shared_workflow');
  if ([...map.entries.values()].some((w) => w !== map.defaultWorkflowId)) {
    throw new BoardWorkflowError('per_type_workflows');
  }
  const workflow = await trx
    .selectFrom('workflow')
    .select('owner_track_id')
    .where('id', '=', map.defaultWorkflowId)
    .executeTakeFirstOrThrow();
  return {
    mapId: map.id,
    workflowId: workflow.owner_track_id === trackId ? map.defaultWorkflowId : null,
    sharedWorkflowId: map.defaultWorkflowId,
  };
}

/**
 * Gives a local-mode track a workflow of its own with `definition`, as its map's default, and
 * moves the track's tickets whose status it lacks: to `mapping`'s status, or the initial one.
 */
async function adoptWorkflow(
  trx: Trx,
  by: Actor,
  trackId: number,
  mapId: number,
  previousWorkflowId: number,
  definition: WorkflowDefinition,
  mapping: ReadonlyMap<number, number>,
): Promise<{ workflowId: number; ticketCount: number }> {
  const name = 'Board workflow';
  const created = await trx
    .insertInto('workflow')
    .values({
      workspace_id: by.workspaceId,
      name,
      description: '',
      owner_track_id: trackId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await writeVersion(trx, by.workspaceId, created.id, 1, definition, by.actorId, true);
  const kept = new Set(definition.statuses.map((s) => s.statusId));
  const { rows } = await sql<{ id: number; status_id: number }>`
    SELECT id, status_id FROM ticket
     WHERE workspace_id = ${by.workspaceId} AND track_id = ${trackId}
     ORDER BY id FOR UPDATE`.execute(trx);
  const tickets = new Map<number, number[]>();
  const used = new Map<number, number>();
  for (const row of rows) {
    if (kept.has(row.status_id)) continue;
    tickets.set(row.status_id, [...(tickets.get(row.status_id) ?? []), row.id]);
    const target = mapping.get(row.status_id);
    used.set(
      row.status_id,
      target !== undefined && kept.has(target) ? target : definition.initialStatusId,
    );
  }
  const ticketCount = await remapStatuses(trx, by.workspaceId, by.actorId, tickets, used);
  await trx
    .updateTable('workflow_map')
    .set({ default_workflow_id: created.id, updated_at: new Date() })
    .where('id', '=', mapId)
    .execute();
  await trx.deleteFrom('workflow_map_entry').where('map_id', '=', mapId).execute();
  return { workflowId: created.id, ticketCount };
}

const stageAt = (index: number, count: number): StatusStage =>
  index === count - 1 && count > 1 ? 'closed' : index === 0 ? 'new' : 'active';

/**
 * The columns with exactly one status each: a column that names none gets one named after it.
 * When `collapse` is set (turning management on), a column with several keeps its first and the
 * rest are mapped to it; otherwise several are refused.
 */
export async function columnsWithStatuses(
  trx: Trx,
  by: Actor,
  columns: readonly Column[],
  collapse: boolean,
): Promise<{ columns: Column[]; merged: Map<number, number>; made: number[] }> {
  const merged = new Map<number, number>();
  const made: number[] = [];
  const out: Column[] = [];
  const named = columns.filter((c) => c.statusIds.length === 0);
  if (named.length > 0) await lockList(trx, by.workspaceId, 'status');
  for (const [index, column] of columns.entries()) {
    if (column.statusIds.length > 1 && !collapse) {
      throw new BoardWorkflowError('one_status_per_column');
    }
    const [first, ...rest] = column.statusIds;
    if (first !== undefined) {
      for (const other of rest) merged.set(other, first);
      out.push({ ...column, statusIds: [first] });
      continue;
    }
    const existing = await trx
      .selectFrom('status')
      .select('id')
      .where('workspace_id', '=', by.workspaceId)
      .where(sql`lower(name)`, '=', column.name.toLowerCase())
      .executeTakeFirst();
    let statusId = existing?.id;
    if (statusId === undefined) {
      const last = await trx
        .selectFrom('status')
        .select(sql<number>`coalesce(max(sort_order), 0)`.as('n'))
        .where('workspace_id', '=', by.workspaceId)
        .executeTakeFirstOrThrow();
      const stage = stageAt(index, columns.length);
      const created = await trx
        .insertInto('status')
        .values({
          workspace_id: by.workspaceId,
          name: column.name,
          description: '',
          stage,
          sort_order: Number(last.n) + 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      statusId = created.id;
      made.push(statusId);
    }
    out.push({ ...column, statusIds: [statusId] });
  }
  const seen = new Set<number>();
  for (const column of out) {
    const id = column.statusIds[0] as number;
    if (seen.has(id)) throw new BoardWorkflowError('one_status_per_column');
    seen.add(id);
  }
  return { columns: out, merged, made };
}

/** The workspace's close reason Completed, made when there is none. */
export async function completedReasonId(trx: Trx, by: Actor): Promise<number> {
  const found = await trx
    .selectFrom('close_reason')
    .select('id')
    .where('workspace_id', '=', by.workspaceId)
    .where(sql`lower(name)`, '=', 'completed')
    .executeTakeFirst();
  if (found) return found.id;
  await lockList(trx, by.workspaceId, 'close_reason');
  const last = await trx
    .selectFrom('close_reason')
    .select(sql<number>`coalesce(max(sort_order), 0)`.as('n'))
    .where('workspace_id', '=', by.workspaceId)
    .executeTakeFirstOrThrow();
  const created = await trx
    .insertInto('close_reason')
    .values({
      workspace_id: by.workspaceId,
      name: 'Completed',
      sort_order: Number(last.n) + 1,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return created.id;
}

/** The definition a board's columns make (spec 01a section 3.6). */
export function boardDefinition(
  boardId: number,
  columns: readonly Column[],
  completedId: number,
  keep?: Pick<WorkflowDefinition, 'onCreate' | 'statusPermissions'>,
): WorkflowDefinition {
  const statusIds = columns.map((c) => c.statusIds[0] as number);
  const last = statusIds.length - 1;
  const transitions: Transition[] = columns.map((column, index) => ({
    // The status id names its transition, so it stays the same while the column does.
    id: statusIds[index] as number,
    name: column.name,
    from: 'any',
    to: statusIds[index] as number,
    effects:
      index === last && last > 0
        ? [{ type: 'update-system-field', field: 'close-reason', value: String(completedId) }]
        : [{ type: 'clear-field', field: 'close-reason' }],
  }));
  return {
    initialStatusId: statusIds[0] as number,
    statuses: statusIds.map((statusId) => ({ statusId })),
    transitions,
    ...(keep?.onCreate ? { onCreate: keep.onCreate } : {}),
    ...(keep?.statusPermissions
      ? {
          statusPermissions: Object.fromEntries(
            Object.entries(keep.statusPermissions).filter(([s]) => statusIds.includes(Number(s))),
          ),
        }
      : {}),
    board: { boardId, columns: statusIds },
  };
}

/**
 * Writes and publishes the next version of the workflow with `definition`, moving the tickets
 * of every status it drops: to `mapping`'s status, or to the definition's initial status.
 */
export async function publishBoardVersion(
  trx: Trx,
  by: Actor,
  workflowId: number,
  definition: WorkflowDefinition,
  mapping: ReadonlyMap<number, number>,
): Promise<{ version: number; ticketCount: number; removed: number[] }> {
  const row = await trx
    .selectFrom('workflow')
    .select(['published_version', 'draft_version'])
    .where('id', '=', workflowId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const tracks = await trx
    .selectFrom('track')
    .select('id')
    .where('workspace_id', '=', by.workspaceId)
    .where(
      'workflow_map_id',
      'in',
      trx.selectFrom('workflow_map').select('id').where('default_workflow_id', '=', workflowId),
    )
    .execute();
  if (
    (await runningMigration(
      trx,
      by.workspaceId,
      tracks.map((t) => t.id),
    )) !== null
  ) {
    throw new BoardWorkflowError('migration_running');
  }
  const published = await loadDefinition(trx, workflowId, row.published_version);
  const kept = new Set(definition.statuses.map((s) => s.statusId));
  const removed = published.statuses.map((s) => s.statusId).filter((s) => !kept.has(s));
  const tickets = await ticketsInStatuses(trx, by.workspaceId, workflowId, removed);
  const used = new Map<number, number>();
  for (const statusId of removed) {
    const target = mapping.get(statusId);
    used.set(
      statusId,
      target !== undefined && kept.has(target) ? target : definition.initialStatusId,
    );
  }
  const ticketCount = await remapStatuses(trx, by.workspaceId, by.actorId, tickets, used);
  const latest = await trx
    .selectFrom('workflow_version')
    .select(sql<number>`max(version)`.as('v'))
    .where('workflow_id', '=', workflowId)
    .executeTakeFirstOrThrow();
  const version = Number(latest.v) + 1;
  await writeVersion(trx, by.workspaceId, workflowId, version, definition, by.actorId, true);
  await trx
    .updateTable('workflow')
    .set({ published_version: version, draft_version: null, updated_at: new Date() })
    .where('id', '=', workflowId)
    .execute();
  return { version, ticketCount, removed };
}

/**
 * Rewrites a managed board's workflow from its columns: statuses made where needed, the next
 * version published. Returns the columns as stored (one status each).
 */
export async function syncBoardWorkflow(
  trx: Trx,
  by: Actor,
  board: { id: number; trackId: number | null },
  columns: readonly Column[],
  options: { collapse?: boolean; mapping?: ReadonlyMap<number, number> } = {},
): Promise<{ columns: Column[]; change: BoardWorkflowChange }> {
  const track = await trackWorkflow(trx, by.workspaceId, board.trackId);
  const {
    columns: stored,
    merged,
    made,
  } = await columnsWithStatuses(trx, by, columns, options.collapse ?? false);
  const completedId = await completedReasonId(trx, by);
  const sourceId = track.workflowId ?? track.sharedWorkflowId;
  const row = await trx
    .selectFrom('workflow')
    .select('published_version')
    .where('id', '=', sourceId)
    .executeTakeFirstOrThrow();
  const current = await loadDefinition(trx, sourceId, row.published_version);
  const definition = boardDefinition(board.id, stored, completedId, current);
  const mapping = new Map([...merged, ...(options.mapping ?? [])]);
  // Tickets in a status a column held keep its column's place.
  for (const column of columns) {
    const target = stored.find((c) => c.id === column.id)?.statusIds[0];
    if (target === undefined) continue;
    for (const status of column.statusIds) if (!mapping.has(status)) mapping.set(status, target);
  }
  if (track.workflowId === null) {
    const adopted = await adoptWorkflow(
      trx,
      by,
      board.trackId as number,
      track.mapId,
      track.sharedWorkflowId,
      definition,
      mapping,
    );
    return {
      columns: stored,
      change: {
        workflowId: adopted.workflowId,
        version: 1,
        createdWorkflow: true,
        createdStatusIds: made,
        removedStatusIds: [],
        ticketsMoved: adopted.ticketCount,
      },
    };
  }
  const published = await publishBoardVersion(trx, by, track.workflowId, definition, mapping);
  return {
    columns: stored,
    change: {
      workflowId: track.workflowId,
      version: published.version,
      createdWorkflow: false,
      createdStatusIds: made,
      removedStatusIds: published.removed,
      ticketsMoved: published.ticketCount,
    },
  };
}
