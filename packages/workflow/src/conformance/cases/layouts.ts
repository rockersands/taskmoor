import type { WorkflowDef } from '../../model';
import type { ConformanceCase } from '../case';
import { actor, NOW, section, ticket, W1, withTransition } from './fixtures';

const c = section('WF-006', 'layouts-properties-events', '01a 3.1, WF-006');

const withLayout: WorkflowDef = withTransition(W1, 'start', {
  layout: ['target-release', 'assignee'],
  properties: { 'opsbar-sequence': '10', 'approval.required': 'false' },
  event: 'work-started',
});

export const LAYOUT_CASES: ConformanceCase[] = [
  c('layout-field-saved-with-transition', {
    kind: 'transition',
    title: 'A field entered on the layout is saved with the transition',
    workflow: withLayout,
    ticket: ticket(),
    actor: actor('alice'),
    request: { transition: 'start', fields: { 'target-release': '2.1' }, now: NOW },
    expect: {
      outcome: 'ok',
      status: 'in-progress',
      fields: { 'target-release': '2.1' },
      added: [
        { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
        { field: 'target-release', from: null, to: '2.1', by: 'alice', transition: 'start' },
      ],
    },
  }),
  c('layout-fields-and-comment-atomic', {
    kind: 'transition',
    title: 'Layout fields and the comment land in one change set',
    workflow: withLayout,
    ticket: ticket({ assignee: null }),
    actor: actor('alice'),
    request: {
      transition: 'start',
      fields: { 'target-release': '2.1', assignee: 'carol' },
      comment: 'Taking this',
      now: NOW,
    },
    expect: {
      outcome: 'ok',
      assignee: 'carol',
      fields: { 'target-release': '2.1' },
      added: [
        { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
        { field: 'target-release', from: null, to: '2.1', by: 'alice', transition: 'start' },
        { field: 'assignee', from: null, to: 'carol', by: 'alice', transition: 'start' },
        { field: 'comment', from: null, to: 'Taking this', by: 'alice', transition: 'start' },
      ],
    },
  }),
  c('field-not-on-layout-ignored', {
    kind: 'transition',
    title: 'A value for a field that is not on the layout is ignored',
    workflow: withLayout,
    ticket: ticket(),
    actor: actor('alice'),
    request: { transition: 'start', fields: { priority: 'Urgent' }, now: NOW },
    expect: { outcome: 'ok', fields: {} },
    verify:
      'the public description says the layout decides which fields a transition shows; this suite also makes it decide which values are accepted',
  }),
  c('no-layout-no-fields', {
    kind: 'transition',
    title: 'A transition without a layout accepts no field values',
    workflow: W1,
    ticket: ticket(),
    actor: actor('alice'),
    request: { transition: 'start', fields: { 'target-release': '2.1' }, now: NOW },
    expect: { outcome: 'ok', fields: {} },
  }),
  c('layout-fields-rolled-back-on-check', {
    kind: 'transition',
    title: 'Nothing from the layout is kept when a check blocks',
    workflow: withTransition(withLayout, 'start', {
      checks: [{ type: 'field-required', field: 'summary' }],
    }),
    ticket: ticket(),
    actor: actor('alice'),
    request: { transition: 'start', fields: { 'target-release': '2.1' }, comment: 'x', now: NOW },
    expect: { outcome: 'blocked', by: 'check', name: 'field-required' },
  }),
  c('properties-readable-through-api', {
    kind: 'export-roundtrip',
    title: 'Transition properties survive export and import, so the API can read them',
    workflow: withLayout,
    expect: { identical: true },
  }),
  c('custom-event-fired', {
    kind: 'transition',
    title: 'A transition fires its custom event',
    workflow: withLayout,
    ticket: ticket(),
    actor: actor('alice'),
    request: { transition: 'start', now: NOW },
    expect: { outcome: 'ok', event: 'work-started' },
  }),
  c('generic-event-without-custom', {
    kind: 'transition',
    title: 'A transition without a custom event fires the generic one',
    workflow: withLayout,
    ticket: ticket({ status: 'in-progress' }),
    actor: actor('alice'),
    request: { transition: 'review', now: NOW },
    expect: { outcome: 'ok', event: 'generic' },
  }),
  c('custom-event-on-create', {
    kind: 'create',
    title: 'The create transition can fire a custom event',
    workflow: {
      ...W1,
      transitions: [
        { id: 'create', name: 'Create', from: [], to: 'open', event: 'ticket-created' },
        ...W1.transitions,
      ],
    },
    actor: actor('bob'),
    expect: { status: 'open', event: 'ticket-created' },
  }),
  c('event-fires-after-store', {
    kind: 'transition',
    title: 'The event is the last essential step, after history and index',
    workflow: withLayout,
    ticket: ticket(),
    actor: actor('alice'),
    request: { transition: 'start', now: NOW },
    expect: { outcome: 'ok', order: ['status', 'comment', 'history', 'index', 'event'] },
  }),
];
