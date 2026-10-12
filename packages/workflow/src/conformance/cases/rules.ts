import type { RuleDef, WorkflowDef } from '../../model';
import type { ConformanceCase } from '../case';
import { actor, NOW, reviewed, section, ticket, W1 } from './fixtures';

const c = section('WF-009', 'rules', '01a 3.5, WF-009');

/** W1 as a local-mode workflow with rules on Start. */
const ruled = (rules: RuleDef[]): WorkflowDef => ({
  ...W1,
  id: 'track-a',
  rules: { start: rules },
});

const run = (
  slug: string,
  title: string,
  rules: RuleDef[],
  ticketState: ReturnType<typeof ticket>,
  who: ReturnType<typeof actor>,
  expect: Extract<ConformanceCase, { kind: 'transition' }>['expect'],
  verify?: string,
): ConformanceCase =>
  c(slug, {
    kind: 'transition',
    title,
    workflow: ruled(rules),
    ticket: ticketState,
    actor: who,
    request: { transition: 'start', now: NOW },
    expect,
    ...(verify ? { verify } : {}),
  });

const blockedByRule = (
  name: string,
): Extract<ConformanceCase, { kind: 'transition' }>['expect'] => ({
  outcome: 'blocked',
  by: 'rule',
  name,
});

/** open -> in-progress -> open -> in-progress -> open (current): a loop through in-progress twice. */
const looped = () =>
  ticket({
    status: 'open',
    history: [
      { field: 'status', from: null, to: 'open', by: 'bob', transition: 'create' },
      { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
      { field: 'status', from: 'in-progress', to: 'open', by: 'alice', transition: 'cancel' },
      { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
      { field: 'status', from: 'in-progress', to: 'open', by: 'alice', transition: 'cancel' },
    ],
  });

export const RULE_CASES: ConformanceCase[] = [
  // Assign a ticket to someone.
  run(
    'assign-current-user',
    'Assign to the current user',
    [{ type: 'assign', to: 'current-user' }],
    ticket({ assignee: null }),
    actor('alice'),
    { outcome: 'ok', assignee: 'alice' },
  ),
  run(
    'assign-requester',
    'Assign to the requester',
    [{ type: 'assign', to: 'requester' }],
    ticket({ assignee: null, requester: 'bob' }),
    actor('alice'),
    { outcome: 'ok', assignee: 'bob' },
  ),
  run(
    'assign-named-user',
    'Assign to a named user',
    [{ type: 'assign', to: { user: 'carol' } }],
    ticket(),
    actor('alice'),
    { outcome: 'ok', assignee: 'carol' },
  ),
  // Restrict to when a field has a specific value.
  run(
    'restrict-field-value-matches',
    'Restrict to a field value passes when it matches',
    [{ type: 'restrict-field-value', field: 'kind', value: 'bug' }],
    ticket({ fields: { kind: 'bug' } }),
    actor('alice'),
    { outcome: 'ok', status: 'in-progress' },
  ),
  run(
    'restrict-field-value-differs',
    'Restrict to a field value blocks when it differs',
    [{ type: 'restrict-field-value', field: 'kind', value: 'bug' }],
    ticket({ fields: { kind: 'task' } }),
    actor('alice'),
    blockedByRule('restrict-field-value'),
  ),
  run(
    'restrict-field-value-missing',
    'Restrict to a field value blocks when the field is empty',
    [{ type: 'restrict-field-value', field: 'kind', value: 'bug' }],
    ticket(),
    actor('alice'),
    blockedByRule('restrict-field-value'),
  ),
  // Restrict to when the ticket has been through a status, each option.
  run(
    'been-through-plain-yes',
    'Has been through review passes a travelled ticket',
    [{ type: 'restrict-been-through', status: 'review' }],
    reviewed(),
    actor('alice'),
    { outcome: 'ok' },
  ),
  run(
    'been-through-plain-no',
    'Has been through review blocks a fresh ticket',
    [{ type: 'restrict-been-through', status: 'review' }],
    ticket(),
    actor('alice'),
    blockedByRule('restrict-been-through'),
  ),
  run(
    'been-through-current-excluded',
    'Without "include current status" the current status does not count',
    [{ type: 'restrict-been-through', status: 'open' }],
    ticket(),
    actor('alice'),
    blockedByRule('restrict-been-through'),
  ),
  run(
    'been-through-include-current',
    'With "include current status" it does',
    [{ type: 'restrict-been-through', status: 'open', includeCurrent: true }],
    ticket(),
    actor('alice'),
    { outcome: 'ok' },
  ),
  run(
    'been-through-reverse-blocks',
    'Reverse blocks a ticket that has been through the status',
    [{ type: 'restrict-been-through', status: 'review', reverse: true }],
    reviewed(),
    actor('alice'),
    blockedByRule('restrict-been-through'),
  ),
  run(
    'been-through-reverse-passes',
    'Reverse passes a ticket that has not',
    [{ type: 'restrict-been-through', status: 'review', reverse: true }],
    ticket(),
    actor('alice'),
    { outcome: 'ok' },
  ),
  run(
    'been-through-most-recent-yes',
    'Most recent only passes when it was the last status',
    [{ type: 'restrict-been-through', status: 'review', mostRecentOnly: true }],
    reviewed(),
    actor('alice'),
    { outcome: 'ok' },
  ),
  run(
    'been-through-most-recent-no',
    'Most recent only blocks when it was earlier',
    [{ type: 'restrict-been-through', status: 'open', mostRecentOnly: true }],
    reviewed(),
    actor('alice'),
    blockedByRule('restrict-been-through'),
  ),
  run(
    'been-through-ignore-loops-passes',
    'Ignore looped transitions still sees a status visited once',
    [{ type: 'restrict-been-through', status: 'in-progress', ignoreLoops: true }],
    looped(),
    actor('alice'),
    { outcome: 'ok' },
  ),
  run(
    'been-through-ignore-loops-most-recent',
    'Ignore loops with most recent only looks at the de-duplicated path',
    [
      {
        type: 'restrict-been-through',
        status: 'in-progress',
        ignoreLoops: true,
        mostRecentOnly: true,
      },
    ],
    looped(),
    actor('alice'),
    { outcome: 'ok' },
    'the public description names the option without defining it; this suite keeps the first visit of each status, so the looped path open, in-progress, open, in-progress becomes open, in-progress',
  ),
  run(
    'been-through-ignore-loops-most-recent-blocks',
    'Ignore loops with most recent only blocks a status that was only the first visit',
    [{ type: 'restrict-been-through', status: 'open', ignoreLoops: true, mostRecentOnly: true }],
    looped(),
    actor('alice'),
    blockedByRule('restrict-been-through'),
  ),
  run(
    'been-through-loops-counted',
    'Without ignore loops the most recent visit counts',
    [{ type: 'restrict-been-through', status: 'in-progress', mostRecentOnly: true }],
    looped(),
    actor('alice'),
    { outcome: 'ok' },
  ),
  run(
    'been-through-reverse-and-current',
    'Reverse with include current blocks the current status',
    [{ type: 'restrict-been-through', status: 'open', reverse: true, includeCurrent: true }],
    ticket(),
    actor('alice'),
    blockedByRule('restrict-been-through'),
  ),
  // Restrict who can move the ticket.
  run(
    'restrict-who-user',
    'Restrict who: a named user passes',
    [{ type: 'restrict-who', users: ['alice'] }],
    ticket(),
    actor('alice'),
    { outcome: 'ok' },
  ),
  run(
    'restrict-who-group',
    'Restrict who: a group member passes',
    [{ type: 'restrict-who', groups: ['qa'] }],
    ticket(),
    actor('alice', { groups: ['qa'] }),
    { outcome: 'ok' },
  ),
  run(
    'restrict-who-role',
    'Restrict who: a role holder passes',
    [{ type: 'restrict-who', roles: ['developers'] }],
    ticket(),
    actor('alice', { roles: ['developers'] }),
    { outcome: 'ok' },
  ),
  run(
    'restrict-who-none',
    'Restrict who blocks everyone else',
    [{ type: 'restrict-who', users: ['bob'], groups: ['qa'], roles: ['developers'] }],
    ticket(),
    actor('alice', { groups: ['dev'], roles: ['viewers'] }),
    blockedByRule('restrict-who'),
  ),
  c('restrict-who-hides-transition', {
    kind: 'available',
    title: 'Restrict who hides the transition from others',
    workflow: ruled([{ type: 'restrict-who', users: ['bob'] }]),
    ticket: ticket(),
    actor: actor('alice'),
    expect: { transitions: ['cancel'] },
  }),
  // Validate that people hold a permission.
  run(
    'validate-permission-holder',
    'Validate permission passes a holder',
    [{ type: 'validate-permission', permission: 'close' }],
    ticket(),
    actor('alice', { permissions: ['close'] }),
    { outcome: 'ok' },
  ),
  run(
    'validate-permission-non-holder',
    'Validate permission blocks a non-holder with a message',
    [{ type: 'validate-permission', permission: 'close' }],
    ticket(),
    actor('alice'),
    {
      outcome: 'blocked',
      by: 'rule',
      name: 'validate-permission',
      message: 'needs the close permission',
    },
  ),
  // Copy one field's value to another.
  run(
    'copy-field',
    'Copy one field to another',
    [{ type: 'copy-field', from: 'estimate', to: 'original-estimate' }],
    ticket({ fields: { estimate: 5 } }),
    actor('alice'),
    { outcome: 'ok', fields: { estimate: 5, 'original-estimate': 5 } },
  ),
  run(
    'copy-field-empty-source',
    'Copy leaves the target alone when the source is empty',
    [{ type: 'copy-field', from: 'estimate', to: 'original-estimate' }],
    ticket({ fields: { 'original-estimate': 2 } }),
    actor('alice'),
    { outcome: 'ok', fields: { 'original-estimate': 2 } },
  ),
  // Update a field.
  run(
    'update-field',
    'Update a field',
    [{ type: 'update-field', field: 'phase', value: 'dev' }],
    ticket(),
    actor('alice'),
    { outcome: 'ok', fields: { phase: 'dev' } },
  ),
  run(
    'update-field-recorded',
    'Update a field is recorded in the history',
    [{ type: 'update-field', field: 'phase', value: 'dev' }],
    ticket({ fields: { phase: 'triage' } }),
    actor('alice'),
    {
      outcome: 'ok',
      added: [
        { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
        { field: 'phase', from: 'triage', to: 'dev', by: 'alice', transition: 'start' },
      ],
    },
  ),
  // Rules combine and stay local to their track.
  run(
    'rules-restrict-then-act',
    'A restriction is checked before the acting rules run',
    [
      { type: 'assign', to: 'current-user' },
      { type: 'restrict-field-value', field: 'kind', value: 'bug' },
    ],
    ticket({ assignee: null, fields: { kind: 'task' } }),
    actor('alice'),
    blockedByRule('restrict-field-value'),
  ),
  run(
    'several-rules',
    'Several rules act together',
    [
      { type: 'assign', to: 'current-user' },
      { type: 'update-field', field: 'phase', value: 'dev' },
      { type: 'copy-field', from: 'phase', to: 'last-phase' },
    ],
    ticket({ assignee: null }),
    actor('alice'),
    { outcome: 'ok', assignee: 'alice', fields: { phase: 'dev', 'last-phase': 'dev' } },
  ),
  c('rules-local-to-track', {
    kind: 'transition',
    title: 'Rules created in one track do not appear in another',
    workflow: {
      ...ruled([{ type: 'restrict-field-value', field: 'kind', value: 'bug' }]),
      id: 'track-b',
      rules: {},
    },
    ticket: ticket({ fields: { kind: 'task' } }),
    actor: actor('alice'),
    request: { transition: 'start', now: NOW },
    expect: { outcome: 'ok', status: 'in-progress' },
  }),
  c('rules-per-transition', {
    kind: 'transition',
    title: 'Rules on Start do not apply to Cancel',
    workflow: ruled([{ type: 'restrict-who', users: ['bob'] }]),
    ticket: ticket(),
    actor: actor('alice'),
    request: { transition: 'cancel', now: NOW },
    expect: { outcome: 'ok', status: 'cancelled' },
  }),
];
