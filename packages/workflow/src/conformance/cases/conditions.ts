import type { CompareOp, ConditionNode } from '../../model';
import type { ConformanceCase } from '../case';
import { actor, conditioned, item, reviewed, section, withTransition } from './fixtures';

const c = section('WF-003', 'conditions', '01a 3.2, WF-003');

const OPS: CompareOp[] = ['=', '!=', '>', '>=', '<', '<='];
const holds = (op: CompareOp, left: number, right: number): boolean => {
  switch (op) {
    case '=':
      return left === right;
    case '!=':
      return left !== right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
  }
};

/** A transition case on Start with a condition tree; blocked names the condition type. */
function startCase(
  slug: string,
  title: string,
  conditions: ConditionNode,
  itemState: ReturnType<typeof item>,
  who: ReturnType<typeof actor>,
  pass: boolean,
  blockedBy?: string,
  verify?: string,
): ConformanceCase {
  return c(slug, {
    kind: 'transition',
    title,
    workflow: conditioned(conditions),
    item: itemState,
    actor: who,
    request: { transition: 'start' },
    expect: pass
      ? { outcome: 'ok', status: 'in-progress' }
      : { outcome: 'blocked', by: 'condition', name: blockedBy ?? 'condition' },
    ...(verify ? { verify } : {}),
  });
}

const compareNumberCases: ConformanceCase[] = OPS.flatMap((op) =>
  [
    ['below', 4],
    ['equal', 5],
    ['above', 6],
  ].map(([rel, value]) =>
    startCase(
      `compare-number-${op === '=' ? 'eq' : op === '!=' ? 'ne' : op === '>' ? 'gt' : op === '>=' ? 'ge' : op === '<' ? 'lt' : 'le'}-${rel}`,
      `Compare number: estimate ${op} 5 with estimate ${value}`,
      { type: 'compare-number', field: 'estimate', op, value: 5 },
      item({ fields: { estimate: value } }),
      actor('alice'),
      holds(op, value as number, 5),
      'compare-number',
    ),
  ),
);

const valueFieldCases: ConformanceCase[] = OPS.flatMap((op) =>
  [
    ['below', 1],
    ['equal', 2],
    ['above', 3],
  ].map(([rel, value]) =>
    startCase(
      `value-field-${op === '=' ? 'eq' : op === '!=' ? 'ne' : op === '>' ? 'gt' : op === '>=' ? 'ge' : op === '<' ? 'lt' : 'le'}-${rel}`,
      `Value field: severity ${op} 2 with severity ${value}`,
      { type: 'value-field', field: 'severity', op, value: 2 },
      item({ fields: { severity: value } }),
      actor('alice'),
      holds(op, value as number, 2),
      'value-field',
    ),
  ),
);

/** The tree A and (B or C) over all eight input combinations (WF-003 acceptance 2). */
const treeCases: ConformanceCase[] = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) => {
  const a = Boolean(bits & 4);
  const b = Boolean(bits & 2);
  const d = Boolean(bits & 1);
  const pass = a && (b || d);
  // A: user is the assignee; B: user holds the "move" permission; C: user is in group qa.
  const who = actor('alice', {
    permissions: b ? ['move'] : [],
    groups: d ? ['qa'] : [],
  });
  return startCase(
    `tree-a-and-b-or-c-${a ? 1 : 0}${b ? 1 : 0}${d ? 1 : 0}`,
    `A and (B or C) with A=${a}, B=${b}, C=${d}`,
    {
      all: [
        { type: 'only-assignee' },
        {
          any: [
            { type: 'permission', permission: 'move' },
            { type: 'user-in-group', group: 'qa' },
          ],
        },
      ],
    },
    item({ assignee: a ? 'alice' : 'dave' }),
    who,
    pass,
    a ? 'permission' : 'only-assignee',
  );
});

export const CONDITION_CASES: ConformanceCase[] = [
  // Always false retires a transition.
  startCase(
    'always-false',
    'Always false is never offered',
    { type: 'always-false' },
    item(),
    actor('alice'),
    false,
    'always-false',
  ),
  c('always-false-hidden-from-list', {
    kind: 'available',
    title: 'An always-false transition is missing from the list',
    workflow: conditioned({ type: 'always-false' }),
    item: item(),
    actor: actor('alice'),
    expect: { transitions: ['cancel'] },
  }),
  startCase(
    'always-false-rest',
    'Always false blocks the REST channel too',
    { type: 'always-false' },
    item(),
    actor('alice', { permissions: ['administer'] }),
    false,
    'always-false',
  ),
  // Only assignee / only reporter.
  startCase(
    'only-assignee-passes',
    'Only assignee lets the assignee through',
    { type: 'only-assignee' },
    item({ assignee: 'alice' }),
    actor('alice'),
    true,
  ),
  startCase(
    'only-assignee-blocks',
    'Only assignee blocks another user and names the condition',
    { type: 'only-assignee' },
    item({ assignee: 'alice' }),
    actor('bob'),
    false,
    'only-assignee',
  ),
  startCase(
    'only-assignee-unassigned',
    'Only assignee blocks everyone on an unassigned item',
    { type: 'only-assignee' },
    item({ assignee: null }),
    actor('alice'),
    false,
    'only-assignee',
  ),
  c('only-assignee-hidden-from-list', {
    kind: 'available',
    title: 'A non-assignee does not see the transition',
    workflow: conditioned({ type: 'only-assignee' }),
    item: item({ assignee: 'alice' }),
    actor: actor('bob'),
    expect: { transitions: ['cancel'] },
  }),
  c('only-assignee-rest-error-names-condition', {
    kind: 'transition',
    title: 'REST returns an error naming the condition',
    workflow: conditioned({ type: 'only-assignee' }),
    item: item({ assignee: 'alice' }),
    actor: actor('bob'),
    request: { transition: 'start', channel: 'rest' },
    expect: { outcome: 'blocked', by: 'condition', name: 'only-assignee' },
  }),
  startCase(
    'only-reporter-passes',
    'Only reporter lets the reporter through',
    { type: 'only-reporter' },
    item({ reporter: 'bob' }),
    actor('bob'),
    true,
  ),
  startCase(
    'only-reporter-blocks',
    'Only reporter blocks the assignee',
    { type: 'only-reporter' },
    item({ reporter: 'bob' }),
    actor('alice'),
    false,
    'only-reporter',
  ),
  // Hide from user.
  startCase(
    'hide-from-user-ui',
    'Hide from user blocks the UI channel',
    { type: 'hide-from-user' },
    item(),
    actor('alice'),
    false,
    'hide-from-user',
  ),
  c('hide-from-user-rest', {
    kind: 'transition',
    title: 'Hide from user allows REST',
    workflow: conditioned({ type: 'hide-from-user' }),
    item: item(),
    actor: actor('alice'),
    request: { transition: 'start', channel: 'rest' },
    expect: { outcome: 'ok', status: 'in-progress' },
  }),
  c('hide-from-user-automation', {
    kind: 'transition',
    title: 'Hide from user allows automation',
    workflow: conditioned({ type: 'hide-from-user' }),
    item: item(),
    actor: actor('alice'),
    request: { transition: 'start', channel: 'automation' },
    expect: { outcome: 'ok', status: 'in-progress' },
  }),
  c('hide-from-user-post-function', {
    kind: 'transition',
    title: 'Hide from user allows a post function',
    workflow: conditioned({ type: 'hide-from-user' }),
    item: item(),
    actor: actor('alice'),
    request: { transition: 'start', channel: 'post-function' },
    expect: { outcome: 'ok', status: 'in-progress' },
  }),
  c('hide-from-user-not-listed', {
    kind: 'available',
    title: 'A hidden transition is not listed for the UI',
    workflow: conditioned({ type: 'hide-from-user' }),
    item: item(),
    actor: actor('alice'),
    expect: { transitions: ['cancel'] },
  }),
  c('hide-from-user-listed-for-rest', {
    kind: 'available',
    title: 'A hidden transition is listed for REST',
    workflow: conditioned({ type: 'hide-from-user' }),
    item: item(),
    actor: actor('alice'),
    channel: 'rest',
    expect: { transitions: ['start', 'cancel'] },
  }),
  // Permission.
  startCase(
    'permission-passes',
    'Permission passes a holder',
    { type: 'permission', permission: 'resolve' },
    item(),
    actor('alice', { permissions: ['resolve'] }),
    true,
  ),
  startCase(
    'permission-blocks',
    'Permission blocks a non-holder',
    { type: 'permission', permission: 'resolve' },
    item(),
    actor('alice', { permissions: ['edit'] }),
    false,
    'permission',
  ),
  // Previous status.
  startCase(
    'previous-status-been-through',
    'Previous status passes an item that was in review',
    { type: 'previous-status', status: 'review' },
    reviewed(),
    actor('alice'),
    true,
  ),
  startCase(
    'previous-status-never',
    'Previous status blocks an item that never was in review',
    { type: 'previous-status', status: 'review' },
    item(),
    actor('alice'),
    false,
    'previous-status',
  ),
  startCase(
    'previous-status-most-recent-yes',
    'Most recent only passes when review was the last status',
    { type: 'previous-status', status: 'review', mostRecentOnly: true },
    reviewed(),
    actor('alice'),
    true,
    undefined,
    'the public description does not say whether the current status counts as "been in"; this suite excludes it',
  ),
  startCase(
    'previous-status-most-recent-no',
    'Most recent only blocks when review was earlier',
    { type: 'previous-status', status: 'open', mostRecentOnly: true },
    reviewed(),
    actor('alice'),
    false,
    'previous-status',
  ),
  startCase(
    'previous-status-current-excluded',
    'The current status does not count as a previous one',
    { type: 'previous-status', status: 'open' },
    item(),
    actor('alice'),
    false,
    'previous-status',
    'see previous-status-most-recent-yes',
  ),
  // Separation of duties.
  startCase(
    'separation-of-duties-blocks',
    'The user who performed Review cannot perform Start',
    { type: 'separation-of-duties', transition: 'review' },
    reviewed(),
    actor('alice'),
    false,
    'separation-of-duties',
  ),
  startCase(
    'separation-of-duties-passes',
    'Another user can',
    { type: 'separation-of-duties', transition: 'review' },
    reviewed(),
    actor('carol'),
    true,
  ),
  startCase(
    'separation-of-duties-no-history',
    'Nobody performed the other transition yet',
    { type: 'separation-of-duties', transition: 'review' },
    item(),
    actor('alice'),
    true,
  ),
  // Subtask blocking.
  startCase(
    'subtask-blocking-all-done',
    'All subtasks in a listed status',
    { type: 'subtask-blocking', statuses: ['done', 'cancelled'] },
    item({ subtasks: [{ status: 'done' }, { status: 'cancelled' }] }),
    actor('alice'),
    true,
  ),
  startCase(
    'subtask-blocking-one-open',
    'One subtask outside the listed statuses blocks',
    { type: 'subtask-blocking', statuses: ['done'] },
    item({ subtasks: [{ status: 'done' }, { status: 'open' }] }),
    actor('alice'),
    false,
    'subtask-blocking',
  ),
  startCase(
    'subtask-blocking-none',
    'No subtasks at all passes',
    { type: 'subtask-blocking', statuses: ['done'] },
    item(),
    actor('alice'),
    true,
    undefined,
    'an item without subtasks is assumed to pass',
  ),
  // Groups and roles.
  startCase(
    'user-in-group-member',
    'User in group passes a member',
    { type: 'user-in-group', group: 'qa' },
    item(),
    actor('alice', { groups: ['qa'] }),
    true,
  ),
  startCase(
    'user-in-group-non-member',
    'User in group blocks a non-member',
    { type: 'user-in-group', group: 'qa' },
    item(),
    actor('alice', { groups: ['dev'] }),
    false,
    'user-in-group',
  ),
  startCase(
    'user-in-any-group-one',
    'User in any group passes with one of them',
    { type: 'user-in-any-group', groups: ['qa', 'ops'] },
    item(),
    actor('alice', { groups: ['ops'] }),
    true,
  ),
  startCase(
    'user-in-any-group-none',
    'User in any group blocks with none',
    { type: 'user-in-any-group', groups: ['qa', 'ops'] },
    item(),
    actor('alice', { groups: ['dev'] }),
    false,
    'user-in-any-group',
  ),
  startCase(
    'user-in-any-group-no-groups',
    'User in any group blocks a user without groups',
    { type: 'user-in-any-group', groups: ['qa'] },
    item(),
    actor('alice'),
    false,
    'user-in-any-group',
  ),
  startCase(
    'user-in-role-holder',
    'User in space role passes a holder',
    { type: 'user-in-role', role: 'developers' },
    item(),
    actor('alice', { roles: ['developers'] }),
    true,
  ),
  startCase(
    'user-in-role-other',
    'User in space role blocks another role',
    { type: 'user-in-role', role: 'developers' },
    item(),
    actor('alice', { roles: ['viewers'] }),
    false,
    'user-in-role',
  ),
  startCase(
    'user-in-any-role-one',
    'User in any space role passes with one',
    { type: 'user-in-any-role', roles: ['developers', 'admins'] },
    item(),
    actor('alice', { roles: ['admins'] }),
    true,
  ),
  startCase(
    'user-in-any-role-none',
    'User in any space role blocks with none',
    { type: 'user-in-any-role', roles: ['developers', 'admins'] },
    item(),
    actor('alice', { roles: ['viewers'] }),
    false,
    'user-in-any-role',
  ),
  // User fields.
  startCase(
    'user-in-field-single',
    'User in custom field passes the user held by the field',
    { type: 'user-in-field', field: 'approver' },
    item({ fields: { approver: 'alice' } }),
    actor('alice'),
    true,
  ),
  startCase(
    'user-in-field-multi',
    'User in custom field passes a user in a multi-user field',
    { type: 'user-in-field', field: 'watchers' },
    item({ fields: { watchers: ['bob', 'alice'] } }),
    actor('alice'),
    true,
  ),
  startCase(
    'user-in-field-other',
    'User in custom field blocks another user',
    { type: 'user-in-field', field: 'approver' },
    item({ fields: { approver: 'bob' } }),
    actor('alice'),
    false,
    'user-in-field',
  ),
  startCase(
    'user-in-field-empty',
    'User in custom field blocks when the field is empty',
    { type: 'user-in-field', field: 'approver' },
    item(),
    actor('alice'),
    false,
    'user-in-field',
  ),
  startCase(
    'user-in-group-field-member',
    'User in group custom field passes a member of the stored group',
    { type: 'user-in-group-field', field: 'team' },
    item({ fields: { team: 'qa' } }),
    actor('alice', { groups: ['qa'] }),
    true,
  ),
  startCase(
    'user-in-group-field-multi',
    'User in group custom field passes with one of several stored groups',
    { type: 'user-in-group-field', field: 'teams' },
    item({ fields: { teams: ['ops', 'qa'] } }),
    actor('alice', { groups: ['qa'] }),
    true,
  ),
  startCase(
    'user-in-group-field-non-member',
    'User in group custom field blocks a non-member',
    { type: 'user-in-group-field', field: 'team' },
    item({ fields: { team: 'qa' } }),
    actor('alice', { groups: ['dev'] }),
    false,
    'user-in-group-field',
  ),
  // Compare number and value field, every operator.
  ...compareNumberCases,
  startCase(
    'compare-number-missing',
    'Compare number blocks when the field is empty',
    { type: 'compare-number', field: 'estimate', op: '>=', value: 0 },
    item(),
    actor('alice'),
    false,
    'compare-number',
  ),
  startCase(
    'compare-number-text',
    'Compare number blocks when the field is not a number',
    { type: 'compare-number', field: 'estimate', op: '>', value: 1 },
    item({ fields: { estimate: 'many' } }),
    actor('alice'),
    false,
    'compare-number',
  ),
  ...valueFieldCases,
  startCase(
    'value-field-string-eq',
    'Value field compares strings with =',
    { type: 'value-field', field: 'kind', op: '=', value: 'bug' },
    item({ fields: { kind: 'bug' } }),
    actor('alice'),
    true,
  ),
  startCase(
    'value-field-string-ne',
    'Value field compares strings with !=',
    { type: 'value-field', field: 'kind', op: '!=', value: 'bug' },
    item({ fields: { kind: 'bug' } }),
    actor('alice'),
    false,
    'value-field',
  ),
  startCase(
    'value-field-missing-ne',
    'Value field != passes when the field is empty',
    { type: 'value-field', field: 'kind', op: '!=', value: 'bug' },
    item(),
    actor('alice'),
    true,
  ),
  // Nesting.
  ...treeCases,
  startCase(
    'nested-three-levels-pass',
    'Three levels of nesting pass',
    {
      all: [
        {
          any: [
            { all: [{ type: 'only-assignee' }, { type: 'user-in-group', group: 'qa' }] },
            { type: 'always-false' },
          ],
        },
      ],
    },
    item({ assignee: 'alice' }),
    actor('alice', { groups: ['qa'] }),
    true,
  ),
  startCase(
    'nested-three-levels-block',
    'Three levels of nesting block and name the leaf',
    {
      all: [
        {
          any: [
            { all: [{ type: 'only-assignee' }, { type: 'user-in-group', group: 'qa' }] },
            { type: 'always-false' },
          ],
        },
      ],
    },
    item({ assignee: 'alice' }),
    actor('alice', { groups: ['dev'] }),
    false,
    'user-in-group',
  ),
  startCase(
    'empty-all-passes',
    'An empty all group passes',
    { all: [] },
    item(),
    actor('alice'),
    true,
  ),
  startCase(
    'any-first-failing-named',
    'A failed any group names its first condition',
    { any: [{ type: 'only-reporter' }, { type: 'only-assignee' }] },
    item({ assignee: 'alice', reporter: 'bob' }),
    actor('carol'),
    false,
    'only-reporter',
  ),
  startCase(
    'any-second-branch-passes',
    'An any group passes on its second branch',
    { any: [{ type: 'only-reporter' }, { type: 'only-assignee' }] },
    item({ assignee: 'alice', reporter: 'bob' }),
    actor('alice'),
    true,
  ),
  // Conditions on other transitions and the listing.
  c('conditions-per-transition', {
    kind: 'available',
    title: 'A condition on one transition does not touch the others',
    workflow: withTransition(conditioned({ type: 'always-false' }), 'cancel', {
      conditions: { type: 'only-assignee' },
    }),
    item: item({ assignee: 'alice' }),
    actor: actor('alice'),
    expect: { transitions: ['cancel'] },
  }),
  c('condition-on-global-transition', {
    kind: 'available',
    title: 'A condition on a global transition hides it from a non-holder in every status',
    workflow: withTransition(W1Base(), 'cancel', {
      conditions: { type: 'permission', permission: 'cancel' },
    }),
    item: item({ status: 'review' }),
    actor: actor('alice'),
    expect: { transitions: ['back', 'finish'] },
  }),
  c('block-until-approval-pending', {
    kind: 'transition',
    title: 'Block until approval is unavailable while an approval is pending (M2 shape)',
    workflow: conditioned({ type: 'block-until-approval' }),
    item: item({ fields: { 'approval-pending': true } }),
    actor: actor('alice'),
    request: { transition: 'start' },
    expect: { outcome: 'blocked', by: 'condition', name: 'block-until-approval' },
    verify:
      'approvals arrive with WF-013 (M2); until then the pending flag stands in for the approval record',
  }),
];

function W1Base() {
  return conditioned({ all: [] });
}
