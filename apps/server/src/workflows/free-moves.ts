import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { emit } from '../events/bus';
import { closingReasonId } from './board-managed';
import { freeTransition, statusesWantingFreeMove } from './free-moving';
import { definitionSchema, type WorkflowDefinition } from './model';
import { heldStatusInfo, holdCurrentVersions, rewriteCurrentVersions } from './store';

/**
 * The free moves the server gives a workflow beyond the editor's (WF-008 (4); ADR-116): a draft's
 * new statuses (T-210), a workflow published or imported with no transitions at all (T-246), and
 * an old workflow left with none (T-237; migration 0107 gave every such workflow its moves at the
 * upgrade, and `cli.mjs workflow-moves` checks that none is left). A publish or a file imported as
 * a new workflow that wanted them and could get none is refused (T-260).
 */

/**
 * A draft with the free moves its new statuses get (T-210; WF-008 (4)), as the editor's Add a
 * status gives them: see `statusesWantingFreeMove`. A closing status takes the reason free moves
 * close with, and none when the workspace has no reason to name. New transitions number above
 * every id any version of the workflow used, since history names transitions by id. A draft the
 * additions would push past a limit is saved as sent, and so is one sent with
 * `transitionsAsSent` that has any transition. The caller holds the workflow; the stages are read
 * once the statuses are held too (`heldStatusInfo`), so a stage change that holds one of them is
 * waited for and its new stage decides the effect (T-237).
 */
export async function withFreeMoves(
  trx: Transaction<Database>,
  workspaceId: number,
  workflowId: number,
  current: WorkflowDefinition,
  draft: WorkflowDefinition,
  transitionsAsSent: boolean,
): Promise<WorkflowDefinition> {
  const wanting = statusesWantingFreeMove(current, draft, transitionsAsSent);
  if (wanting.length === 0) return draft;
  // Every status of the draft is held at once, in id order, not only those that get a move: the
  // version written next holds the rest, and one held out of order deadlocks with a board's sync.
  const info = await heldStatusInfo(
    trx,
    workspaceId,
    draft.statuses.map((s) => s.statusId),
  );
  const closing = wanting.some((id) => info.get(id)?.stage === 'closed')
    ? await closingReasonId(trx, workspaceId)
    : null;
  const used = await sql<{ n: number | null }>`
    SELECT max((t ->> 'id')::int) AS n
      FROM workflow_version v, jsonb_array_elements(v.definition -> 'transitions') t
     WHERE v.workflow_id = ${workflowId}`.execute(trx);
  let next = Math.max(Number(used.rows[0]?.n ?? 0), ...draft.transitions.map((t) => t.id)) + 1;
  const added = wanting.flatMap((statusId) => {
    const status = info.get(statusId);
    if (!status) return [];
    if (status.stage !== 'closed')
      return [freeTransition(statusId, status.name, false, null, next++)];
    return closing === null ? [] : [freeTransition(statusId, status.name, true, closing, next++)];
  });
  if (added.length === 0) return draft;
  const shaped = { ...draft, transitions: [...draft.transitions, ...added] };
  return definitionSchema.safeParse(shaped).success ? shaped : draft;
}

/**
 * A definition about to be published or imported with no transitions at all, with the free moves
 * a new workflow gets (T-246; WF-008 (4); ADR-116): a global transition into every status, as
 * `withFreeMoves` gives a draft with none. A definition with any transition, one with a rule and a
 * board-managed one stay as they are. One whose every status is in the closed stage, with no close
 * reason for free moves to close with, gets none: `noMovesPossible` tells the publish and the file
 * import to refuse it (T-260). The caller holds the workflow (or has just made it).
 */
export async function withMovesIfNone(
  trx: Transaction<Database>,
  workspaceId: number,
  workflowId: number,
  definition: WorkflowDefinition,
): Promise<WorkflowDefinition> {
  if (definition.transitions.length > 0) return definition;
  return withFreeMoves(trx, workspaceId, workflowId, definition, definition, true);
}

/**
 * Whether a definition wanted free moves and could get none (T-260; WF-008 (4)): it has no
 * transitions, no rule and no board, so `withMovesIfNone` meant to give it a move into every
 * status, and `moved`, what that gave, still has none. That happens when every status is in the
 * closed stage and no close reason can be set: none is named Completed, and the default workflow
 * sets none when it closes (`closingReasonId`). Published so, no ticket could ever move. A
 * definition with a rule or a board was never meant to get them, and stays as it is (ADR-116).
 */
export function noMovesPossible(
  definition: WorkflowDefinition,
  moved: WorkflowDefinition,
): boolean {
  return (
    definition.transitions.length === 0 &&
    moved.transitions.length === 0 &&
    statusesWantingFreeMove(definition, definition, true).length > 0
  );
}

/**
 * The workflows of a workspace whose published version has no transitions, by id: no ticket in
 * them can move. A new workflow, a saved draft, a publish and an import with none get their free
 * moves, and migration 0107 gave them to every workflow left without (T-246), so on an upgraded
 * site this finds only what free moves cannot fix: a workflow with a rule, one a board manages,
 * and one whose only statuses close with no reason to name.
 */
export async function workflowsWithoutMoves(
  db: Kysely<Database>,
  workspaceId: number,
): Promise<number[]> {
  const { rows } = await sql<{ id: number }>`
    SELECT w.id
      FROM workflow w
      JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
     WHERE w.workspace_id = ${workspaceId}
       AND jsonb_array_length(coalesce(v.definition -> 'transitions', '[]'::jsonb)) = 0
     ORDER BY w.id`.execute(db);
  return rows.map((r) => r.id);
}

export interface WorkflowMovesRun {
  /** Workflows whose published version had no transitions. */
  found: number[];
  /** Those given their free moves as a new published version. */
  repaired: number[];
}

/**
 * The operator's check and repair for old workflows left with no moves (T-237; `cli.mjs
 * workflow-moves`): lists them, and with `repair` gives each one a global transition into every
 * status, as a new workflow gets (WF-008 (4)), as a new published version. Migration 0107 does the
 * same at the upgrade with the same rules (T-246), so after it this lists only the workflows free
 * moves leave alone and `repair` has nothing to give. A closing status takes the reason free
 * moves close with; with none to name it gets no move and nothing is made. One transaction and one
 * event (`workflow.published`, by the system) per workflow. Each is held as a publish holds it
 * (update, so ticket writes on it wait), then its statuses, and checked again under the lock: one
 * given transitions meanwhile is left as it is. Its draft, if it has one, stays as its author saved
 * it, above the new version, as migration 0104 left drafts; saving it gives it its free moves too.
 * A workflow with a rule, or one a board manages, gets nothing and stays listed.
 */
export async function repairWorkflowMoves(
  db: Kysely<Database>,
  workspaceId: number,
  options: { repair: boolean },
): Promise<WorkflowMovesRun> {
  const found = await workflowsWithoutMoves(db, workspaceId);
  if (!options.repair) return { found, repaired: [] };
  const repaired: number[] = [];
  for (const id of found) {
    const done = await db.transaction().execute(async (trx) => {
      const [w] = await holdCurrentVersions(trx, [id]);
      if (!w || w.published.transitions.length > 0) return false;
      const published = await withFreeMoves(
        trx,
        workspaceId,
        w.id,
        w.published,
        w.published,
        false,
      );
      if (published.transitions.length === 0) return false;
      const version = await rewriteCurrentVersions(trx, workspaceId, null, w, published, null);
      if (version === null) return false;
      await emit(
        trx,
        { workspaceId, actorId: null },
        {
          type: 'workflow.published',
          subjectId: w.id,
          payload: { version, removedStatuses: [], statusMapping: {}, ticketCount: 0 },
        },
      );
      return true;
    });
    if (done) repaired.push(id);
  }
  return { found, repaired };
}
