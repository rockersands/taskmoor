import { fc } from '@taskmoor/testkit/property';
import { engine, type WorkflowDef } from '@taskmoor/workflow';
import { describe, expect, it } from 'vitest';
import { workflowArb } from '../test/workflow';
import type { GuardNode, Stage, Transition, WorkflowDefinition } from './definition';
import { guardDepth, lintDefinition, neverHolds, reachableStatuses } from './lint';

const stages = (entries: [number, Stage][]) => new Map(entries);
const ALL: Map<number, Stage> = stages([
  [1, 'new'],
  [2, 'active'],
  [3, 'active'],
  [4, 'closed'],
  [5, 'closed'],
  [6, 'active'],
]);

/** Open (1), Active (2), Review (3), Done (4), Cancelled (5), with a global Cancel. */
const base = (transitions: Transition[], statuses = [1, 2, 3, 4, 5]): WorkflowDefinition => ({
  initialStatusId: 1,
  statuses: statuses.map((statusId) => ({ statusId })),
  transitions,
});
const t = (id: number, from: Transition['from'], to: number, more: Partial<Transition> = {}) => ({
  id,
  name: `T${id}`,
  from,
  to,
  ...more,
});
const STANDARD = [
  t(1, [1], 2),
  t(2, [2], 3),
  t(3, [3], 2),
  t(4, [3], 4),
  t(5, [4, 5], 1),
  t(6, 'any', 5),
];

/** The simplest reading of "reachable": add targets until nothing changes. */
function referenceReachable(definition: WorkflowDefinition): Set<number> {
  const inWorkflow = new Set(definition.statuses.map((s) => s.statusId));
  const reached = new Set<number>();
  if (!inWorkflow.has(definition.initialStatusId)) return reached;
  reached.add(definition.initialStatusId);
  for (let changed = true; changed; ) {
    changed = false;
    for (const x of definition.transitions) {
      if (!inWorkflow.has(x.to) || reached.has(x.to) || neverHolds(x.guards)) continue;
      const sources = x.from === 'any' ? [...reached] : x.from;
      if (sources.some((s) => reached.has(s))) {
        reached.add(x.to);
        changed = true;
      }
    }
  }
  return reached;
}

/** The same workflow in the engine's terms: ids as text, stages on the statuses. */
function toEngine(definition: WorkflowDefinition, stageOf: Map<number, Stage>): WorkflowDef {
  return {
    id: 'w',
    statuses: definition.statuses.map((s) => ({
      id: String(s.statusId),
      name: String(s.statusId),
      stage: stageOf.get(s.statusId) ?? 'new',
    })),
    initial: String(definition.initialStatusId),
    transitions: definition.transitions.map((x) => ({
      id: String(x.id),
      name: x.name,
      from: x.from === 'any' ? 'any' : x.from.map(String),
      to: String(x.to),
      ...(x.guards ? { guards: x.guards } : {}),
    })),
  };
}

describe('workflow checks before publishing (M1-030)', () => {
  it('[WF-012] the standard workflow has no warnings', () => {
    expect(lintDefinition(base(STANDARD), ALL)).toEqual([]);
  });

  it('[WF-012] a status no transition leads to is unreachable, named as such', () => {
    const definition = base([...STANDARD, t(7, [6], 1)], [1, 2, 3, 4, 5, 6]);
    expect(lintDefinition(definition, ALL)).toEqual([
      { kind: 'unreachable-status', severity: 'warning', statusId: 6, entered: false },
    ]);
  });

  it('[WF-012] a status reached only from unreachable statuses is unreachable too', () => {
    // Start (1) is gone: nothing reaches Active, so Review and Done follow; Cancel still works.
    const issues = lintDefinition(base(STANDARD.slice(1)), ALL);
    expect(issues).toEqual([
      { kind: 'unreachable-status', severity: 'warning', statusId: 2, entered: true },
      { kind: 'unreachable-status', severity: 'warning', statusId: 3, entered: true },
      { kind: 'unreachable-status', severity: 'warning', statusId: 4, entered: true },
    ]);
  });

  it('[WF-012] a self-loop does not make a status reachable', () => {
    const definition = base([...STANDARD, t(7, [6], 6), t(8, [6], 1)], [1, 2, 3, 4, 5, 6]);
    expect(lintDefinition(definition, ALL)).toContainEqual({
      kind: 'unreachable-status',
      severity: 'warning',
      statusId: 6,
      entered: false,
    });
  });

  it('[WF-012] a transition whose guards never pass leads nowhere', () => {
    const definition = base([
      t(1, [1], 2, { guards: { all: [{ type: 'only-assignee' }, { type: 'always-false' }] } }),
      ...STANDARD.slice(1),
    ]);
    const issues = lintDefinition(definition, ALL);
    expect(issues).toContainEqual({
      kind: 'unsatisfiable-guard',
      severity: 'warning',
      transitionId: 1,
    });
    expect(issues).toContainEqual({
      kind: 'unreachable-status',
      severity: 'warning',
      statusId: 2,
      entered: true,
    });
  });

  it('[WF-012] a status outside the closed stage with no exit is flagged; closed ones are not', () => {
    const issues = lintDefinition(base([t(1, [1], 2), t(2, [2], 4), t(3, [1], 3)]), ALL);
    expect(issues).toContainEqual({ kind: 'no-exit', severity: 'warning', statusId: 3 });
    expect(issues.filter((i) => i.kind === 'no-exit')).toHaveLength(1);
  });

  it('[WF-012] a global transition is an exit from every status but its own target', () => {
    const issues = lintDefinition(base([t(1, [1], 2), t(2, 'any', 3)], [1, 2, 3]), ALL);
    expect(issues).toEqual([{ kind: 'no-exit', severity: 'warning', statusId: 3 }]);
  });

  it('[WF-012] contradictory number bounds can never pass', () => {
    expect(
      neverHolds({
        all: [
          { type: 'compare-number', field: 'original-estimate', op: '>', value: 5 },
          { type: 'compare-number', field: 'original-estimate', op: '<', value: 3 },
        ],
      }),
    ).toBe(true);
    expect(neverHolds({ any: [{ type: 'only-assignee' }, { type: 'always-false' }] })).toBe(false);
    expect(neverHolds({ any: [] })).toBe(false);
  });

  it('[WF-002] errors name what the server would refuse', () => {
    const definition: WorkflowDefinition = {
      initialStatusId: 9,
      statuses: [{ statusId: 77 }, { statusId: 1 }, { statusId: 1 }],
      transitions: [
        t(1, [1, 8], 1),
        t(1, [1], 9),
        t(2, [1], 1, {
          guards: Array.from({ length: 10 }).reduce<GuardNode>((inner) => ({ all: [inner] }), {
            type: 'only-assignee',
          }),
        }),
      ],
    };
    const kinds = lintDefinition(definition, ALL)
      .filter((i) => i.severity === 'error')
      .map((i) => i.kind);
    expect(kinds).toEqual([
      'unknown-status',
      'duplicate-status',
      'initial-missing',
      'missing-source',
      'duplicate-transition',
      'missing-target',
      'guards-too-deep',
    ]);
    expect(guardDepth({ all: [{ any: [{ type: 'only-assignee' }] }] })).toBe(3);
  });

  it('[WF-012] reachability agrees with a plain fixpoint over random workflows', () => {
    fc.assert(
      fc.property(workflowArb({ guards: true }), ({ definition }) => {
        expect([...reachableStatuses(definition)].sort()).toEqual(
          [...referenceReachable(definition)].sort(),
        );
        const unreachable = lintDefinition(definition, new Map())
          .filter((i) => i.kind === 'unreachable-status')
          .map((i) => ('statusId' in i ? i.statusId : 0));
        const reached = referenceReachable(definition);
        expect(unreachable.sort()).toEqual(
          definition.statuses
            .map((s) => s.statusId)
            .filter((id) => !reached.has(id))
            .sort(),
        );
      }),
    );
  });

  it('[WF-012] agrees with the engine on exits and unsatisfiable guards, and finds every status it calls unreachable', () => {
    fc.assert(
      fc.property(workflowArb({ guards: true }), ({ definition, stages: stageOf }) => {
        const ours = lintDefinition(definition, stageOf);
        const theirs = engine.lint(toEngine(definition, stageOf), []);
        const pick = (kind: string, list: { kind: string; at: string }[]) =>
          list
            .filter((w) => w.kind === kind)
            .map((w) => w.at)
            .sort();
        const mine = ours.map((i) => ({
          kind: i.kind,
          at: String('statusId' in i ? i.statusId : 'transitionId' in i ? i.transitionId : ''),
        }));
        expect(pick('no-exit', mine)).toEqual(pick('no-exit', theirs));
        expect(pick('unsatisfiable-guard', mine)).toEqual(pick('unsatisfiable-guard', theirs));
        // The engine flags statuses nothing leads to; those are exactly ours with entered false.
        const notEntered = ours
          .filter((i) => i.kind === 'unreachable-status' && !i.entered)
          .map((i) => ('statusId' in i ? String(i.statusId) : ''))
          .sort();
        expect(notEntered).toEqual(pick('unreachable-status', theirs));
      }),
    );
  });
});
