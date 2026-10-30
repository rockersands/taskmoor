import { fc } from '@taskmoor/testkit/property';
import {
  type Actor,
  type GuardNode,
  guardVerdict,
  type TicketState,
  type WorkflowDef,
} from '@taskmoor/workflow';
import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from './model';
import { type Mapper, mapDefinition, type RefKind } from './transfer';

const IDS = ['1', '2', '3', '4'];
const PERMISSIONS = ['browse_track', 'unknown_permission'];

const leaf: fc.Arbitrary<GuardNode> = fc.oneof(
  fc.constant<GuardNode>({ type: 'always-false' }),
  fc.constant<GuardNode>({ type: 'only-assignee' }),
  fc.constantFrom(...IDS).map((group): GuardNode => ({ type: 'user-in-group', group })),
  fc.constantFrom(...IDS).map((role): GuardNode => ({ type: 'user-in-role', role })),
  fc.subarray(IDS).map((groups): GuardNode => ({ type: 'user-in-any-group', groups })),
  fc.subarray(IDS).map((roles): GuardNode => ({ type: 'user-in-any-role', roles })),
  fc.constantFrom(...IDS).map((status): GuardNode => ({ type: 'previous-status', status })),
  fc.subarray(IDS).map((statuses): GuardNode => ({ type: 'subticket-blocking', statuses })),
  fc
    .constantFrom(...PERMISSIONS)
    .map((permission): GuardNode => ({ type: 'permission', permission })),
  fc
    .record({ op: fc.constantFrom('=' as const, '!=' as const), value: fc.constantFrom(...IDS) })
    .map((v): GuardNode => ({ type: 'value-field', field: 'priority', ...v })),
);
const guardTree: fc.Arbitrary<GuardNode> = fc.letrec<{ node: GuardNode }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.record({ all: fc.array(tie('node'), { maxLength: 4 }) }),
    fc.record({ any: fc.array(tie('node'), { maxLength: 4 }) }),
  ),
})).node;

/** What the other side has: ids map to themselves, the rest not at all. Status 1 always. */
const sideArb = fc.record({
  status: fc.subarray(IDS).map((x) => new Set(['1', ...x])),
  group: fc.subarray(IDS).map((x) => new Set(x)),
  role: fc.subarray(IDS).map((x) => new Set(x)),
  priority: fc.subarray(IDS).map((x) => new Set(x)),
});
type Side = { [K in 'status' | 'group' | 'role' | 'priority']: Set<string> };
const mapperOf = (side: Side | null): Mapper => ({
  ref: (kind: RefKind, id: number) =>
    side === null || side[kind as keyof Side]?.has(String(id)) ? id : null,
  field: () => true,
  permission: (key) => key !== 'unknown_permission',
});

const situation = fc.record({
  groups: fc.subarray(IDS),
  roles: fc.subarray(IDS),
  permissions: fc.subarray(PERMISSIONS),
  visited: fc.array(fc.constantFrom(...IDS), { maxLength: 4 }),
  subtickets: fc.array(fc.constantFrom(...IDS), { maxLength: 3 }),
  priority: fc.constantFrom(...IDS),
});

const definitionWith = (guards: GuardNode): WorkflowDefinition => ({
  initialStatusId: 1,
  statuses: [{ statusId: 1 }],
  transitions: [{ id: 1, name: 'Go', from: 'any', to: 1, guards }],
});
const engineWorkflow: WorkflowDef = {
  id: 'w',
  statuses: IDS.map((id) => ({ id, name: id, stage: 'active' })),
  initial: '1',
  transitions: [],
};

describe('workflow files: references that do not map (M1-127)', () => {
  it('[WF-011] never lets more people through a guard than the file did', () => {
    fc.assert(
      fc.property(guardTree, sideArb, situation, (guards, side, at) => {
        const mapped = mapDefinition(definitionWith(guards), mapperOf(side)).definition
          .transitions[0]?.guards as GuardNode;
        const ticket: TicketState = {
          status: '1',
          fields: { priority: at.priority },
          history: at.visited.map((to) => ({ field: 'status', from: null, to, by: 'u' })),
          subtickets: at.subtickets.map((status) => ({ status })),
        };
        const actor: Actor = {
          user: 'u',
          groups: at.groups,
          roles: at.roles,
          permissions: at.permissions,
        };
        const after = guardVerdict(engineWorkflow, mapped, ticket, actor);
        const before = guardVerdict(engineWorkflow, guards, ticket, actor);
        // Passing after the import means passing before it.
        if (after === undefined) expect(before).toBeUndefined();
      }),
    );
  });

  it('[WF-011] keeps a definition identical when everything maps to itself', () => {
    fc.assert(
      fc.property(guardTree, (guards) => {
        const { definition, findings } = mapDefinition(definitionWith(guards), mapperOf(null));
        expect(definition).toEqual(definitionWith(guards));
        expect(findings.filter((f) => f.kind !== 'permission')).toEqual([]);
      }),
    );
  });

  it('[WF-011] disables a transition whose check or restriction did not map, keeping its guards', () => {
    const { definition, findings } = mapDefinition(
      {
        initialStatusId: 1,
        statuses: [{ statusId: 1 }, { statusId: 2 }],
        transitions: [
          {
            id: 1,
            name: 'Go',
            from: [1],
            to: 2,
            guards: { any: [{ type: 'only-assignee' }] },
            checks: [{ type: 'previous-state', status: '9' }],
          },
          { id: 2, name: 'Back', from: [2], to: 1 },
        ],
        rules: { '2': [{ type: 'restrict-been-through', status: '9' }] },
      },
      { ...mapperOf(null), ref: (kind, id) => (kind === 'status' && id === 9 ? null : id) },
    );
    expect(definition.transitions.map((t) => t.guards)).toEqual([
      { all: [{ type: 'always-false' }, { any: [{ type: 'only-assignee' }] }] },
      { type: 'always-false' },
    ]);
    expect(definition.transitions[0]?.checks).toEqual([]);
    expect(definition.rules).toEqual({ '2': [] });
    expect(findings.map((f) => `${f.rule}:${f.outcome}`)).toEqual([
      'previous-state:transition_disabled',
      'restrict-been-through:transition_disabled',
    ]);
  });
});
