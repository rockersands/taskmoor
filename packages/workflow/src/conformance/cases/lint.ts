import type { WorkflowDef } from '../../model';
import type { ConformanceCase } from '../case';
import { section, W1, withTransition } from './fixtures';

const c = section('WF-012', 'lint', 'WF-012');

const allColumns = W1.statuses.map((s) => s.id);

export const LINT_CASES: ConformanceCase[] = [
  c('clean-workflow', {
    kind: 'lint',
    title: 'The standard workflow on a fully mapped board has no warnings',
    workflow: W1,
    boards: [{ id: 'main', columns: allColumns }],
    expect: { warnings: [] },
  }),
  c('unreachable-status', {
    kind: 'lint',
    title: 'A status no transition leads to is unreachable',
    workflow: {
      ...W1,
      statuses: [...W1.statuses, { id: 'limbo', name: 'Limbo', category: 'in-progress' }],
      transitions: [
        ...W1.transitions,
        { id: 'leave-limbo', name: 'Leave', from: ['limbo'], to: 'open' },
      ],
    },
    boards: [{ id: 'main', columns: [...allColumns, 'limbo'] }],
    expect: { warnings: [{ kind: 'unreachable-status', at: 'limbo' }] },
  }),
  c('self-loop-does-not-make-reachable', {
    kind: 'lint',
    title: 'A transition from a status to itself does not make it reachable',
    workflow: {
      ...W1,
      statuses: [...W1.statuses, { id: 'limbo', name: 'Limbo', category: 'in-progress' }],
      transitions: [
        ...W1.transitions,
        { id: 'spin', name: 'Spin', from: ['limbo'], to: 'limbo' },
        { id: 'leave', name: 'Leave', from: ['limbo'], to: 'open' },
      ],
    },
    boards: [{ id: 'main', columns: [...allColumns, 'limbo'] }],
    expect: { warnings: [{ kind: 'unreachable-status', at: 'limbo' }] },
  }),
  c('initial-status-is-reachable', {
    kind: 'lint',
    title: 'The initial status counts as reachable',
    workflow: { ...W1, transitions: W1.transitions.filter((t) => t.id !== 'reopen') },
    boards: [{ id: 'main', columns: allColumns }],
    expect: { warnings: [] },
  }),
  c('no-exit-outside-done', {
    kind: 'lint',
    title: 'A status outside the Done category with no exit is flagged',
    workflow: {
      ...W1,
      transitions: W1.transitions.filter((t) => t.id !== 'cancel' && t.id !== 'review'),
    },
    boards: [{ id: 'main', columns: allColumns }],
    expect: {
      warnings: [
        { kind: 'no-exit', at: 'in-progress' },
        { kind: 'unreachable-status', at: 'review' },
        { kind: 'unreachable-status', at: 'cancelled' },
      ],
    },
  }),
  c('done-category-may-have-no-exit', {
    kind: 'lint',
    title: 'A Done-category status needs no exit',
    workflow: {
      ...W1,
      transitions: W1.transitions.filter((t) => t.id !== 'reopen' && t.id !== 'cancel'),
    },
    boards: [{ id: 'main', columns: allColumns }],
    expect: { warnings: [{ kind: 'unreachable-status', at: 'cancelled' }] },
  }),
  c('global-transition-is-an-exit', {
    kind: 'lint',
    title: 'A global transition gives every other status an exit',
    workflow: {
      ...W1,
      transitions: [
        { id: 'cancel', name: 'Cancel', from: 'any', to: 'cancelled' },
        { id: 'start', name: 'Start', from: ['open'], to: 'in-progress' },
        { id: 'review', name: 'Review', from: ['in-progress'], to: 'review' },
        { id: 'finish', name: 'Finish', from: ['review'], to: 'done' },
      ],
    },
    boards: [{ id: 'main', columns: allColumns }],
    expect: { warnings: [] },
  }),
  c('unmapped-on-board', {
    kind: 'lint',
    title: 'A status missing from a board using the workflow is flagged for that board',
    workflow: W1,
    boards: [{ id: 'main', columns: ['open', 'in-progress', 'done'] }],
    expect: {
      warnings: [
        { kind: 'unmapped-on-board', at: 'main:review' },
        { kind: 'unmapped-on-board', at: 'main:cancelled' },
      ],
    },
  }),
  c('unmapped-on-one-of-two-boards', {
    kind: 'lint',
    title: 'Each board is checked on its own',
    workflow: W1,
    boards: [
      { id: 'full', columns: allColumns },
      { id: 'short', columns: ['open', 'done'] },
    ],
    expect: {
      warnings: [
        { kind: 'unmapped-on-board', at: 'short:in-progress' },
        { kind: 'unmapped-on-board', at: 'short:review' },
        { kind: 'unmapped-on-board', at: 'short:cancelled' },
      ],
    },
  }),
  c('no-boards-no-board-warnings', {
    kind: 'lint',
    title: 'Without boards there are no mapping warnings',
    workflow: W1,
    expect: { warnings: [] },
  }),
  c('always-false-is-unsatisfiable', {
    kind: 'lint',
    title: 'An always-false condition is one no user can satisfy',
    workflow: withTransition(W1, 'start', { conditions: { type: 'always-false' } }),
    boards: [{ id: 'main', columns: allColumns }],
    expect: { warnings: [{ kind: 'unsatisfiable-condition', at: 'start' }] },
  }),
  c('always-false-inside-all', {
    kind: 'lint',
    title: 'Always false inside an all group makes the whole tree unsatisfiable',
    workflow: withTransition(W1, 'start', {
      conditions: { all: [{ type: 'only-assignee' }, { type: 'always-false' }] },
    }),
    expect: { warnings: [{ kind: 'unsatisfiable-condition', at: 'start' }] },
  }),
  c('always-false-inside-any-is-fine', {
    kind: 'lint',
    title: 'Always false as one branch of an any group is satisfiable',
    workflow: withTransition(W1, 'start', {
      conditions: { any: [{ type: 'only-assignee' }, { type: 'always-false' }] },
    }),
    expect: { warnings: [] },
  }),
  c('any-of-only-always-false', {
    kind: 'lint',
    title: 'An any group of only always-false branches is unsatisfiable',
    workflow: withTransition(W1, 'start', {
      conditions: { any: [{ type: 'always-false' }, { all: [{ type: 'always-false' }] }] },
    }),
    expect: { warnings: [{ kind: 'unsatisfiable-condition', at: 'start' }] },
  }),
  c('contradictory-number-bounds', {
    kind: 'lint',
    title: 'Contradictory number comparisons on one field are unsatisfiable',
    workflow: withTransition(W1, 'start', {
      conditions: {
        all: [
          { type: 'compare-number', field: 'estimate', op: '>', value: 5 },
          { type: 'compare-number', field: 'estimate', op: '<', value: 3 },
        ],
      },
    }),
    expect: { warnings: [{ kind: 'unsatisfiable-condition', at: 'start' }] },
  }),
  c('compatible-number-bounds', {
    kind: 'lint',
    title: 'Compatible number comparisons are fine',
    workflow: withTransition(W1, 'start', {
      conditions: {
        all: [
          { type: 'compare-number', field: 'estimate', op: '>=', value: 3 },
          { type: 'compare-number', field: 'estimate', op: '<=', value: 5 },
        ],
      },
    }),
    expect: { warnings: [] },
  }),
  c('bounds-on-different-fields', {
    kind: 'lint',
    title: 'Bounds on different fields never contradict',
    workflow: withTransition(W1, 'start', {
      conditions: {
        all: [
          { type: 'compare-number', field: 'a', op: '>', value: 5 },
          { type: 'compare-number', field: 'b', op: '<', value: 3 },
        ],
      },
    }),
    expect: { warnings: [] },
  }),
  c('several-warnings-at-once', {
    kind: 'lint',
    title: 'Every defect is reported, each by name',
    workflow: {
      ...withTransition(W1, 'start', { conditions: { type: 'always-false' } }),
      statuses: [...W1.statuses, { id: 'limbo', name: 'Limbo', category: 'in-progress' }],
      // Without the global Cancel, Limbo has no exit and Cancelled is no longer reachable.
      transitions: withTransition(W1, 'start', {
        conditions: { type: 'always-false' },
      }).transitions.filter((t) => t.id !== 'cancel'),
    } satisfies WorkflowDef,
    boards: [{ id: 'main', columns: allColumns }],
    expect: {
      warnings: [
        { kind: 'unsatisfiable-condition', at: 'start' },
        { kind: 'unreachable-status', at: 'limbo' },
        { kind: 'no-exit', at: 'limbo' },
        { kind: 'unmapped-on-board', at: 'main:limbo' },
        { kind: 'unreachable-status', at: 'cancelled' },
      ],
    },
  }),
];
