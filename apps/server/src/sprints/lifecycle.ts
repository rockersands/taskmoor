import type { Database } from '@taskmoor/db';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import type { BoardRecord } from '../boards/data';
import { emit } from '../events/bus';
import type { SprintSettings } from './model';

/**
 * The sprint lifecycle (M1-044; AGL-010, AGL-011; ADR-054) as transactions any caller runs:
 * the sprint routes for a person, the cycle roll-over (M1-045; AGL-012) for nobody. Each takes
 * the board lock first, so one writer at a time changes a board's sprints.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** Who changes the sprints: a person, or nobody when the worker rolls a cycle over. */
export interface SprintActor {
  workspaceId: number;
  actorId: number | null;
}

export type SprintChangeKind = 'added' | 'removed' | 'committed' | 'completed' | 'carried_over';

/** Where a completed sprint's unfinished tickets go. */
export type MoveTo =
  | { type: 'backlog' }
  | { type: 'sprint'; sprintId: number }
  | { type: 'new'; name?: string | undefined };

/** The ticket's estimate by the board's statistic, over `ticket k`. */
export function estimateSql(settings: SprintSettings): RawBuilder<number | string | null> {
  const e = settings.estimation;
  if (e.statistic === 'ticketCount') return sql`1`;
  if (e.statistic === 'originalEstimate') return sql`k.original_estimate`;
  const key = String(e.fieldId);
  return sql`CASE WHEN jsonb_typeof(k.fields -> ${key}::text) = 'number'
    THEN (k.fields ->> ${key}::text)::numeric END`;
}

/** The statuses of the board's rightmost column: done (spec 01b section 3.2). */
export const doneStatuses = (board: BoardRecord): number[] =>
  board.columns[board.columns.length - 1]?.statusIds ?? [];

/** Locks the board's row: its sprints change one writer at a time. */
export async function lockBoard(trx: Db, boardId: number): Promise<void> {
  await trx.selectFrom('board').select('id').where('id', '=', boardId).forUpdate().execute();
}

interface Snap {
  original_estimate: number | null;
  remaining_estimate: number | null;
  points: string | null;
}

/** The tickets' estimates now, as the scope-change rows record them. */
async function snapshot(trx: Db, settings: SprintSettings, ticketIds: readonly number[]) {
  if (ticketIds.length === 0) return new Map<number, Snap>();
  const points =
    settings.estimation.statistic === 'field' ? estimateSql(settings) : sql<null>`NULL`;
  const rows = await sql<{
    id: number;
    original_estimate: number | null;
    remaining_estimate: number | null;
    points: string | null;
  }>`SELECT k.id, k.original_estimate, k.remaining_estimate, ${points} AS points
       FROM ticket k WHERE k.id = ANY(${[...ticketIds]}::int[])`.execute(trx);
  return new Map(
    rows.rows.map((r) => [
      r.id,
      {
        original_estimate: r.original_estimate,
        remaining_estimate: r.remaining_estimate,
        points: r.points,
      },
    ]),
  );
}

/** One `sprint_change` row per ticket, with its estimate now (the report reads these). */
export async function recordChanges(
  trx: Db,
  actor: SprintActor,
  settings: SprintSettings,
  sprintId: number,
  kind: SprintChangeKind,
  ticketIds: readonly number[],
  extra: { afterStart?: boolean; toSprintId?: number | null; at?: Date } = {},
): Promise<void> {
  if (ticketIds.length === 0) return;
  const snaps = await snapshot(trx, settings, ticketIds);
  await trx
    .insertInto('sprint_change')
    .values(
      ticketIds.map((ticketId) => {
        const s = snaps.get(ticketId);
        return {
          workspace_id: actor.workspaceId,
          sprint_id: sprintId,
          ticket_id: ticketId,
          kind,
          after_start: extra.afterStart ?? false,
          actor_id: actor.actorId,
          original_estimate: s?.original_estimate ?? null,
          remaining_estimate: s?.remaining_estimate ?? null,
          points: s?.points ?? null,
          to_sprint_id: extra.toSprintId ?? null,
          ...(extra.at ? { at: extra.at } : {}),
        };
      }),
    )
    .execute();
}

/**
 * A future sprint at the end of the board's order, named "<board> Sprint <n>" unless named;
 * the caller holds the board lock. `emitCreated` is false where it is part of another change
 * that has its own event (completing into a new sprint names it in `sprint.completed`).
 */
export async function createSprint(
  trx: Db,
  actor: SprintActor,
  board: { id: number; name: string },
  input: { name?: string | undefined; goal?: string; startAt?: Date | null; endAt?: Date | null },
  emitCreated = true,
): Promise<{ id: number; name: string; state: string }> {
  const counted = await trx
    .selectFrom('sprint')
    .select(({ fn }) => [fn.countAll<string>().as('n'), fn.max('sequence').as('top')])
    .where('board_id', '=', board.id)
    .executeTakeFirstOrThrow();
  const name = input.name ?? `${board.name} Sprint ${Number(counted.n) + 1}`;
  const row = await trx
    .insertInto('sprint')
    .values({
      workspace_id: actor.workspaceId,
      board_id: board.id,
      name,
      goal: input.goal ?? '',
      sequence: (counted.top ?? 0) + 1,
      start_at: input.startAt ?? null,
      end_at: input.endAt ?? null,
      created_by: actor.actorId,
    })
    .returning(['id', 'state'])
    .executeTakeFirstOrThrow();
  if (emitCreated) {
    await emit(trx, actor, {
      type: 'sprint.created',
      subjectId: row.id,
      payload: { boardId: board.id, name },
    });
  }
  return { id: row.id, name, state: row.state };
}

/**
 * Starts a future sprint: its tickets are committed at `now`. Refused when it is not future
 * any more, when the board's track has its sprints turned off, or when another sprint is active
 * on a board without parallel sprints.
 */
export async function startSprint(
  trx: Db,
  actor: SprintActor,
  board: { id: number; settings: SprintSettings },
  sprint: { id: number; name: string; goal: string; version: number },
  input: { name?: string; goal?: string; startAt: Date; endAt: Date; now?: Date },
): Promise<
  | { error: 'not_scrum' }
  | { error: 'sprints_off' }
  | { error: 'sprint_not_future' }
  | { error: 'sprint_active'; sprintId: number }
  | { started: true }
> {
  await lockBoard(trx, board.id);
  // A Kanban board keeps its planned sprints, but one cannot start there: nothing could end it.
  // Nor on a track whose sprints are turned off, which refuses that while one runs (AGL-010);
  // turning them off takes this board's lock first, so neither slips by.
  const kind = await trx
    .selectFrom('board as b')
    .leftJoin('track as t', 't.id', 'b.location_track_id')
    .select(['b.kind', 't.feature_sprints'])
    .where('b.id', '=', board.id)
    .executeTakeFirst();
  if (kind?.kind !== 'scrum') return { error: 'not_scrum' };
  if (kind.feature_sprints === false) return { error: 'sprints_off' };
  const current = await trx
    .selectFrom('sprint')
    .select('state')
    .where('id', '=', sprint.id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (current.state !== 'future') return { error: 'sprint_not_future' };
  if (!board.settings.parallelSprints) {
    const active = await trx
      .selectFrom('sprint')
      .select('id')
      .where('board_id', '=', board.id)
      .where('state', '=', 'active')
      .executeTakeFirst();
    if (active) return { error: 'sprint_active', sprintId: active.id };
  }
  const now = input.now ?? new Date();
  await trx
    .updateTable('sprint')
    .set({
      state: 'active',
      name: input.name ?? sprint.name,
      goal: input.goal ?? sprint.goal,
      start_at: input.startAt,
      end_at: input.endAt,
      started_at: now,
      started_by: actor.actorId,
      version: sprint.version + 1,
      updated_at: now,
    })
    .where('id', '=', sprint.id)
    .execute();
  const members = await trx
    .selectFrom('sprint_ticket')
    .select('ticket_id')
    .where('sprint_id', '=', sprint.id)
    .execute();
  const ids = members.map((m) => m.ticket_id);
  await recordChanges(trx, actor, board.settings, sprint.id, 'committed', ids, { at: now });
  await emit(trx, actor, {
    type: 'sprint.started',
    subjectId: sprint.id,
    payload: {
      boardId: board.id,
      startAt: input.startAt.toISOString(),
      endAt: input.endAt.toISOString(),
      tickets: ids.length,
    },
  });
  return { started: true };
}

export interface CompleteOutcome {
  completed: number;
  carriedOver: number;
  toBacklog: number;
  toSprintId: number | null;
}

/**
 * Completes an active sprint at `now`. Its finished tickets (a status of the board's rightmost
 * column) stay with it; unfinished ones the board shows (`boardScope`, over `ticket k`, as
 * the board shows them to anyone) move to `moveTo`, the others to the backlog (a shared
 * sprint, AGL-011 (2)).
 */
export async function completeSprint(
  trx: Db,
  actor: SprintActor,
  board: { id: number; name: string; record: BoardRecord; settings: SprintSettings },
  sprint: { id: number; version: number },
  boardScope: RawBuilder<boolean>,
  moveTo: MoveTo,
  now = new Date(),
): Promise<{ error: 'sprint_not_active' | 'invalid_target' } | CompleteOutcome> {
  await lockBoard(trx, board.id);
  const current = await trx
    .selectFrom('sprint')
    .select('state')
    .where('id', '=', sprint.id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (current.state !== 'active') return { error: 'sprint_not_active' };
  let target: { id: number; state: string } | null = null;
  if (moveTo.type === 'sprint') {
    const row = await trx
      .selectFrom('sprint')
      .select(['id', 'state'])
      .where('id', '=', moveTo.sprintId)
      .where('board_id', '=', board.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row || row.id === sprint.id || row.state === 'closed') {
      return { error: 'invalid_target' };
    }
    target = row;
  } else if (moveTo.type === 'new') {
    target = await createSprint(trx, actor, board, { name: moveTo.name }, false);
  }
  const done = doneStatuses(board.record);
  const members = await sql<{ id: number; done: boolean; on_board: boolean }>`
    SELECT k.id, k.status_id = ANY(${done}::int[]) AS done, (${boardScope}) AS on_board
      FROM sprint_ticket st JOIN ticket k ON k.id = st.ticket_id
     WHERE st.sprint_id = ${sprint.id}::int AND st.open`.execute(trx);
  const finished = members.rows.filter((m) => m.done).map((m) => m.id);
  const carried = members.rows.filter((m) => !m.done && m.on_board).map((m) => m.id);
  const others = members.rows.filter((m) => !m.done && !m.on_board).map((m) => m.id);
  await recordChanges(trx, actor, board.settings, sprint.id, 'completed', finished, { at: now });
  await recordChanges(
    trx,
    actor,
    board.settings,
    sprint.id,
    'carried_over',
    [...carried, ...others],
    {
      at: now,
    },
  );
  if (target && carried.length > 0) {
    await trx
      .updateTable('sprint_change')
      .set({ to_sprint_id: target.id })
      .where('sprint_id', '=', sprint.id)
      .where('kind', '=', 'carried_over')
      .where('ticket_id', 'in', carried)
      .execute();
  }
  await trx
    .updateTable('sprint_ticket')
    .set({ open: false })
    .where('sprint_id', '=', sprint.id)
    .execute();
  if (target && carried.length > 0) {
    const into = target;
    await trx
      .insertInto('sprint_ticket')
      .values(
        carried.map((ticketId) => ({
          workspace_id: actor.workspaceId,
          sprint_id: into.id,
          ticket_id: ticketId,
        })),
      )
      .execute();
    await recordChanges(trx, actor, board.settings, into.id, 'added', carried, {
      afterStart: into.state === 'active',
      at: now,
    });
  }
  await trx
    .updateTable('sprint')
    .set({
      state: 'closed',
      completed_at: now,
      completed_by: actor.actorId,
      version: sprint.version + 1,
      updated_at: now,
    })
    .where('id', '=', sprint.id)
    .execute();
  const outcome: CompleteOutcome = {
    completed: finished.length,
    carriedOver: target ? carried.length : 0,
    toBacklog: others.length + (target ? 0 : carried.length),
    toSprintId: target?.id ?? null,
  };
  await emit(trx, actor, {
    type: 'sprint.completed',
    subjectId: sprint.id,
    payload: {
      boardId: board.id,
      completed: outcome.completed,
      carriedOver: carried.length,
      toBacklog: outcome.toBacklog,
      moveTo: moveTo.type,
      toSprintId: outcome.toSprintId,
    },
  });
  return outcome;
}
