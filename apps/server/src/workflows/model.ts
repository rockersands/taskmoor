import type { StatusStage } from '@taskmoor/db';
import { z } from 'zod';

/**
 * Workflows as data (M1-023; WF-001, WF-002, WF-008; spec 01a section 3). A version's
 * definition lists the statuses it uses, its initial status and its transitions. A
 * transition goes from a list of statuses, or from any status (a global transition), to one
 * status; it may loop back to a status it starts from. Guards, checks, effects and layouts
 * join the transition in M1-024 to M1-027.
 */
const MAX_INT = 2_147_483_647;
const id = z.number().int().positive().max(MAX_INT);

/** Guardrail of spec 01a section 1.7: statuses per workflow. */
export const STATUSES_PER_WORKFLOW = 200;
export const TRANSITIONS_PER_WORKFLOW = 2000;

export const transitionSchema = z
  .object({
    /** Stable across versions, so history and integrations can name it. */
    id,
    name: z.string().trim().min(1).max(255),
    description: z.string().max(2000).optional(),
    from: z.union([z.literal('any'), z.array(id).min(1).max(STATUSES_PER_WORKFLOW)]),
    to: id,
  })
  .strict();
export type Transition = z.infer<typeof transitionSchema>;

export const definitionSchema = z
  .object({
    initialStatusId: id,
    statuses: z
      .array(
        z
          .object({
            statusId: id,
            /** Where the editor's diagram draws it. */
            x: z.number().finite().optional(),
            y: z.number().finite().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(STATUSES_PER_WORKFLOW),
    transitions: z.array(transitionSchema).max(TRANSITIONS_PER_WORKFLOW),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof definitionSchema>;

export type DefinitionProblem =
  | { problem: 'unknown_status'; statusId: number }
  | { problem: 'duplicate_status'; statusId: number }
  | { problem: 'initial_not_in_workflow' }
  | { problem: 'duplicate_transition'; transitionId: number }
  | { problem: 'transition_status_not_in_workflow'; transitionId: number; statusId: number };

/** Why a definition cannot be saved, or null. `known` holds the workspace's statuses. */
export function definitionProblem(
  definition: WorkflowDefinition,
  known: ReadonlySet<number>,
): DefinitionProblem | null {
  const statuses = new Set<number>();
  for (const { statusId } of definition.statuses) {
    if (!known.has(statusId)) return { problem: 'unknown_status', statusId };
    if (statuses.has(statusId)) return { problem: 'duplicate_status', statusId };
    statuses.add(statusId);
  }
  if (!statuses.has(definition.initialStatusId)) return { problem: 'initial_not_in_workflow' };
  const ids = new Set<number>();
  for (const t of definition.transitions) {
    if (ids.has(t.id)) return { problem: 'duplicate_transition', transitionId: t.id };
    ids.add(t.id);
    for (const statusId of [...(t.from === 'any' ? [] : t.from), t.to]) {
      if (!statuses.has(statusId)) {
        return { problem: 'transition_status_not_in_workflow', transitionId: t.id, statusId };
      }
    }
  }
  return null;
}

export const statusIdsOf = (definition: WorkflowDefinition): Set<number> =>
  new Set(definition.statuses.map((s) => s.statusId));

/**
 * The transitions offered from a status, in the definition's order. A global transition is
 * offered from every status but the one it leads to.
 */
export function transitionsFrom(definition: WorkflowDefinition, statusId: number): Transition[] {
  return definition.transitions.filter((t) =>
    t.from === 'any' ? t.to !== statusId : t.from.includes(statusId),
  );
}

/** Statuses in `before` that `after` no longer has. */
export function removedStatuses(before: WorkflowDefinition, after: WorkflowDefinition): number[] {
  const kept = statusIdsOf(after);
  return [...statusIdsOf(before)].filter((s) => !kept.has(s)).sort((a, b) => a - b);
}

/**
 * What a change of status does to the close reason and the Closed time stamp (WF-008):
 * entering the closed stage closes the ticket with the reason given, the one it has, or the
 * workspace's first close reason; leaving it clears both. Within a stage they stay, but a
 * reason given replaces the one there.
 */
export function closing(
  from: StatusStage,
  to: StatusStage,
  ticket: { closeReasonId: number | null; closedAt: Date | null },
  given: number | null | undefined,
  defaultReasonId: number | null,
  now: Date,
): { closeReasonId: number | null; closedAt: Date | null } {
  if (to !== 'closed') {
    return from === 'closed' ? { closeReasonId: null, closedAt: null } : ticket;
  }
  const closeReasonId = given ?? ticket.closeReasonId ?? defaultReasonId;
  if (from === 'closed') return { closeReasonId, closedAt: ticket.closedAt ?? now };
  return { closeReasonId, closedAt: now };
}
