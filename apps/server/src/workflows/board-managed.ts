import type { Database, StatusStage } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Column } from '../boards/model';
import { lockList } from '../tickets/fields';
import { defaultClosingReason } from './close-reasons';
import { freeTransition } from './free-moving';
import { loadMap, trackMapId } from './maps';
import { runningMigration } from './migration';
import { statusIdsOf, type Transition, type WorkflowDefinition } from './model';
import {
  heldStatusInfo,
  loadDefinition,
  remapStatuses,
  statusInfo,
  ticketsInStatuses,
  writeVersion,
} from './store';

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

/** Whether a map and its default workflow serve this track alone. */
async function usedOnlyBy(
  trx: Trx,
  ws: number,
  trackId: number,
  mapId: number,
  workflowId: number,
): Promise<boolean> {
  const otherTrack = await trx
    .selectFrom('track')
    .select('id')
    .where('workspace_id', '=', ws)
    .where('workflow_map_id', '=', mapId)
    .where('id', '!=', trackId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (otherTrack) return false;
  const otherMap = await trx
    .selectFrom('workflow_map')
    .select('id')
    .where('workspace_id', '=', ws)
    .where('default_workflow_id', '=', workflowId)
    .where('id', '!=', mapId)
    .executeTakeFirst();
  if (otherMap) return false;
  const row = await trx
    .selectFrom('workflow')
    .select('is_default')
    .where('id', '=', workflowId)
    .executeTakeFirstOrThrow();
  return !row.is_default;
}

/**
 * The track's workflow (`trackWorkflow`), held as a board's change of it holds it, in the order
 * every path takes them (ADR-116, `workflows/store.ts`): the status list, then the track's own
 * workflow (update). A column may need a status made, which takes the list; a workflow import and
 * a status's deletion take the list before the workflow or the status; a stage change holds the
 * workflow before the status, so it is held before any column's status is renamed. Whatever
 * decides the change is read after this, so no publish slips between that read and the board's
 * new version (T-238).
 */
async function holdTrackWorkflow(trx: Trx, ws: number, trackId: number | null) {
  const track = await trackWorkflow(trx, ws, trackId);
  await lockList(trx, ws, 'status');
  if (track.workflowId !== null) {
    await trx
      .selectFrom('workflow')
      .select('id')
      .where('id', '=', track.workflowId)
      .forUpdate()
      .execute();
  }
  return track;
}

/**
 * Whether a new board of this track can take over its workflow. Never one other tracks use, and
 * never one where someone configured guards, checks or rules: those stay in force (ADR-116).
 * A local-mode track still on the shared default gets a workflow of its own, leaving that as it is.
 * The workflow is held before it is read, as the sync that follows holds it (T-238): a check
 * published after a read made without the lock would be replaced by the board's columns. When the
 * answer is no, the locks stay until the transaction ends, as they would after a takeover.
 */
export async function mayManageWorkflow(trx: Trx, ws: number, trackId: number): Promise<boolean> {
  let track: Awaited<ReturnType<typeof trackWorkflow>>;
  try {
    track = await holdTrackWorkflow(trx, ws, trackId);
  } catch (error) {
    if (error instanceof BoardWorkflowError) return false;
    throw error;
  }
  if (track.workflowId === null) return true;
  const row = await trx
    .selectFrom('workflow')
    .select('published_version')
    .where('id', '=', track.workflowId)
    .executeTakeFirstOrThrow();
  const definition = await loadDefinition(trx, track.workflowId, row.published_version);
  if (definition.board) return true;
  return !(
    definition.transitions.some((t) => t.guards || (t.checks?.length ?? 0) > 0) ||
    Object.keys(definition.rules ?? {}).length > 0
  );
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
  const mapId = await trackMapId(trx, ws, trackId);
  const map = mapId === undefined ? null : await loadMap(trx, ws, mapId, 'update');
  if (track.mode !== 'local') {
    // A shared-mode track qualifies only when nothing else uses its map or its workflow.
    if (!map || !(await usedOnlyBy(trx, ws, trackId, map.id, map.defaultWorkflowId))) {
      throw new BoardWorkflowError('shared_mode_track');
    }
    if ([...map.entries.values()].some((w) => w !== map.defaultWorkflowId)) {
      throw new BoardWorkflowError('per_type_workflows');
    }
    return {
      mapId: map.id,
      workflowId: map.defaultWorkflowId,
      sharedWorkflowId: map.defaultWorkflowId,
    };
  }
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
  /** The stage of a status made for a column; by default, what its place among `columns` says. */
  stageOf: (index: number) => StatusStage = (index) => stageAt(index, columns.length),
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
      const stage = stageOf(index);
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

const reasonNamedCompleted = async (trx: Trx, workspaceId: number) =>
  (
    await trx
      .selectFrom('close_reason')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where(sql`lower(name)`, '=', 'completed')
      .executeTakeFirst()
  )?.id ?? null;

/**
 * The reason a closing status that moves freely sets, or null when the workspace has none to name:
 * Completed by name, or what the default workflow closes with, so a renamed or replaced Completed
 * stays the one reason and no second Completed appears beside it. The name comes first: a default
 * workflow that closes some steps with another reason, such as Not planned, never decides it while
 * Completed exists. A reason named Completed made after Completed was replaced takes the free moves
 * made from then on while the old ones keep the replacement; which one should win is open for the
 * user (T-234), so this stays as it was.
 */
export async function closingReasonId(trx: Trx, workspaceId: number): Promise<number | null> {
  return (
    (await reasonNamedCompleted(trx, workspaceId)) ?? (await defaultClosingReason(trx, workspaceId))
  );
}

/** The reason a closing status that moves freely sets, with Completed made when there is none. */
export async function completedReasonId(trx: Trx, by: Actor): Promise<number> {
  const found = await closingReasonId(trx, by.workspaceId);
  if (found !== null) return found;
  await lockList(trx, by.workspaceId, 'close_reason');
  // Someone else may have made it while this waited for the list.
  const made = await reasonNamedCompleted(trx, by.workspaceId);
  if (made !== null) return made;
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

/** The column that closes tickets, or -1. A choice that no longer exists falls to the default. */
export function closingIndex(columns: readonly { id: string }[], closing: string | null): number {
  if (closing === 'none') return -1;
  const chosen = closing === null ? -1 : columns.findIndex((c) => c.id === closing);
  if (chosen >= 0) return chosen;
  return columns.length > 1 ? columns.length - 1 : -1;
}

/** The definition a board's columns make (spec 01a section 3.6). */
export function boardDefinition(
  boardId: number,
  columns: readonly Column[],
  completedId: number,
  keep?: Pick<WorkflowDefinition, 'onCreate' | 'statusPermissions'>,
  /** Which column closes tickets: null the rightmost, `none` no column, or a column's id. */
  closing: string | null = null,
): WorkflowDefinition {
  const statusIds = columns.map((c) => c.statusIds[0] as number);
  const closes = closingIndex(columns, closing);
  // The status id names its transition, so it stays the same while the column does.
  const transitions: Transition[] = columns.map((column, index) =>
    freeTransition(statusIds[index] as number, column.name, index === closes, completedId),
  );
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

/** The statuses among these that a workflow other than this one has, in any version. */
async function usedElsewhere(
  trx: Trx,
  statusIds: readonly number[],
  workflowId: number | null,
): Promise<Set<number>> {
  if (statusIds.length === 0) return new Set();
  const rows = await trx
    .selectFrom('workflow_version_status')
    .select('status_id')
    .distinct()
    .where('status_id', 'in', [...new Set(statusIds)])
    .where((eb) => (workflowId === null ? eb.val(true) : eb('workflow_id', '!=', workflowId)))
    .execute();
  return new Set(rows.map((r) => r.status_id));
}

/**
 * The statuses among `ids` that no workflow but this one has, held (update, in id order) so a
 * board's change may rename them or settle their stage, and checked again once held (ADR-116,
 * T-237). A plain update holds a row only against other updates: a draft save adding the status
 * holds it with key share, which does not wait for that, so it read the name and stage from before
 * the change, and a draft saved between the check and the update made a status another workflow
 * has change. Held, a draft that took the status first is waited for and then seen here, and one
 * that comes after waits and reads what the change leaves. They are held after the status list and
 * the workflow, as the status route holds its status after the workflows. A status another workflow
 * has is not held: it keeps its name and stage, whoever else takes it meanwhile.
 */
async function holdOwnStatuses(
  trx: Trx,
  ws: number,
  workflowId: number | null,
  ids: readonly number[],
): Promise<Set<number>> {
  const shared = await usedElsewhere(trx, ids, workflowId);
  const own = [...new Set(ids)].filter((id) => !shared.has(id));
  if (own.length === 0) return new Set();
  await trx
    .selectFrom('status')
    .select('id')
    .where('workspace_id', '=', ws)
    .where('id', 'in', own)
    .orderBy('id')
    .forUpdate()
    .execute();
  const taken = await usedElsewhere(trx, own, workflowId);
  return new Set(own.filter((id) => !taken.has(id)));
}

/**
 * The statuses named as a column is, which it may take by that name (`columnsWithStatuses`): a
 * column without a status, or one whose status keeps its name because another workflow has it, or
 * whose new name another status has. Held with the columns' own
 * statuses at the start of a sync, in one id order, so settling their stage later holds nothing
 * new: a draft save holding one of them (key share) while it waits for a column's status would
 * otherwise have one of the two ended (40P01).
 */
async function statusesColumnsMayTake(
  trx: Trx,
  ws: number,
  columns: readonly Column[],
): Promise<number[]> {
  const names = [...new Set(columns.map((c) => c.name.toLowerCase()))];
  if (names.length === 0) return [];
  const rows = await trx
    .selectFrom('status')
    .select('id')
    .where('workspace_id', '=', ws)
    .where(sql`lower(name)`, 'in', names)
    .execute();
  return rows.map((r) => r.id);
}

/**
 * Renames a column's status with it. A status other workflows use keeps its name for them: the
 * column then takes a status of its own, and its tickets follow. `own` holds the statuses only this
 * workflow has, held (`holdOwnStatuses`); only those are renamed.
 */
async function renamedStatuses(
  trx: Trx,
  by: Actor,
  own: ReadonlySet<number>,
  columns: readonly Column[],
): Promise<Column[]> {
  const out: Column[] = [];
  for (const column of columns) {
    const [first, ...rest] = column.statusIds;
    if (first === undefined || rest.length > 0) {
      out.push(column);
      continue;
    }
    const status = await trx
      .selectFrom('status')
      .select('name')
      .where('id', '=', first)
      .where('workspace_id', '=', by.workspaceId)
      .executeTakeFirst();
    if (!status || status.name.toLowerCase() === column.name.toLowerCase()) {
      out.push(column);
      continue;
    }
    const taken = await trx
      .selectFrom('status')
      .select('id')
      .where('workspace_id', '=', by.workspaceId)
      .where(sql`lower(name)`, '=', column.name.toLowerCase())
      .executeTakeFirst();
    if (taken || !own.has(first)) {
      out.push({ ...column, statusIds: [] });
      continue;
    }
    await trx
      .updateTable('status')
      .set({ name: column.name, updated_at: new Date() })
      .where('id', '=', first)
      .execute();
    out.push(column);
  }
  return out;
}

/**
 * The closing column's status is a closed one, the others not, for statuses only this workflow
 * uses. A status other workflows share keeps its stage. Tickets already closed keep their close
 * reason and history: only moving a ticket out clears a reason. The statuses are held before they
 * are checked (`holdOwnStatuses`): most already are, since the sync began; a status a column took by
 * its name is held here.
 */
async function settleStages(
  trx: Trx,
  by: Actor,
  workflowId: number,
  columns: readonly Column[],
  closing: string | null,
) {
  const closes = closingIndex(columns, closing);
  const own = await holdOwnStatuses(
    trx,
    by.workspaceId,
    workflowId,
    columns.map((c) => c.statusIds[0] as number),
  );
  for (const [index, column] of columns.entries()) {
    const statusId = column.statusIds[0] as number;
    if (!own.has(statusId)) continue;
    const status = await trx
      .selectFrom('status')
      .select('stage')
      .where('id', '=', statusId)
      .where('workspace_id', '=', by.workspaceId)
      .executeTakeFirst();
    const stage: StatusStage | undefined =
      index === closes
        ? 'closed'
        : status?.stage === 'closed'
          ? index === 0
            ? 'new'
            : 'active'
          : undefined;
    if (stage && status?.stage !== stage) {
      await trx
        .updateTable('status')
        .set({ stage, updated_at: new Date() })
        .where('id', '=', statusId)
        .execute();
    }
  }
}

/** Why a column cannot hold a ticket: no status yet, or no transition leads to its status. */
export type ColumnReach = 'ok' | 'no_status' | 'no_path';

/**
 * Whether cards can reach each column of a track's board, and whose workflow decides it. Stated
 * at once by the settings and the board, so nobody learns of it from a refused drag (ADR-116).
 */
export async function columnReach(
  db: Kysely<Database>,
  ws: number,
  trackId: number,
  columns: readonly Column[],
) {
  const mapId = await trackMapId(db as unknown as Trx, ws, trackId);
  if (mapId === undefined) return null;
  const map = await db
    .selectFrom('workflow_map')
    .select('default_workflow_id')
    .where('id', '=', mapId)
    .executeTakeFirst();
  if (!map) return null;
  const entries = await db
    .selectFrom('workflow_map_entry')
    .select('workflow_id')
    .where('map_id', '=', mapId)
    .execute();
  const ids = [...new Set([map.default_workflow_id, ...entries.map((e) => e.workflow_id)])];
  const workflows = await db
    .selectFrom('workflow as w')
    .innerJoin('workflow_version as v', (join) =>
      join.onRef('v.workflow_id', '=', 'w.id').onRef('v.version', '=', 'w.published_version'),
    )
    .select(['w.id', 'w.name', 'v.definition'])
    .where('w.id', 'in', ids)
    .execute();
  const definitions = workflows.map((w) => w.definition as unknown as WorkflowDefinition);
  const reaches = (statusId: number) =>
    definitions.some(
      (d) =>
        d.initialStatusId === statusId ||
        d.transitions.some(
          (t) =>
            t.to === statusId && (t.from === 'any' || t.from.some((from) => from !== statusId)),
        ),
    );
  const others = await db
    .selectFrom('track as t')
    .select(['t.id', 't.name'])
    .where('t.workspace_id', '=', ws)
    .where('t.deleted_at', 'is', null)
    .where('t.id', '!=', trackId)
    .where((eb) =>
      eb.or([
        eb(
          't.workflow_map_id',
          'in',
          eb.selectFrom('workflow_map').select('id').where('default_workflow_id', 'in', ids),
        ),
        ...(workflows.some((w) => w.id === map.default_workflow_id)
          ? [
              eb.and([
                eb('t.workflow_map_id', 'is', null),
                eb(
                  eb
                    .selectFrom('workflow')
                    .select('is_default')
                    .where('id', '=', map.default_workflow_id),
                  '=',
                  true,
                ),
              ]),
            ]
          : []),
      ]),
    )
    .orderBy('t.name')
    .execute();
  const main = workflows.find((w) => w.id === map.default_workflow_id);
  return {
    workflow: main ? { id: main.id, name: main.name } : null,
    singleWorkflow: ids.length === 1,
    otherTracks: others.map((t) => t.name),
    columns: Object.fromEntries(
      columns.map((c): [string, ColumnReach] => [
        c.id,
        c.statusIds.length === 0 ? 'no_status' : c.statusIds.some(reaches) ? 'ok' : 'no_path',
      ]),
    ),
  };
}

/**
 * The workflow a column's path goes to (T-249): the track's only workflow, read inside the path's
 * transaction with the track's map held (update), after the board and before the status list and
 * the workflow, in the order a board's sync holds them. A map changed meanwhile is waited for and
 * then read; read before the transaction, the path went to the workflow the track had before. Null
 * when the track's tickets have more than one workflow, or none.
 */
export async function columnPathWorkflow(
  trx: Trx,
  ws: number,
  trackId: number,
  columns: readonly Column[],
): Promise<number | null> {
  const mapId = await trackMapId(trx, ws, trackId);
  if (mapId === undefined) return null;
  await loadMap(trx, ws, mapId, 'update');
  const reach = await columnReach(trx, ws, trackId, columns);
  return reach?.workflow && reach.singleWorkflow ? reach.workflow.id : null;
}

/**
 * Lets cards reach a column on a workflow that stays an ordinary one: a status for the column if it
 * has none, a transition from any status to it, and steps out of it to the other columns. A new
 * version of the workflow; other tracks using it see the new status too, which the page says first.
 * The new version is built on the published one as it stands once the workflow is held (T-238), in
 * the lock order of ADR-116: the status list when the column needs a status made, then the
 * workflow. Read before the lock, a version published meanwhile would be overwritten.
 */
export async function addColumnPath(
  trx: Trx,
  by: Actor,
  workflowId: number,
  columns: readonly Column[],
  columnId: string,
): Promise<{ columns: Column[]; change: BoardWorkflowChange }> {
  const column = columns.find((c) => c.id === columnId);
  if (!column) throw new BoardWorkflowError('not_a_track_board');
  if (column.statusIds.length === 0) await lockList(trx, by.workspaceId, 'status');
  const row = await trx
    .selectFrom('workflow')
    .select('published_version')
    .where('id', '=', workflowId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const current = await loadDefinition(trx, workflowId, row.published_version);
  // A status made here takes the stage its column's place says. A workflow that closes tickets
  // already keeps its closing status: a column added after Closed holds cards, it does not close.
  const stages = await statusInfo(trx, by.workspaceId, [...statusIdsOf(current)]);
  const closesAlready = [...stages.values()].some((s) => s.stage === 'closed');
  const placed = stageAt(columns.indexOf(column), columns.length);
  const { columns: withStatus, made } = await columnsWithStatuses(trx, by, [column], false, () =>
    placed === 'closed' && closesAlready ? 'active' : placed,
  );
  const statusId = withStatus[0]?.statusIds[0] as number;
  const stored = columns.map((c) => (c.id === columnId ? (withStatus[0] as Column) : c));
  const next = Math.max(0, ...current.transitions.map((t) => t.id)) + 1;
  const transitions: Transition[] = [...current.transitions];
  let id = next;
  if (!transitions.some((t) => t.to === statusId && t.from === 'any')) {
    // Entering a closing status sets Completed, as on any workflow that moves freely (WF-008). Its
    // stage is read with the status held, after the workflow, so a stage change under way decides
    // it (T-237). The workflow's other statuses are held with it, in id order, as the version
    // written next holds them.
    const info = await heldStatusInfo(trx, by.workspaceId, [...statusIdsOf(current), statusId]);
    const closes = info.get(statusId)?.stage === 'closed';
    const completedId = closes ? await completedReasonId(trx, by) : null;
    transitions.push(freeTransition(statusId, column.name, closes, completedId, id++));
  }
  // Out again: a global transition already leaves from it; the others get a step each.
  for (const other of stored) {
    const target = other.statusIds[0];
    if (other.id === columnId || target === undefined) continue;
    const leaves = transitions.some(
      (t) => t.to === target && (t.from === 'any' || t.from.includes(statusId)),
    );
    if (!leaves) {
      transitions.push({ id: id++, name: other.name, from: [statusId], to: target });
    }
  }
  const definition: WorkflowDefinition = {
    ...current,
    statuses: current.statuses.some((s) => s.statusId === statusId)
      ? current.statuses
      : [...current.statuses, { statusId }],
    transitions,
  };
  const published = await publishBoardVersion(trx, by, workflowId, definition, new Map());
  return {
    columns: stored,
    change: {
      workflowId,
      version: published.version,
      createdWorkflow: false,
      createdStatusIds: made,
      removedStatusIds: [],
      ticketsMoved: 0,
    },
  };
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
  options: {
    collapse?: boolean;
    mapping?: ReadonlyMap<number, number>;
    closing?: string | null;
  } = {},
): Promise<{ columns: Column[]; change: BoardWorkflowChange }> {
  // Lock order (ADR-116): the status list, then the workflow, then statuses (in id order): the
  // columns' statuses this change may rename or settle are held before any is renamed (T-237).
  const track = await holdTrackWorkflow(trx, by.workspaceId, board.trackId);
  const own = await holdOwnStatuses(trx, by.workspaceId, track.workflowId, [
    ...columns.flatMap((c) => c.statusIds.slice(0, 1)),
    ...(await statusesColumnsMayTake(trx, by.workspaceId, columns)),
  ]);
  const closing = options.closing ?? null;
  // A column's name is its status's name (the user's decision, ADR-116).
  const renamed = await renamedStatuses(trx, by, own, columns);
  const {
    columns: stored,
    merged,
    made,
  } = await columnsWithStatuses(trx, by, renamed, options.collapse ?? false);
  const completedId = await completedReasonId(trx, by);
  const sourceId = track.workflowId ?? track.sharedWorkflowId;
  const row = await trx
    .selectFrom('workflow')
    .select('published_version')
    .where('id', '=', sourceId)
    .executeTakeFirstOrThrow();
  const current = await loadDefinition(trx, sourceId, row.published_version);
  const definition = boardDefinition(board.id, stored, completedId, current, closing);
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
    await settleStages(trx, by, adopted.workflowId, stored, closing);
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
  await settleStages(trx, by, track.workflowId, stored, closing);
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
