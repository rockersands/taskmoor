import type { CheckDef, CompareOp } from '../../model';
import type { ConformanceCase } from '../case';
import { actor, reviewed, section, ticket, withChecks } from './fixtures';

const c = section('WF-004', 'checks', '01a 3.3, WF-004');

function startCase(
  slug: string,
  title: string,
  checks: CheckDef[],
  layout: string[],
  ticketState: ReturnType<typeof ticket>,
  who: ReturnType<typeof actor>,
  entered: Record<string, unknown> | undefined,
  pass: boolean,
  blockedBy?: string,
  message?: string,
  verify?: string,
): ConformanceCase {
  return c(slug, {
    kind: 'transition',
    title,
    workflow: withChecks(checks, layout),
    ticket: ticketState,
    actor: who,
    request: { transition: 'start', ...(entered ? { fields: entered } : {}) },
    expect: pass
      ? { outcome: 'ok', status: 'in-progress' }
      : {
          outcome: 'blocked',
          by: 'check',
          name: blockedBy ?? checks[0]?.type ?? 'check',
          ...(message ? { message } : {}),
        },
    ...(verify ? { verify } : {}),
  });
}

const OPS: CompareOp[] = ['=', '!=', '>', '>=', '<', '<='];
const holds = (op: CompareOp, l: number, r: number) =>
  op === '='
    ? l === r
    : op === '!='
      ? l !== r
      : op === '>'
        ? l > r
        : op === '>='
          ? l >= r
          : op === '<'
            ? l < r
            : l <= r;
const opSlug = (op: CompareOp) =>
  op === '='
    ? 'eq'
    : op === '!='
      ? 'ne'
      : op === '>'
        ? 'gt'
        : op === '>='
          ? 'ge'
          : op === '<'
            ? 'lt'
            : 'le';

/** Date compare, every operator, with the due date before, on and after the start date. */
const dateCompareCases: ConformanceCase[] = OPS.flatMap((op) =>
  [
    ['before', '2026-10-11'],
    ['same', '2026-10-12'],
    ['after', '2026-10-13'],
  ].map(([rel, due]) =>
    startCase(
      `date-compare-${opSlug(op)}-${rel}`,
      `Date compare: due ${op} start with due ${rel} start`,
      [{ type: 'date-compare', field: 'due', op, other: 'start' }],
      [],
      ticket({ fields: { start: '2026-10-12', due } }),
      actor('alice'),
      undefined,
      holds(op, Date.parse(due as string), Date.parse('2026-10-12')),
      'date-compare',
    ),
  ),
);

export const CHECK_CASES: ConformanceCase[] = [
  // Field required.
  startCase(
    'field-required-missing',
    'Field required blocks with a field-level message',
    [{ type: 'field-required', field: 'target-release' }],
    ['target-release'],
    ticket(),
    actor('alice'),
    undefined,
    false,
    'field-required',
    'target-release is required',
  ),
  startCase(
    'field-required-entered',
    'Field required passes when the layout supplies the value',
    [{ type: 'field-required', field: 'target-release' }],
    ['target-release'],
    ticket(),
    actor('alice'),
    { 'target-release': '1.2' },
    true,
  ),
  startCase(
    'field-required-already-set',
    'Field required passes when the ticket already holds a value',
    [{ type: 'field-required', field: 'target-release' }],
    [],
    ticket({ fields: { 'target-release': '1.1' } }),
    actor('alice'),
    undefined,
    true,
  ),
  startCase(
    'field-required-empty-string',
    'Field required treats an empty string as missing',
    [{ type: 'field-required', field: 'target-release' }],
    ['target-release'],
    ticket(),
    actor('alice'),
    { 'target-release': '' },
    false,
    'field-required',
  ),
  startCase(
    'field-required-empty-list',
    'Field required treats an empty list as missing',
    [{ type: 'field-required', field: 'labels' }],
    ['labels'],
    ticket(),
    actor('alice'),
    { labels: [] },
    false,
    'field-required',
  ),
  startCase(
    'field-required-custom-message',
    'A configured message replaces the default',
    [{ type: 'field-required', field: 'target-release', message: 'Pick the release first' }],
    ['target-release'],
    ticket(),
    actor('alice'),
    undefined,
    false,
    'field-required',
    'Pick the release first',
  ),
  startCase(
    'field-required-assignee',
    'Field required works on the assignee',
    [{ type: 'field-required', field: 'assignee' }],
    ['assignee'],
    ticket({ assignee: null }),
    actor('alice'),
    undefined,
    false,
    'field-required',
  ),
  startCase(
    'field-required-assignee-entered',
    'Field required passes an assignee set on the layout',
    [{ type: 'field-required', field: 'assignee' }],
    ['assignee'],
    ticket({ assignee: null }),
    actor('alice'),
    { assignee: 'alice' },
    true,
  ),
  // Field has been modified.
  startCase(
    'field-modified-changed',
    'Field has been modified passes a changed value',
    [{ type: 'field-modified', field: 'summary' }],
    ['summary'],
    ticket({ fields: { summary: 'old' } }),
    actor('alice'),
    { summary: 'new' },
    true,
  ),
  startCase(
    'field-modified-same',
    'Field has been modified blocks the same value',
    [{ type: 'field-modified', field: 'summary' }],
    ['summary'],
    ticket({ fields: { summary: 'old' } }),
    actor('alice'),
    { summary: 'old' },
    false,
    'field-modified',
  ),
  startCase(
    'field-modified-untouched',
    'Field has been modified blocks when the field was not entered',
    [{ type: 'field-modified', field: 'summary' }],
    ['summary'],
    ticket({ fields: { summary: 'old' } }),
    actor('alice'),
    undefined,
    false,
    'field-modified',
  ),
  // Field has single value.
  startCase(
    'single-value-one',
    'Single value passes one value',
    [{ type: 'field-single-value', field: 'areas' }],
    ['areas'],
    ticket(),
    actor('alice'),
    { areas: ['api'] },
    true,
  ),
  startCase(
    'single-value-two',
    'Single value blocks two values',
    [{ type: 'field-single-value', field: 'areas' }],
    ['areas'],
    ticket(),
    actor('alice'),
    { areas: ['api', 'web'] },
    false,
    'field-single-value',
  ),
  startCase(
    'single-value-empty',
    'Single value passes an empty field',
    [{ type: 'field-single-value', field: 'areas' }],
    [],
    ticket(),
    actor('alice'),
    undefined,
    true,
  ),
  // Date compare and date window.
  ...dateCompareCases,
  startCase(
    'date-compare-time-ignored',
    'Date compare ignores the time unless asked',
    [{ type: 'date-compare', field: 'due', op: '=', other: 'start' }],
    [],
    ticket({ fields: { start: '2026-10-12T08:00:00Z', due: '2026-10-12T17:00:00Z' } }),
    actor('alice'),
    undefined,
    true,
  ),
  startCase(
    'date-compare-time-included',
    'Date compare with time sees the later time',
    [{ type: 'date-compare', field: 'due', op: '>', other: 'start', includeTime: true }],
    [],
    ticket({ fields: { start: '2026-10-12T08:00:00Z', due: '2026-10-12T17:00:00Z' } }),
    actor('alice'),
    undefined,
    true,
  ),
  startCase(
    'date-compare-time-included-equal-dates-block',
    'Date compare with time blocks = on different times',
    [{ type: 'date-compare', field: 'due', op: '=', other: 'start', includeTime: true }],
    [],
    ticket({ fields: { start: '2026-10-12T08:00:00Z', due: '2026-10-12T17:00:00Z' } }),
    actor('alice'),
    undefined,
    false,
    'date-compare',
  ),
  startCase(
    'date-compare-missing',
    'Date compare blocks when a date is missing',
    [{ type: 'date-compare', field: 'due', op: '>=', other: 'start' }],
    [],
    ticket({ fields: { start: '2026-10-12' } }),
    actor('alice'),
    undefined,
    false,
    'date-compare',
  ),
  startCase(
    'date-compare-entered-on-layout',
    'Date compare reads the value entered on the layout',
    [{ type: 'date-compare', field: 'due', op: '>=', other: 'start' }],
    ['due'],
    ticket({ fields: { start: '2026-10-12' } }),
    actor('alice'),
    { due: '2026-10-20' },
    true,
  ),
  startCase(
    'date-window-inside',
    'Date window passes a date within N days',
    [{ type: 'date-window', field: 'due', other: 'start', days: 7 }],
    [],
    ticket({ fields: { start: '2026-10-12', due: '2026-10-19' } }),
    actor('alice'),
    undefined,
    true,
  ),
  startCase(
    'date-window-outside',
    'Date window blocks a date beyond N days',
    [{ type: 'date-window', field: 'due', other: 'start', days: 7 }],
    [],
    ticket({ fields: { start: '2026-10-12', due: '2026-10-20' } }),
    actor('alice'),
    undefined,
    false,
    'date-window',
  ),
  startCase(
    'date-window-before',
    'Date window counts days in both directions',
    [{ type: 'date-window', field: 'due', other: 'start', days: 7 }],
    [],
    ticket({ fields: { start: '2026-10-12', due: '2026-10-06' } }),
    actor('alice'),
    undefined,
    true,
  ),
  // Regular expression.
  startCase(
    'regex-matches',
    'Regular expression passes a matching value',
    [{ type: 'regex', field: 'ticket', pattern: '^[A-Z]+-[0-9]+$' }],
    ['ticket'],
    ticket(),
    actor('alice'),
    { ticket: 'ABC-12' },
    true,
  ),
  startCase(
    'regex-rejects',
    'Regular expression rejects a non-matching value',
    [{ type: 'regex', field: 'ticket', pattern: '^[A-Z]+-[0-9]+$' }],
    ['ticket'],
    ticket(),
    actor('alice'),
    { ticket: 'abc 12' },
    false,
    'regex',
  ),
  startCase(
    'regex-empty',
    'Regular expression rejects an empty value when the pattern needs text',
    [{ type: 'regex', field: 'ticket', pattern: '^[A-Z]+-[0-9]+$' }],
    [],
    ticket(),
    actor('alice'),
    undefined,
    false,
    'regex',
  ),
  startCase(
    'regex-custom-message',
    'A regular expression failure uses the configured message',
    [{ type: 'regex', field: 'ticket', pattern: '^[A-Z]+-[0-9]+$', message: 'Use KEY-123' }],
    ['ticket'],
    ticket(),
    actor('alice'),
    { ticket: '12' },
    false,
    'regex',
    'Use KEY-123',
  ),
  // Forms (shape from M2's forms).
  startCase(
    'forms-attached-none',
    'Forms attached blocks without a form',
    [{ type: 'forms-attached' }],
    [],
    ticket(),
    actor('alice'),
    undefined,
    false,
    'forms-attached',
    undefined,
    'forms arrive in M2; the check shape is fixed now',
  ),
  startCase(
    'forms-attached-one',
    'Forms attached passes with a form',
    [{ type: 'forms-attached' }],
    [],
    ticket({ forms: [{ submitted: false }] }),
    actor('alice'),
    undefined,
    true,
  ),
  startCase(
    'forms-submitted-pending',
    'Forms submitted blocks while a form is open',
    [{ type: 'forms-submitted' }],
    [],
    ticket({ forms: [{ submitted: true }, { submitted: false }] }),
    actor('alice'),
    undefined,
    false,
    'forms-submitted',
  ),
  startCase(
    'forms-submitted-all',
    'Forms submitted passes when every form is submitted',
    [{ type: 'forms-submitted' }],
    [],
    ticket({ forms: [{ submitted: true }] }),
    actor('alice'),
    undefined,
    true,
  ),
  // Parent status.
  startCase(
    'parent-status-in',
    'Parent status passes when the parent is in a listed status',
    [{ type: 'parent-status', statuses: ['in-progress', 'review'] }],
    [],
    ticket({ parent: { status: 'review' } }),
    actor('alice'),
    undefined,
    true,
  ),
  startCase(
    'parent-status-out',
    'Parent status blocks when the parent is elsewhere',
    [{ type: 'parent-status', statuses: ['in-progress'] }],
    [],
    ticket({ parent: { status: 'open' } }),
    actor('alice'),
    undefined,
    false,
    'parent-status',
  ),
  startCase(
    'parent-status-no-parent',
    'Parent status blocks a ticket without a parent',
    [{ type: 'parent-status', statuses: ['in-progress'] }],
    [],
    ticket(),
    actor('alice'),
    undefined,
    false,
    'parent-status',
    undefined,
    'a ticket without a parent is assumed to fail this check',
  ),
  // Permission.
  startCase(
    'permission-holder',
    'Permission passes a holder',
    [{ type: 'permission', permission: 'close' }],
    [],
    ticket(),
    actor('alice', { permissions: ['close'] }),
    undefined,
    true,
  ),
  startCase(
    'permission-non-holder',
    'Permission blocks a non-holder',
    [{ type: 'permission', permission: 'close' }],
    [],
    ticket(),
    actor('alice'),
    undefined,
    false,
    'permission',
  ),
  // Previous state.
  startCase(
    'previous-state-yes',
    'Previous state passes a ticket that was in review',
    [{ type: 'previous-state', status: 'review' }],
    [],
    reviewed(),
    actor('alice'),
    undefined,
    true,
  ),
  startCase(
    'previous-state-no',
    'Previous state blocks a ticket that never was in review',
    [{ type: 'previous-state', status: 'review' }],
    [],
    ticket(),
    actor('alice'),
    undefined,
    false,
    'previous-state',
  ),
  startCase(
    'previous-state-most-recent',
    'Previous state most-recent-only looks at the last status',
    [{ type: 'previous-state', status: 'open', mostRecentOnly: true }],
    [],
    reviewed(),
    actor('alice'),
    undefined,
    false,
    'previous-state',
  ),
  // Order and outcome.
  startCase(
    'first-failing-check-named',
    'Checks run in order and the first failure is named',
    [
      { type: 'field-required', field: 'a' },
      { type: 'field-required', field: 'b' },
    ],
    ['a', 'b'],
    ticket(),
    actor('alice'),
    { a: 'x' },
    false,
    'field-required',
    'b is required',
  ),
  startCase(
    'all-checks-pass',
    'Several checks pass together',
    [
      { type: 'field-required', field: 'a' },
      { type: 'regex', field: 'a', pattern: '^x' },
      { type: 'permission', permission: 'edit' },
    ],
    ['a'],
    ticket(),
    actor('alice', { permissions: ['edit'] }),
    { a: 'xyz' },
    true,
  ),
  c('failure-leaves-everything-untouched', {
    kind: 'transition',
    title: 'After a check failure the ticket, history and effects are untouched',
    workflow: {
      ...withChecks(
        [{ type: 'field-required', field: 'target-release' }],
        ['target-release', 'summary'],
      ),
      transitions: withChecks(
        [{ type: 'field-required', field: 'target-release' }],
        ['target-release', 'summary'],
      ).transitions.map((t) =>
        t.id === 'start'
          ? {
              ...t,
              effects: [
                { type: 'assign-to-current-user' as const },
                { type: 'webhook' as const, url: 'https://hooks.example/x' },
              ],
            }
          : t,
      ),
    },
    ticket: ticket({ assignee: 'bob', fields: { summary: 'old' } }),
    actor: actor('alice'),
    request: { transition: 'start', fields: { summary: 'new' }, comment: 'trying' },
    expect: { outcome: 'blocked', by: 'check', name: 'field-required' },
  }),
  c('checks-run-after-guards', {
    kind: 'transition',
    title: 'A failing guard is reported before any check runs',
    workflow: {
      ...withChecks([{ type: 'field-required', field: 'target-release' }]),
      transitions: withChecks([
        { type: 'field-required', field: 'target-release' },
      ]).transitions.map((t) =>
        t.id === 'start' ? { ...t, guards: { type: 'only-assignee' as const } } : t,
      ),
    },
    ticket: ticket({ assignee: 'bob' }),
    actor: actor('alice'),
    request: { transition: 'start' },
    expect: { outcome: 'blocked', by: 'guard', name: 'only-assignee' },
  }),
];
