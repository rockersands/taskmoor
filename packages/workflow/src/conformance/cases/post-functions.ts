import {
  ESSENTIAL_ORDER,
  type PostFunctionDef,
  type SystemField,
  type WorkflowDef,
} from '../../model';
import type { ConformanceCase } from '../case';
import { actor, item, NOW, posted, section, W1, withTransition } from './fixtures';

const c = section('WF-005', 'post-functions', '01a 3.4, WF-005');

const run = (
  slug: string,
  title: string,
  postFunctions: PostFunctionDef[],
  itemState: ReturnType<typeof item>,
  who: ReturnType<typeof actor>,
  expect: Extract<ConformanceCase, { kind: 'transition' }>['expect'],
  verify?: string,
): ConformanceCase =>
  c(slug, {
    kind: 'transition',
    title,
    workflow: posted(postFunctions),
    item: itemState,
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
  { field: 'resolution', value: 'Done' },
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
      postFunctions: [{ type: 'webhook', url: 'https://hooks.example/created' }],
      event: 'item-created',
    },
    ...W1.transitions,
  ],
};

export const POST_FUNCTION_CASES: ConformanceCase[] = [
  // Essential sequence.
  ...W1.transitions
    .filter((t) => t.from !== 'any' && t.from.length > 0)
    .map((t) =>
      c('essential-order-on-every-transition', {
        kind: 'transition',
        title: `${t.name} runs the essential post functions in the fixed order`,
        workflow: W1,
        item: item({ status: (t.from as string[])[0] as string }),
        actor: actor('alice'),
        request: { transition: t.id, now: NOW },
        expect: { outcome: 'ok', order: ESSENTIAL_ORDER, notificationsAfterSequence: true },
      }),
    ),
  c('comment-added-when-entered', {
    kind: 'transition',
    title: 'The comment entered on the transition is added',
    workflow: W1,
    item: item(),
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
    item(),
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
    item(),
    actor('alice'),
    { outcome: 'ok', event: 'generic' },
  ),
  // Assign to current user, lead, reporter.
  run(
    'assign-to-current-user',
    'Assign to current user',
    [{ type: 'assign-to-current-user' }],
    item({ assignee: 'bob' }),
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
    item({ assignee: 'alice' }),
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
    'assign-to-lead-component',
    'Assign to lead developer picks the component lead',
    [{ type: 'assign-to-lead' }],
    item({ componentLead: 'carol', spaceLead: 'dave' }),
    actor('alice'),
    { outcome: 'ok', assignee: 'carol' },
  ),
  run(
    'assign-to-lead-space',
    'Assign to lead developer falls back to the space lead',
    [{ type: 'assign-to-lead' }],
    item({ componentLead: null, spaceLead: 'dave' }),
    actor('alice'),
    { outcome: 'ok', assignee: 'dave' },
  ),
  run(
    'assign-to-lead-none',
    'Assign to lead developer unassigns when there is no lead',
    [{ type: 'assign-to-lead' }],
    item({ assignee: 'alice', componentLead: null, spaceLead: null }),
    actor('alice'),
    { outcome: 'ok', assignee: null },
    'the public description does not say what happens without any lead; this suite expects the item to become unassigned',
  ),
  run(
    'assign-to-reporter',
    'Assign to reporter',
    [{ type: 'assign-to-reporter' }],
    item({ assignee: 'alice', reporter: 'bob' }),
    actor('alice'),
    { outcome: 'ok', assignee: 'bob' },
  ),
  // Clear field value.
  run(
    'clear-field-custom',
    'Clear field value empties a custom field',
    [{ type: 'clear-field', field: 'sprint' }],
    item({ fields: { sprint: 'S12', summary: 'x' } }),
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
    'clear-field-resolution',
    'Clear field value on resolution also clears Resolved',
    [{ type: 'clear-field', field: 'resolution' }],
    item({ resolution: 'Done', resolvedAt: '2026-10-01T00:00:00.000Z' }),
    actor('alice'),
    { outcome: 'ok', resolution: null, resolvedAt: null },
  ),
  run(
    'clear-field-already-empty',
    'Clearing an empty field records nothing',
    [{ type: 'clear-field', field: 'sprint' }],
    item(),
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
    'copy-field-same-item',
    'Copy value from another field on the same item',
    [{ type: 'copy-field', from: 'estimate', to: 'original-estimate' }],
    item({ fields: { estimate: 5 } }),
    actor('alice'),
    { outcome: 'ok', fields: { estimate: 5, 'original-estimate': 5 } },
  ),
  run(
    'copy-field-from-parent',
    'Copy from parent sets a subtask field from its parent',
    [{ type: 'copy-field', from: 'fix-version', to: 'fix-version', fromParent: true }],
    item({ parent: { status: 'open', fields: { 'fix-version': '2.0' } } }),
    actor('alice'),
    { outcome: 'ok', fields: { 'fix-version': '2.0' } },
  ),
  run(
    'copy-field-missing-source',
    'Copy value leaves the target alone when the source is empty',
    [{ type: 'copy-field', from: 'estimate', to: 'original-estimate' }],
    item({ fields: { 'original-estimate': 8 } }),
    actor('alice'),
    { outcome: 'ok', fields: { 'original-estimate': 8 } },
  ),
  run(
    'copy-field-no-parent',
    'Copy from parent does nothing on an item without a parent',
    [{ type: 'copy-field', from: 'fix-version', to: 'fix-version', fromParent: true }],
    item(),
    actor('alice'),
    { outcome: 'ok', fields: {} },
  ),
  // Security level from role.
  run(
    'security-level-from-role',
    'Set security level from the user’s space role',
    [{ type: 'set-security-level-from-role', levels: { contractors: 'internal', staff: 'all' } }],
    item(),
    actor('alice', { roles: ['contractors'] }),
    { outcome: 'ok', securityLevel: 'internal' },
  ),
  run(
    'security-level-no-matching-role',
    'No matching role leaves the security level unchanged',
    [{ type: 'set-security-level-from-role', levels: { contractors: 'internal' } }],
    item({ securityLevel: 'all' }),
    actor('alice', { roles: ['staff'] }),
    { outcome: 'ok', securityLevel: 'all' },
  ),
  // Webhooks.
  run(
    'webhook-fires',
    'Trigger webhook posts to the configured URL',
    [{ type: 'webhook', url: 'https://hooks.example/start' }],
    item(),
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
    item(),
    actor('alice'),
    { outcome: 'ok', webhooks: ['https://hooks.example/a', 'https://hooks.example/b'] },
  ),
  c('webhook-on-create', {
    kind: 'create',
    title: 'The webhook post function also fires on the create transition',
    workflow: createWithWebhook,
    actor: actor('bob'),
    expect: { status: 'open', event: 'item-created', webhooks: ['https://hooks.example/created'] },
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
    [{ type: 'update-field', field: 'stage', value: 'development' }],
    item(),
    actor('alice'),
    { outcome: 'ok', fields: { stage: 'development' } },
  ),
  run(
    'update-custom-field-overwrites',
    'Update a custom field overwrites and records the old value',
    [{ type: 'update-field', field: 'stage', value: 'development' }],
    item({ fields: { stage: 'triage' } }),
    actor('alice'),
    {
      outcome: 'ok',
      added: [
        { field: 'status', from: 'open', to: 'in-progress', by: 'alice', transition: 'start' },
        { field: 'stage', from: 'triage', to: 'development', by: 'alice', transition: 'start' },
      ],
    },
  ),
  ...SYSTEM_FIELDS.map(({ field, value }) =>
    run(
      `update-system-field-${field}`,
      `Update system field ${field}`,
      [{ type: 'update-system-field', field, value }],
      item(),
      actor('alice'),
      field === 'assignee'
        ? { outcome: 'ok', assignee: 'carol' }
        : field === 'resolution'
          ? { outcome: 'ok', resolution: 'Done', resolvedAt: NOW }
          : { outcome: 'ok', fields: { [field]: value } },
    ),
  ),
  // Several post functions, in order, each recorded.
  run(
    'several-in-order',
    'Optional post functions run in list order and each change is recorded',
    [
      { type: 'update-field', field: 'a', value: 1 },
      { type: 'copy-field', from: 'a', to: 'b' },
      { type: 'assign-to-reporter' },
    ],
    item({ assignee: 'alice', reporter: 'bob' }),
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
    'the public description fixes the order of the essential functions only; this suite records optional changes in list order after the status',
  ),
  run(
    'placeholder-does-nothing',
    'An imported placeholder is disabled and changes nothing',
    [
      { type: 'placeholder', jiraClass: 'com.example.CustomFunction' },
      { type: 'update-field', field: 'a', value: 1 },
    ],
    item(),
    actor('alice'),
    { outcome: 'ok', fields: { a: 1 } },
  ),
  c('post-functions-per-transition', {
    kind: 'transition',
    title: 'Post functions on Start do not run on Cancel',
    workflow: withTransition(posted([{ type: 'assign-to-current-user' }]), 'cancel', {}),
    item: item({ assignee: 'bob' }),
    actor: actor('alice'),
    request: { transition: 'cancel', now: NOW },
    expect: { outcome: 'ok', status: 'cancelled', assignee: 'bob' },
  }),
];
