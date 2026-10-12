import type { ConformanceCase } from '../case';
import { actor, section, ticket, W1, W2 } from './fixtures';

const c = section('WF-001', 'model', '01a 3.1, WF-001');

/** WF-001: statuses with stages, transitions from one, several or any status, one initial status. */
export const MODEL_CASES: ConformanceCase[] = [
  // A global transition is offered from every status.
  ...W1.statuses.map((s) =>
    c('global-cancel-from-every-status', {
      kind: 'available',
      title: `Cancel (from any status) is offered from ${s.name}`,
      workflow: W1,
      ticket: ticket({ status: s.id }),
      actor: actor('alice'),
      expect: {
        transitions: W1.transitions
          .filter((t) => t.from === 'any' || t.from.includes(s.id))
          .map((t) => t.id),
      },
    }),
  ),
  c('global-cancel-runs-from-review', {
    kind: 'transition',
    title: 'A global transition runs from a status it does not list',
    workflow: W1,
    ticket: ticket({ status: 'review' }),
    actor: actor('alice'),
    request: { transition: 'cancel', now: '2026-10-12T12:00:00.000Z' },
    expect: { outcome: 'ok', status: 'cancelled' },
  }),
  // A transition with two source statuses is offered from both and from no other.
  c('two-sources-offered-from-done', {
    kind: 'available',
    title: 'Reopen (from done or cancelled) is offered from Done',
    workflow: W1,
    ticket: ticket({ status: 'done' }),
    actor: actor('alice'),
    expect: { transitions: ['reopen', 'cancel'] },
  }),
  c('two-sources-offered-from-cancelled', {
    kind: 'available',
    title: 'Reopen (from done or cancelled) is offered from Cancelled',
    workflow: W1,
    ticket: ticket({ status: 'cancelled' }),
    actor: actor('alice'),
    expect: { transitions: ['reopen', 'cancel'] },
  }),
  c('two-sources-not-offered-from-open', {
    kind: 'available',
    title: 'Reopen is not offered from Open',
    workflow: W1,
    ticket: ticket({ status: 'open' }),
    actor: actor('alice'),
    expect: { transitions: ['start', 'cancel'] },
  }),
  c('two-sources-runs-from-cancelled', {
    kind: 'transition',
    title: 'Reopen runs from Cancelled',
    workflow: W1,
    ticket: ticket({ status: 'cancelled' }),
    actor: actor('alice'),
    request: { transition: 'reopen' },
    expect: { outcome: 'ok', status: 'open' },
  }),
  c('wrong-status-blocked', {
    kind: 'transition',
    title: 'A transition is refused from a status it does not leave',
    workflow: W1,
    ticket: ticket({ status: 'open' }),
    actor: actor('alice'),
    request: { transition: 'finish' },
    expect: { outcome: 'blocked', by: 'wrong-status', name: 'finish' },
  }),
  c('wrong-status-blocked-rest', {
    kind: 'transition',
    title: 'The REST channel is refused the same way',
    workflow: W1,
    ticket: ticket({ status: 'done' }),
    actor: actor('alice'),
    request: { transition: 'start', channel: 'rest' },
    expect: { outcome: 'blocked', by: 'wrong-status', name: 'start' },
  }),
  c('unknown-transition-blocked', {
    kind: 'transition',
    title: 'An unknown transition id is refused by name',
    workflow: W1,
    ticket: ticket(),
    actor: actor('alice'),
    request: { transition: 'teleport' },
    expect: { outcome: 'blocked', by: 'unknown-transition', name: 'teleport' },
  }),
  // One initial status per workflow; different types may use different workflows.
  c('create-starts-in-initial-w1', {
    kind: 'create',
    title: 'A Bug on W1 starts in Open',
    workflow: W1,
    actor: actor('bob'),
    expect: { status: 'open', event: 'generic' },
  }),
  c('create-starts-in-initial-w2', {
    kind: 'create',
    title: 'A Chore on W2 starts in Backlog',
    workflow: W2,
    actor: actor('bob'),
    expect: { status: 'backlog', event: 'generic' },
  }),
  c('create-records-history', {
    kind: 'create',
    title: 'Creation records the initial status in the history',
    workflow: W2,
    actor: actor('bob'),
    expect: {
      status: 'backlog',
      history: [{ field: 'status', from: null, to: 'backlog', by: 'bob', transition: 'create' }],
    },
  }),
  c('w2-transitions-independent', {
    kind: 'available',
    title: 'W2 offers its own transitions, not those of W1',
    workflow: W2,
    ticket: ticket({ status: 'backlog' }),
    actor: actor('alice'),
    expect: { transitions: ['take'] },
  }),
  c('w2-closed-has-no-exit', {
    kind: 'available',
    title: 'W2 offers nothing from Closed',
    workflow: W2,
    ticket: ticket({ status: 'closed' }),
    actor: actor('alice'),
    expect: { transitions: [] },
  }),
  c('transition-changes-status-only', {
    kind: 'transition',
    title: 'A plain transition changes the status and nothing else',
    workflow: W1,
    ticket: ticket({ fields: { summary: 'Fix the login' } }),
    actor: actor('alice'),
    request: { transition: 'start' },
    expect: {
      outcome: 'ok',
      status: 'in-progress',
      assignee: 'alice',
      closeReason: null,
      fields: { summary: 'Fix the login' },
      added: [
        { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
      ],
    },
  }),
  c('stages-in-definition', {
    kind: 'export-roundtrip',
    title: 'Statuses carry a stage of new, active or closed',
    workflow: W1,
    expect: { identical: true },
  }),
];
