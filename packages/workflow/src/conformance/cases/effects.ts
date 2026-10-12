import { type EffectDef, ESSENTIAL_ORDER, type SystemField, type WorkflowDef } from '../../model';
import type { ConformanceCase } from '../case';
import { actor, NOW, section, ticket, W1, withEffects, withTransition } from './fixtures';

const c = section('WF-005', 'effects', '01a 3.4, WF-005');

const run = (
  slug: string,
  title: string,
  effects: EffectDef[],
  ticketState: ReturnType<typeof ticket>,
  who: ReturnType<typeof actor>,
  expect: Extract<ConformanceCase, { kind: 'transition' }>['expect'],
  verify?: string,
): ConformanceCase =>
  c(slug, {
    kind: 'transition',
    title,
    workflow: withEffects(effects),
    ticket: ticketState,
    actor: who,
    request: { transition: 'start', now: NOW },
    expect,
    ...(verify ? { verify } : {}),
  });

const SYSTEM_FIELDS: { field: SystemField; value: unknown }[] = [
  { field: 'assignee', value: 'carol' },
  { field: 'description', value: 'Updated by the transition' },
  { field: 'environment', value: 'staging' },
  { field: 'priority', value: 'High' },
  { field: 'close-reason', value: 'Done' },
  { field: 'summary', value: 'New title' },
  { field: 'original-estimate', value: 3600 },
  { field: 'remaining-estimate', value: 1800 },
];

const createWithWebhook: WorkflowDef = {
  ...W1,
  transitions: [
    {
      id: 'create',
      name: 'Create',
      from: [],
      to: 'open',
      effects: [{ type: 'webhook', url: 'https://hooks.example/created' }],
      event: 'ticket-created',
    },
    ...W1.transitions,
  ],
};

export const EFFECT_CASES: ConformanceCase[] = [
  // Essential sequence.
  ...W1.transitions
    .filter((t) => t.from !== 'any' && t.from.length > 0)
    .map((t) =>
      c('essential-order-on-every-transition', {
        kind: 'transition',
        title: `${t.name} runs the essential effects in the fixed order`,
        workflow: W1,
        ticket: ticket({ status: (t.from as string[])[0] as string }),
        actor: actor('alice'),
        request: { transition: t.id, now: NOW },
        expect: { outcome: 'ok', order: ESSENTIAL_ORDER, notificationsAfterSequence: true },
      }),
    ),
  c('comment-added-when-entered', {
    kind: 'transition',
    title: 'The comment entered on the transition is added',
    workflow: W1,
    ticket: ticket(),
    actor: actor('alice'),
    request: { transition: 'start', now: NOW, comment: 'Starting now' },
    expect: {
      outcome: 'ok',
      status: 'in-progress',
      added: [
        { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
        { field: 'comment', from: null, to: 'Starting now', by: 'alice', transition: 'start' },
      ],
    },
  }),
  run(
    'no-comment-no-entry',
    'Without a comment nothing but the status is recorded',
    [],
    ticket(),
    actor('alice'),
    {
      outcome: 'ok',
      added: [
        { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
      ],
    },
  ),
  run(
    'event-generic-by-default',
    'The transition fires the generic event unless one is chosen',
    [],
    ticket(),
    actor('alice'),
    { outcome: 'ok', event: 'generic' },
  ),
  // Assign to current user, owner, requester.
  run(
    'assign-to-current-user',
    'Assign to current user',
    [{ type: 'assign-to-current-user' }],
    ticket({ assignee: 'bob' }),
    actor('alice'),
    {
      outcome: 'ok',
      assignee: 'alice',
      added: [
        { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
        { field: 'assignee', from: 'bob', to: 'alice', by: 'alice', transition: 'start' },
      ],
    },
  ),
  run(
    'assign-to-current-user-already',
    'Assign to current user records nothing when already assigned',
    [{ type: 'assign-to-current-user' }],
    ticket({ assignee: 'alice' }),
    actor('alice'),
    {
      outcome: 'ok',
      assignee: 'alice',
      added: [
        { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
      ],
    },
  ),
  run(
    'assign-to-owner-area',
    'Assign to owner picks the area owner',
    [{ type: 'assign-to-owner' }],
    ticket({ areaOwner: 'carol', trackOwner: 'dave' }),
    actor('alice'),
    { outcome: 'ok', assignee: 'carol' },
  ),
  run(
    'assign-to-owner-track',
    'Assign to owner falls back to the track owner',
    [{ type: 'assign-to-owner' }],
    ticket({ areaOwner: null, trackOwner: 'dave' }),
    actor('alice'),
    { outcome: 'ok', assignee: 'dave' },
  ),
  run(
    'assign-to-owner-none',
    'Assign to owner unassigns when there is no owner',
    [{ type: 'assign-to-owner' }],
    ticket({ assignee: 'alice', areaOwner: null, trackOwner: null }),
    actor('alice'),
    { outcome: 'ok', assignee: null },
    'the public description (Jira: assign to lead developer) does not say what happens without any lead; this suite expects the ticket to become unassigned',
  ),
  run(
    'assign-to-requester',
    'Assign to requester',
    [{ type: 'assign-to-requester' }],
    ticket({ assignee: 'alice', requester: 'bob' }),
    actor('alice'),
    { outcome: 'ok', assignee: 'bob' },
  ),
  // Clear field value.
  run(
    'clear-field-custom',
    'Clear field value empties a custom field',
    [{ type: 'clear-field', field: 'sprint' }],
    ticket({ fields: { sprint: 'S12', summary: 'x' } }),
    actor('alice'),
    {
      outcome: 'ok',
      fields: { summary: 'x' },
      added: [
        { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
        { field: 'sprint', from: 'S12', to: null, by: 'alice', transition: 'start' },
      ],
    },
  ),
  run(
    'clear-field-close-reason',
    'Clear field value on the close reason also clears the closed stamp',
    [{ type: 'clear-field', field: 'close-reason' }],
    ticket({ closeReason: 'Done', closedAt: '2026-10-01T00:00:00.000Z' }),
    actor('alice'),
    { outcome: 'ok', closeReason: null, closedAt: null },
  ),
  run(
    'clear-field-already-empty',
    'Clearing an empty field records nothing',
    [{ type: 'clear-field', field: 'sprint' }],
    ticket(),
    actor('alice'),
    {
      outcome: 'ok',
      added: [
        { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
      ],
    },
  ),
  // Copy value from another field.
  run(
    'copy-field-same-ticket',
    'Copy value from another field on the same ticket',
    [{ type: 'copy-field', from: 'estimate', to: 'original-estimate' }],
    ticket({ fields: { estimate: 5 } }),
    actor('alice'),
    { outcome: 'ok', fields: { estimate: 5, 'original-estimate': 5 } },
  ),
  run(
    'copy-field-from-parent',
    'Copy from parent sets a subticket field from its parent',
    [{ type: 'copy-field', from: 'target-release', to: 'target-release', fromParent: true }],
    ticket({ parent: { status: 'open', fields: { 'target-release': '2.0' } } }),
    actor('alice'),
    { outcome: 'ok', fields: { 'target-release': '2.0' } },
  ),
  run(
    'copy-field-missing-source',
    'Copy value leaves the target alone when the source is empty',
    [{ type: 'copy-field', from: 'estimate', to: 'original-estimate' }],
    ticket({ fields: { 'original-estimate': 8 } }),
    actor('alice'),
    { outcome: 'ok', fields: { 'original-estimate': 8 } },
  ),
  run(
    'copy-field-no-parent',
    'Copy from parent does nothing on a ticket without a parent',
    [{ type: 'copy-field', from: 'target-release', to: 'target-release', fromParent: true }],
    ticket(),
    actor('alice'),
    { outcome: 'ok', fields: {} },
  ),
  // Visibility level from role.
  run(
    'visibility-level-from-role',
    'Set visibility level from the user’s track role',
    [{ type: 'set-visibility-level-from-role', levels: { contractors: 'internal', staff: 'all' } }],
    ticket(),
    actor('alice', { roles: ['contractors'] }),
    { outcome: 'ok', visibilityLevel: 'internal' },
  ),
  run(
    'visibility-level-no-matching-role',
    'No matching role leaves the visibility level unchanged',
    [{ type: 'set-visibility-level-from-role', levels: { contractors: 'internal' } }],
    ticket({ visibilityLevel: 'all' }),
    actor('alice', { roles: ['staff'] }),
    { outcome: 'ok', visibilityLevel: 'all' },
  ),
  // Webhooks.
  run(
    'webhook-fires',
    'Trigger webhook posts to the configured URL',
    [{ type: 'webhook', url: 'https://hooks.example/start' }],
    ticket(),
    actor('alice'),
    { outcome: 'ok', webhooks: ['https://hooks.example/start'] },
  ),
  run(
    'webhooks-in-order',
    'Two webhooks fire in list order',
    [
      { type: 'webhook', url: 'https://hooks.example/a' },
      { type: 'webhook', url: 'https://hooks.example/b' },
    ],
    ticket(),
    actor('alice'),
    { outcome: 'ok', webhooks: ['https://hooks.example/a', 'https://hooks.example/b'] },
  ),
  c('webhook-on-create', {
    kind: 'create',
    title: 'The webhook effect also fires on the create transition',
    workflow: createWithWebhook,
    actor: actor('bob'),
    expect: {
      status: 'open',
      event: 'ticket-created',
      webhooks: ['https://hooks.example/created'],
    },
  }),
  c('no-webhook-on-create-without-one', {
    kind: 'create',
    title: 'Creation without a webhook fires none',
    workflow: W1,
    actor: actor('bob'),
    expect: { status: 'open', webhooks: [] },
  }),
  // Update fields.
  run(
    'update-custom-field',
    'Update a custom field',
    [{ type: 'update-field', field: 'phase', value: 'development' }],
    ticket(),
    actor('alice'),
    { outcome: 'ok', fields: { phase: 'development' } },
  ),
  run(
    'update-custom-field-overwrites',
    'Update a custom field overwrites and records the old value',
    [{ type: 'update-field', field: 'phase', value: 'development' }],
    ticket({ fields: { phase: 'triage' } }),
    actor('alice'),
    {
      outcome: 'ok',
      added: [
        { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
        { field: 'phase', from: 'triage', to: 'development', by: 'alice', transition: 'start' },
      ],
    },
  ),
  ...SYSTEM_FIELDS.map(({ field, value }) =>
    run(
      `update-system-field-${field}`,
      `Update system field ${field}`,
      [{ type: 'update-system-field', field, value }],
      ticket(),
      actor('alice'),
      field === 'assignee'
        ? { outcome: 'ok', assignee: 'carol' }
        : field === 'close-reason'
          ? { outcome: 'ok', closeReason: 'Done', closedAt: NOW }
          : { outcome: 'ok', fields: { [field]: value } },
    ),
  ),
  // Several effects, in order, each recorded.
  run(
    'several-in-order',
    'Optional effects run in list order and each change is recorded',
    [
      { type: 'update-field', field: 'a', value: 1 },
      { type: 'copy-field', from: 'a', to: 'b' },
      { type: 'assign-to-requester' },
    ],
    ticket({ assignee: 'alice', requester: 'bob' }),
    actor('alice'),
    {
      outcome: 'ok',
      fields: { a: 1, b: 1 },
      assignee: 'bob',
      added: [
        { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
        { field: 'a', from: null, to: 1, by: 'alice', transition: 'start' },
        { field: 'b', from: null, to: 1, by: 'alice', transition: 'start' },
        { field: 'assignee', from: 'alice', to: 'bob', by: 'alice', transition: 'start' },
      ],
    },
    'the public description fixes the order of the essential effects (Jira: post functions) only; this suite records optional changes in list order after the status',
  ),
  run(
    'placeholder-does-nothing',
    'An imported placeholder is disabled and changes nothing',
    [
      { type: 'placeholder', jiraClass: 'com.example.CustomFunction' },
      { type: 'update-field', field: 'a', value: 1 },
    ],
    ticket(),
    actor('alice'),
    { outcome: 'ok', fields: { a: 1 } },
  ),
  c('effects-per-transition', {
    kind: 'transition',
    title: 'Effects on Start do not run on Cancel',
    workflow: withTransition(withEffects([{ type: 'assign-to-current-user' }]), 'cancel', {}),
    ticket: ticket({ assignee: 'bob' }),
    actor: actor('alice'),
    request: { transition: 'cancel', now: NOW },
    expect: { outcome: 'ok', status: 'cancelled', assignee: 'bob' },
  }),
];
