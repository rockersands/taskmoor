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
