import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { SECTIONS } from './conformance/case';
import { WORKFLOW_CASES } from './conformance/cases';
import { runConformance } from './conformance/run';
import { engine } from './engine';
import type { Actor, Channel, GuardNode, HistoryEntry, TicketState, WorkflowDef } from './model';
import { ReferenceEngine } from './reference';

const requirementsOf = (section: string) =>
  [
    ...new Set(
      WORKFLOW_CASES.filter((c) => c.section === section).map((c) => `[${c.requirement}]`),
    ),
  ].join(' ');

describe('the workflow engine on the conformance suite', () => {
  const report = runConformance(engine, WORKFLOW_CASES);

  for (const section of SECTIONS) {
    it(`${requirementsOf(section)} ${section} cases pass on the engine`, () => {
      const own = report.results.filter((r) => r.section === section);
      expect(own.length).toBeGreaterThan(0);
      expect(own.filter((r) => r.status !== 'pass').map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
    });
  }
});

// Random guard trees, tickets and actors over small domains, so the leaves often hold and
// often fail.
const USERS = ['alice', 'bob', 'carol'];
const GROUPS = ['g1', 'g2', 'g3'];
const ROLES = ['r1', 'r2'];
const STATUSES = ['open', 'in-progress', 'review', 'done'];
const PERMISSIONS = ['edit_tickets', 'close_tickets'];
const OPS = ['=', '!=', '>', '>=', '<', '<='] as const;
const TRANSITIONS = ['start', 'review', 'finish'];

const leaf: fc.Arbitrary<GuardNode> = fc.oneof(
  fc.constant<GuardNode>({ type: 'always-false' }),
  fc.constant<GuardNode>({ type: 'block-until-approval' }),
  fc.record({
    type: fc.constant('compare-number' as const),
    field: fc.constantFrom('points', 'missing'),
    op: fc.constantFrom(...OPS),
    value: fc.integer({ min: 0, max: 5 }),
  }),
  fc.constant<GuardNode>({ type: 'hide-from-user' }),
  fc.constant<GuardNode>({ type: 'only-assignee' }),
  fc.constant<GuardNode>({ type: 'only-requester' }),
  fc.record({
    type: fc.constant('permission' as const),
    permission: fc.constantFrom(...PERMISSIONS),
  }),
  fc.record({
    type: fc.constant('previous-status' as const),
    status: fc.constantFrom(...STATUSES),
    mostRecentOnly: fc.boolean(),
  }),
  fc.record({
    type: fc.constant('separation-of-duties' as const),
    transition: fc.constantFrom(...TRANSITIONS),
  }),
  fc.record({
    type: fc.constant('subticket-blocking' as const),
    statuses: fc.subarray(STATUSES),
  }),
  fc.record({ type: fc.constant('user-in-group' as const), group: fc.constantFrom(...GROUPS) }),
  fc.record({
    type: fc.constant('user-in-any-group' as const),
    groups: fc.subarray(GROUPS),
  }),
  fc.record({ type: fc.constant('user-in-role' as const), role: fc.constantFrom(...ROLES) }),
  fc.record({ type: fc.constant('user-in-any-role' as const), roles: fc.subarray(ROLES) }),
  fc.record({
    type: fc.constant('user-in-field' as const),
    field: fc.constantFrom('owner', 'reviewers'),
  }),
  fc.record({ type: fc.constant('user-in-group-field' as const), field: fc.constant('team') }),
  fc.record({
    type: fc.constant('value-field' as const),
    field: fc.constantFrom('points', 'owner'),
    op: fc.constantFrom(...OPS),
    value: fc.oneof(fc.integer({ min: 0, max: 5 }), fc.constantFrom(...USERS)),
  }),
);

const guardTree: fc.Arbitrary<GuardNode> = fc.letrec<{ node: GuardNode }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.record({ all: fc.array(tie('node'), { maxLength: 4 }) }),
    fc.record({ any: fc.array(tie('node'), { maxLength: 4 }) }),
  ),
})).node;

const statusWalk: fc.Arbitrary<HistoryEntry[]> = fc
  .array(
    fc.record({
      to: fc.constantFrom(...STATUSES),
      by: fc.constantFrom(...USERS),
      transition: fc.constantFrom(...TRANSITIONS),
    }),
    { maxLength: 6 },
  )
  .map((steps) => {
    const history: HistoryEntry[] = [
      { field: 'status', from: null, to: 'open', by: 'bob', transition: 'create' },
    ];
    let at = 'open';
    for (const step of steps) {
      history.push({ field: 'status', from: at, ...step });
      at = step.to;
    }
    return history;
  });

const ticketArb: fc.Arbitrary<TicketState> = fc
  .record({
    history: statusWalk,
    assignee: fc.option(fc.constantFrom(...USERS), { nil: null }),
    requester: fc.constantFrom(...USERS),
    points: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
    owner: fc.option(fc.constantFrom(...USERS), { nil: undefined }),
    reviewers: fc.subarray(USERS),
    team: fc.option(fc.subarray(GROUPS), { nil: undefined }),
    approvalPending: fc.boolean(),
    subtickets: fc.array(fc.constantFrom(...STATUSES), { maxLength: 3 }),
  })
  .map((r) => {
    const fields: Record<string, unknown> = { reviewers: r.reviewers };
    if (r.points !== undefined) fields.points = r.points;
    if (r.owner !== undefined) fields.owner = r.owner;
    if (r.team !== undefined) fields.team = r.team;
    if (r.approvalPending) fields['approval-pending'] = true;
    return {
      status: r.history.at(-1)?.to as string,
      assignee: r.assignee,
      requester: r.requester,
      closeReason: null,
      closedAt: null,
      fields,
      history: r.history,
      subtickets: r.subtickets.map((status) => ({ status })),
    };
  });

const actorArb: fc.Arbitrary<Actor> = fc.record({
  user: fc.constantFrom(...USERS),
  groups: fc.subarray(GROUPS),
  roles: fc.subarray(ROLES),
  permissions: fc.subarray(PERMISSIONS),
});

const channelArb: fc.Arbitrary<Channel> = fc.constantFrom('ui', 'rest', 'automation', 'effect');

/** One transition from every status, guarded by the tree under test. */
const workflowWith = (guards: GuardNode): WorkflowDef => ({
  id: 'w',
  statuses: STATUSES.map((id) => ({ id, name: id, stage: id === 'done' ? 'closed' : 'active' })),
  initial: 'open',
  transitions: [{ id: 'go', name: 'Go', from: 'any', to: 'done', guards }],
});

describe('guards against the reference model (M1-025)', () => {
  const reference = new ReferenceEngine();

  it('[WF-003] reaches the same verdict as the reference on random guard trees', () => {
    fc.assert(
      fc.property(guardTree, ticketArb, actorArb, channelArb, (guards, ticket, actor, channel) => {
        const workflow = workflowWith(guards);
        const request = { transition: 'go', channel, now: '2026-10-28T00:00:00.000Z' };
        const ours = engine.transition(workflow, ticket, actor, request);
        const theirs = reference.transition(workflow, ticket, actor, request);
        expect(ours.outcome).toBe(theirs.outcome);
        if (ours.outcome === 'blocked' && theirs.outcome === 'blocked') {
          expect([ours.by, ours.name]).toEqual([theirs.by, theirs.name]);
        }
        expect(engine.availableTransitions(workflow, ticket, actor, channel)).toEqual(
          reference.availableTransitions(workflow, ticket, actor, channel),
        );
      }),
      { numRuns: 2_000 },
    );
  });

  it('[WF-003] passes "A and (B or C)" exactly when the truth table says so', () => {
    const tree: GuardNode = {
      all: [
        { type: 'user-in-group', group: 'g1' },
        { any: [{ type: 'user-in-role', role: 'r1' }, { type: 'only-assignee' }] },
      ],
    };
    const ticket: TicketState = {
      status: 'open',
      assignee: 'bob',
      requester: 'carol',
      fields: {},
      history: [{ field: 'status', from: null, to: 'open', by: 'carol', transition: 'create' }],
    };
    for (const a of [false, true]) {
      for (const b of [false, true]) {
        for (const c of [false, true]) {
          const actor: Actor = {
            user: c ? 'bob' : 'alice',
            groups: a ? ['g1'] : [],
            roles: b ? ['r1'] : [],
          };
          const offered = engine.availableTransitions(workflowWith(tree), ticket, actor, 'ui');
          expect(offered.length === 1, `A=${a} B=${b} C=${c}`).toBe(a && (b || c));
        }
      }
    }
  });
});
