import {
  type GuardNode,
  LIMITS,
  type Stage,
  startsFrom,
  type WorkflowDefinition,
} from './definition';

/**
 * The editor's checks before publishing (WF-012, M1-030), computed from the definition alone.
 *
 * Errors are what the server would refuse on save: a status the workspace does not have, an
 * initial status or a transition end outside the workflow, a repeated id, guards nested too
 * deep. Warnings are allowed but worth a look:
 * - an unreachable status: no path of runnable transitions leads to it from the initial status
 *   (a transition whose guards never pass does not count, and neither does a self-loop);
 * - a status with no exit: no transition leaves it for another status, outside the closed
 *   stage (a global transition is an exit from every status but its own target);
 * - guards no one can satisfy, as the engine judges them (`always-false`, an `all` group with
 *   such a member or with contradictory number bounds, an `any` group of only such members).
 * Statuses unmapped on boards join when boards exist (M1-043).
 */
export type LintIssue =
  | { kind: 'unknown-status'; severity: 'error'; statusId: number }
  | { kind: 'duplicate-status'; severity: 'error'; statusId: number }
  | { kind: 'initial-missing'; severity: 'error'; statusId: number }
  | { kind: 'duplicate-transition'; severity: 'error'; transitionId: number }
  | { kind: 'missing-target'; severity: 'error'; transitionId: number; statusId: number }
  | { kind: 'missing-source'; severity: 'error'; transitionId: number; statusId: number }
  | { kind: 'guards-too-deep'; severity: 'error'; transitionId: number }
  | { kind: 'unreachable-status'; severity: 'warning'; statusId: number; entered: boolean }
  | { kind: 'no-exit'; severity: 'warning'; statusId: number }
  | { kind: 'unsatisfiable-guard'; severity: 'warning'; transitionId: number };

export type LintKind = LintIssue['kind'];

/** True when no person, ticket or channel can satisfy a guard tree (as the engine decides). */
export function neverHolds(node: GuardNode | undefined): boolean {
  if (!node) return false;
  if ('any' in node) return node.any.length > 0 && node.any.every(neverHolds);
  if ('all' in node) {
    if (node.all.some(neverHolds)) return true;
    // Bounds on one number field that no value meets, such as > 5 and < 3.
    type Bound = Extract<GuardNode, { type: 'compare-number' }>;
    const bounds = node.all.filter((g): g is Bound => 'type' in g && g.type === 'compare-number');
    const lowest = (b: Bound) =>
      b.op === '>' ? b.value + 1e-9 : b.op === '>=' || b.op === '=' ? b.value : undefined;
    const highest = (b: Bound) =>
      b.op === '<' ? b.value - 1e-9 : b.op === '<=' || b.op === '=' ? b.value : undefined;
    return bounds.some((a) =>
      bounds.some((b) => {
        if (a.field !== b.field) return false;
        const low = lowest(a);
        const high = highest(b);
        return low !== undefined && high !== undefined && low > high;
      }),
    );
  }
  return node.type === 'always-false';
}

/** How deep a guard tree nests; a lone guard is 1, as the server counts. */
export function guardDepth(node: GuardNode | undefined): number {
  if (!node) return 0;
  if ('all' in node) return 1 + Math.max(0, ...node.all.map(guardDepth));
  if ('any' in node) return 1 + Math.max(0, ...node.any.map(guardDepth));
  return 1;
}

/**
 * Statuses a ticket can get to from the initial status, breadth first over the transitions
 * that can run. Global transitions are offered from every reached status.
 */
export function reachableStatuses(definition: WorkflowDefinition): Set<number> {
  const inWorkflow = new Set(definition.statuses.map((s) => s.statusId));
  const runnable = definition.transitions.filter(
    (t) => inWorkflow.has(t.to) && !neverHolds(t.guards),
  );
  const out = new Map<number, number[]>();
  const global: number[] = [];
  for (const t of runnable) {
    if (t.from === 'any') global.push(t.to);
    else for (const s of t.from) out.set(s, [...(out.get(s) ?? []), t.to]);
  }
  const reached = new Set<number>();
  if (!inWorkflow.has(definition.initialStatusId)) return reached;
  const queue = [definition.initialStatusId];
  reached.add(definition.initialStatusId);
  // Every global target is one step from the first status reached, which is the initial one.
  for (const to of global) {
    if (!reached.has(to)) {
      reached.add(to);
      queue.push(to);
    }
  }
  while (queue.length > 0) {
    const at = queue.shift() as number;
    for (const to of out.get(at) ?? []) {
      if (reached.has(to)) continue;
      reached.add(to);
      queue.push(to);
    }
  }
  return reached;
}

/**
 * Every problem with a definition, errors first. `stages` holds the workspace's statuses by id;
 * a status missing from it is unknown to the workspace (deleted since).
 */
export function lintDefinition(
  definition: WorkflowDefinition,
  stages: ReadonlyMap<number, Stage>,
): LintIssue[] {
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  const ids = definition.statuses.map((s) => s.statusId);
  const inWorkflow = new Set<number>();
  for (const id of ids) {
    if (!stages.has(id)) errors.push({ kind: 'unknown-status', severity: 'error', statusId: id });
    if (inWorkflow.has(id)) {
      errors.push({ kind: 'duplicate-status', severity: 'error', statusId: id });
    }
    inWorkflow.add(id);
  }
  if (!inWorkflow.has(definition.initialStatusId)) {
    errors.push({
      kind: 'initial-missing',
      severity: 'error',
      statusId: definition.initialStatusId,
    });
  }
  const seen = new Set<number>();
  for (const t of definition.transitions) {
    if (seen.has(t.id)) {
      errors.push({ kind: 'duplicate-transition', severity: 'error', transitionId: t.id });
    }
    seen.add(t.id);
    for (const from of t.from === 'any' ? [] : t.from) {
      if (!inWorkflow.has(from)) {
        errors.push({
          kind: 'missing-source',
          severity: 'error',
          transitionId: t.id,
          statusId: from,
        });
      }
    }
    if (!inWorkflow.has(t.to)) {
      errors.push({
        kind: 'missing-target',
        severity: 'error',
        transitionId: t.id,
        statusId: t.to,
      });
    }
    if (guardDepth(t.guards) > LIMITS.guardDepth) {
      errors.push({ kind: 'guards-too-deep', severity: 'error', transitionId: t.id });
    }
  }

  const reached = reachableStatuses(definition);
  for (const id of new Set(ids)) {
    if (!reached.has(id)) {
      // Whether any transition from another status leads here at all, runnable or not.
      const entered = definition.transitions.some(
        (t) =>
          t.to === id &&
          (t.from === 'any' ? ids.some((x) => x !== id) : t.from.some((x) => x !== id)),
      );
      warnings.push({ kind: 'unreachable-status', severity: 'warning', statusId: id, entered });
    }
    const stage = stages.get(id);
    const leaves = definition.transitions.some(
      (t) => startsFrom(t, id) && t.to !== id && inWorkflow.has(t.to),
    );
    if (stage !== undefined && stage !== 'closed' && !leaves) {
      warnings.push({ kind: 'no-exit', severity: 'warning', statusId: id });
    }
  }
  for (const t of definition.transitions) {
    if (neverHolds(t.guards)) {
      warnings.push({ kind: 'unsatisfiable-guard', severity: 'warning', transitionId: t.id });
    }
  }
  return [...errors, ...warnings];
}

export const hasErrors = (issues: readonly LintIssue[]) =>
  issues.some((i) => i.severity === 'error');
