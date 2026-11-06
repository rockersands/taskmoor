import type { StatusStage } from '@taskmoor/db';
import type { EffectDef } from '@taskmoor/workflow';
import type { Transition, WorkflowDefinition } from './model';

/**
 * What a move into a status does on a workflow that moves freely (the user's decision of
 * 2026-11-04; WF-008; ADR-116): a closing status takes the close reason Completed, any other
 * clears the reason. Nothing else: no form, no required field, no check and no guard. Why a ticket
 * moved goes in a comment.
 */
export const freeMoveEffects = (closes: boolean, completedId: number | null): EffectDef[] =>
  closes && completedId !== null
    ? [{ type: 'update-system-field', field: 'close-reason', value: String(completedId) }]
    : [{ type: 'clear-field', field: 'close-reason' }];

/** One global transition into a status. The status id names it unless `id` says otherwise. */
export const freeTransition = (
  statusId: number,
  name: string,
  closes: boolean,
  completedId: number | null,
  id: number = statusId,
): Transition => ({
  id,
  name,
  from: 'any',
  to: statusId,
  effects: freeMoveEffects(closes, completedId),
});

/**
 * The transitions that let any ticket go to any of these statuses at once: one global transition
 * each, named after its status. A status in the closed stage closes tickets.
 */
export const freeTransitions = (
  statuses: readonly { id: number; name: string; stage: StatusStage }[],
  completedId: number | null,
): Transition[] =>
  statuses.map((s) => freeTransition(s.id, s.name, s.stage === 'closed', completedId));

/**
 * Whether a transition moves freely: global, and with nothing someone put on it as a rule. Effects
 * do not count: they ask nothing of the person moving the ticket.
 */
export const movesFreely = (t: Transition, definition: WorkflowDefinition): boolean =>
  t.from === 'any' &&
  !t.guards &&
  (t.checks?.length ?? 0) === 0 &&
  (t.layout?.length ?? 0) === 0 &&
  (definition.rules?.[String(t.id)]?.length ?? 0) === 0;

/** Whether a whole definition moves freely: every transition does, and no rule is set anywhere. */
export const workflowMovesFreely = (definition: WorkflowDefinition): boolean =>
  Object.keys(definition.rules ?? {}).length === 0 &&
  definition.transitions.every((t) => movesFreely(t, definition));

const CLOSE_REASON = 'close-reason';

/**
 * Whether these effects are exactly what a free move does: setting the reason free moves close
 * with (`completedId`) when `closes`, clearing the reason otherwise. Anything else, another reason
 * included, someone put there on purpose.
 */
function freeMoveShaped(
  effects: readonly EffectDef[] | undefined,
  closes: boolean,
  completedId: number,
): boolean {
  if (effects?.length !== 1) return false;
  const [effect] = effects;
  if (!effect || !('field' in effect) || effect.field !== CLOSE_REASON) return false;
  return closes
    ? effect.type === 'update-system-field' && effect.value === String(completedId)
    : effect.type === 'clear-field';
}

/**
 * The definition with its free moves into a status following the status's new stage (T-209;
 * WF-008): one that cleared the close reason sets `completedId`, the reason free moves close with,
 * when the status became closed-stage, and one that set that reason clears it when the status left
 * the closed stage. A move with a rule, another effect or another reason someone chose stays as it
 * is, and so does a board-managed workflow, whose board says which column closes. Null when nothing
 * changes, or when there is no reason to close with.
 */
export function followingStage(
  definition: WorkflowDefinition,
  statusId: number,
  closes: boolean,
  completedId: number | null,
): WorkflowDefinition | null {
  if (definition.board || completedId === null) return null;
  let changed = false;
  const transitions = definition.transitions.map((t) => {
    if (
      t.to !== statusId ||
      !movesFreely(t, definition) ||
      !freeMoveShaped(t.effects, !closes, completedId)
    ) {
      return t;
    }
    changed = true;
    return { ...t, effects: freeMoveEffects(closes, completedId) };
  });
  return changed ? { ...definition, transitions } : null;
}

/**
 * The statuses of a draft that get a free move when it is saved (T-210; WF-008 (4)), as the
 * editor's Add a status gives one: on a workflow that moves freely, kept free by the draft, each
 * status the draft adds that no transition reaches. A workflow with no transitions, before or in
 * the draft, gets one into every status no transition reaches, as a new workflow does. Anything
 * else is the administrator's to draw. With `transitionsAsSent` (the web editor, whose Add a status
 * gives the status its free move, so a move missing now was deleted on purpose) only a draft with
 * no transitions at all gets them.
 */
export function statusesWantingFreeMove(
  base: WorkflowDefinition,
  draft: WorkflowDefinition,
  transitionsAsSent = false,
): number[] {
  // A board-managed workflow's board says which columns there are and which one closes.
  if (base.board || draft.board) return [];
  const reached = new Set(draft.transitions.map((t) => t.to));
  const unreached = draft.statuses.map((s) => s.statusId).filter((id) => !reached.has(id));
  if (draft.transitions.length === 0) return workflowMovesFreely(draft) ? unreached : [];
  if (transitionsAsSent) return [];
  if (base.transitions.length === 0) return workflowMovesFreely(draft) ? unreached : [];
  if (!workflowMovesFreely(base) || !workflowMovesFreely(draft)) return [];
  const had = new Set(base.statuses.map((s) => s.statusId));
  return unreached.filter((id) => !had.has(id));
}
