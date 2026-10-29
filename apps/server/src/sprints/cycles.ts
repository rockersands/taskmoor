import type { Database } from '@taskmoor/db';
import { addWall, instantOf, wallClock } from '@taskmoor/query';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import { boardRecord, compileBoard, workspaceScope } from '../boards/data';
import type { FieldCatalogs } from '../fields/catalog';
import { completeSprint, createSprint, type SprintActor, startSprint } from './lifecycle';
import { readSprintSettings, type SprintCycle } from './model';

/**
 * Auto-rolling cycles (M1-045; AGL-012; ADR-054): on a Scrum board with a cycle, sprints of a
 * fixed length follow each other without anyone starting or completing them.
 *
 * - While a sprint is active, the next one is ready: the first future sprint in the board's
 *   order, or one made for it ("<board> Sprint <n>") from the active sprint's end for the
 *   cycle's length. Its dates, when the team set them, are kept.
 * - When the active sprint's end has passed, it is completed into the next one (unfinished
 *   tickets the board shows move along; done ones stay) and the next one starts. Both happen
 *   at the scheduled boundary, so a cycle's history reads as planned even when the worker was
 *   down for a while; it then catches up one cycle at a time.
 * - The first sprint of a cycle is started by a person: without an active sprint nothing rolls.
 * - Days are counted on the cycle's time zone's wall clock, so a sprint that ends at 09:00 ends
 *   at 09:00 after a change to or from summer time.
 * - Each board rolls in its own transactions under the board lock, taken without waiting: a
 *   board another worker (or a person) is changing is left for the next pass.
 */
const MAX_ROLLS_PER_PASS = 52;

export interface RollReport {
  /** Boards with a cycle. */
  boards: number;
  /** Next sprints made ready. */
  prepared: number;
  /** Sprints completed into their successor, which then started. */
  rolled: number;
  /** Boards that could not be read (a query that no longer binds) and why. */
  failed: { boardId: number; message: string }[];
}

/** `days` later on the wall clock of `timeZone`. */
export function addDays(at: Date, days: number, timeZone: string): Date {
  return instantOf(addWall(wallClock(at, timeZone), days, 'd'), timeZone);
}

type Step = 'busy' | 'idle' | 'ready' | 'prepared' | 'rolled';

/** One pass over every board with a cycle; the worker runs it every minute. */
export async function rollSprintCycles(
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  now = new Date(),
): Promise<RollReport> {
  const rows = await db
    .selectFrom('board')
    .selectAll()
    .where('kind', '=', 'scrum')
    .where(sql<boolean>`jsonb_typeof(sprint_settings -> 'cycle') = 'object'`)
    .orderBy('id')
    .execute();
  const report: RollReport = { boards: 0, prepared: 0, rolled: 0, failed: [] };
  for (const row of rows) {
    const settings = readSprintSettings(row.sprint_settings);
    const cycle = settings.cycle;
    if (!cycle || settings.parallelSprints) continue;
    report.boards += 1;
    const record = boardRecord(row);
    // The tickets the board shows to anyone: those carry over (AGL-011 (2)).
    let scope: RawBuilder<boolean>;
    try {
      const compiled = await compileBoard(
        db,
        await workspaceScope(db, catalogs, row.workspace_id),
        record,
        [],
        now,
      );
      scope = compiled.scope;
    } catch (error) {
      report.failed.push({ boardId: row.id, message: (error as Error).message });
      continue;
    }
    const board = { id: row.id, name: row.name, record, settings };
    const actor: SprintActor = { workspaceId: row.workspace_id, actorId: null };
    for (let i = 0; i < MAX_ROLLS_PER_PASS; i++) {
      const step = await db
        .transaction()
        .execute((trx) => rollOnce(trx, actor, board, cycle, scope, now));
      if (step === 'prepared') report.prepared += 1;
      if (step === 'rolled') report.rolled += 1;
      // After a roll, look again: the next sprint to make ready, or one more overdue cycle.
      if (step !== 'rolled' && step !== 'prepared') break;
    }
  }
  return report;
}

async function rollOnce(
  trx: Kysely<Database>,
  actor: SprintActor,
  board: Parameters<typeof completeSprint>[2],
  cycle: SprintCycle,
  scope: RawBuilder<boolean>,
  now: Date,
): Promise<Step> {
  const locked = await trx
    .selectFrom('board')
    .select('id')
    .where('id', '=', board.id)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
  if (!locked) return 'busy';
  const sprints = trx
    .selectFrom('sprint')
    .selectAll()
    .where('board_id', '=', board.id)
    .where('deleted_at', 'is', null);
  const active = await sprints
    .where('state', '=', 'active')
    .orderBy('started_at')
    .executeTakeFirst();
  if (!active?.end_at) return 'idle';
  const next = await sprints.where('state', '=', 'future').orderBy('sequence').executeTakeFirst();
  if (!next) {
    await createSprint(trx, actor, board, {
      startAt: active.end_at,
      endAt: addDays(active.end_at, cycle.lengthDays, cycle.timeZone),
    });
    return 'prepared';
  }
  if (now.getTime() < active.end_at.getTime()) return 'ready';
  // The boundary: the active sprint ends and its successor starts.
  const at = active.end_at;
  const completed = await completeSprint(
    trx,
    actor,
    board,
    active,
    scope,
    { type: 'sprint', sprintId: next.id },
    at,
  );
  if ('error' in completed) return 'idle';
  const startAt = next.start_at ?? at;
  const endAt =
    next.end_at && next.end_at.getTime() > startAt.getTime()
      ? next.end_at
      : addDays(startAt, cycle.lengthDays, cycle.timeZone);
  const started = await startSprint(trx, actor, { id: board.id, settings: board.settings }, next, {
    startAt,
    endAt,
    now: at,
  });
  return 'started' in started ? 'rolled' : 'idle';
}
