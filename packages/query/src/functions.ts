import type { Field } from './fields';

/**
 * The functions of the query language (M1-038; QRY-004; spec 01b section 1.6): for each, what
 * it returns, which fields take it, its arguments, and whether it returns one value or several.
 * The resolver checks calls against this table and evaluates what needs no database (the
 * person, dates); the server's binder evaluates the rest (`apps/server/src/search/bind.ts`),
 * or names the module a function belongs to when this version does not have it yet. Names are
 * Taskmoor's; the Jira-compatible names map onto them in the dialect (`dialect.ts`).
 */

/** What a function returns, which decides the fields that take it. */
export type FunctionResult =
  | 'user'
  | 'date'
  | 'ticket'
  | 'track'
  | 'area'
  | 'ticketType'
  | 'option'
  | 'release'
  | 'sprint'
  | 'approval'
  | 'sla'
  | 'customerGroup';

/** How an argument is read. */
export type ArgumentKind =
  /** A person: a name, an email, an id or currentUser(). */
  | 'user'
  /** A date or instant: absolute, a duration such as -1w, or a date function. */
  | 'date'
  /** A duration increment such as -1w or +3d. */
  | 'increment'
  /** A ticket key or id. */
  | 'ticket'
  /** Any text: a group, a link type, a role, a permission, a global id, an option. */
  | 'text'
  /** A track key or id. */
  | 'track';

export interface FunctionSpec {
  name: string;
  returns: FunctionResult;
  /** Returns several values: only IN and NOT IN take it. */
  many: boolean;
  /** Required arguments, then optional ones, in order. */
  args: readonly { name: string; kind: ArgumentKind; optional?: true }[];
  /** The last argument repeats, up to `max` arguments in all (without limit when absent). */
  repeat?: { max?: number };
}

const arg = (name: string, kind: ArgumentKind) => ({ name, kind });
const opt = (name: string, kind: ArgumentKind) => ({ name, kind, optional: true as const });

const fn = (
  name: string,
  returns: FunctionResult,
  many: boolean,
  args: FunctionSpec['args'] = [],
  repeat?: FunctionSpec['repeat'],
): FunctionSpec => ({ name, returns, many, args, ...(repeat ? { repeat } : {}) });

const dateFunction = (name: string) => fn(name, 'date', false, [opt('increment', 'increment')]);

/** Section 1.6, restated with each function's signature. */
export const FUNCTIONS: readonly FunctionSpec[] = [
  // People and groups.
  fn('currentUser', 'user', false),
  fn('membersOf', 'user', true, [arg('group', 'text')]),
  // Dates.
  // `now(-30m)`: Taskmoor takes an increment on now() too.
  dateFunction('now'),
  fn('currentLogin', 'date', false),
  fn('lastLogin', 'date', false),
  ...[
    'startOfDay',
    'startOfWeek',
    'startOfMonth',
    'startOfYear',
    'endOfDay',
    'endOfWeek',
    'endOfMonth',
    'endOfYear',
  ].map(dateFunction),
  // Tickets: history, links, following and votes.
  fn('ticketHistory', 'ticket', true),
  fn('updatedBy', 'ticket', true, [arg('user', 'user'), opt('from', 'date'), opt('to', 'date')]),
  fn('linkedTickets', 'ticket', true, [arg('ticket', 'ticket'), opt('link type', 'text')], {
    max: 3,
  }),
  fn('ticketsWithWebLinksByGlobalId', 'ticket', true, [arg('global id', 'text')], {}),
  fn('votedTickets', 'ticket', true),
  fn('followedTickets', 'ticket', true),
  // Tracks and areas by person.
  fn('tracksOwnedByUser', 'track', true, [opt('user', 'user')]),
  fn('tracksWhereUserHasPermission', 'track', true, [arg('permission', 'text')]),
  fn('tracksWhereUserHasRole', 'track', true, [arg('role', 'text')]),
  fn('areasOwnedByUser', 'area', true, [opt('user', 'user')]),
  // Ticket types and options.
  fn('standardTicketTypes', 'ticketType', true),
  fn('subticketTypes', 'ticketType', true),
  fn('cascadeOption', 'option', true, [arg('parent', 'text'), opt('child', 'text')]),
  fn('choiceOption', 'option', true, [arg('option', 'text')], { max: 50 }),
  // Sprints and releases (M1-045).
  fn('openSprints', 'sprint', true),
  fn('closedSprints', 'sprint', true),
  fn('futureSprints', 'sprint', true),
  fn('shippedReleases', 'release', true, [opt('track', 'track')]),
  fn('upcomingReleases', 'release', true, [opt('track', 'track')]),
  fn('latestShippedRelease', 'release', false, [arg('track', 'track')]),
  fn('earliestUpcomingRelease', 'release', false, [arg('track', 'track')]),
  // Service tracks (file 04a).
  fn('approved', 'approval', false),
  fn('approver', 'approval', false, [arg('user', 'user')], { max: 5 }),
  fn('myApproval', 'approval', false),
  fn('myPendingApproval', 'approval', false),
  fn('myPending', 'approval', false),
  fn('pending', 'approval', false),
  fn('pendingApprovalBy', 'approval', false, [arg('user', 'user')], { max: 5 }),
  fn('pendingBy', 'approval', false, [arg('user', 'user')], { max: 5 }),
  fn('breached', 'sla', false),
  fn('completed', 'sla', false),
  fn('everBreached', 'sla', false),
  fn('paused', 'sla', false),
  fn('running', 'sla', false),
  fn('withinCalendarHours', 'sla', false),
  fn('remaining', 'sla', false, [arg('time', 'text')]),
  fn('customerDetail', 'user', true, [arg('detail', 'text'), arg('value', 'text')]),
  fn('customerGroupMembers', 'user', true, [arg('customer group', 'text')]),
  fn('customerGroupDetail', 'customerGroup', true, [arg('detail', 'text'), arg('value', 'text')]),
  fn('entitlementDetail', 'customerGroup', true, [arg('detail', 'text'), arg('value', 'text')]),
  fn('entitlementProduct', 'customerGroup', true, [arg('product', 'text')]),
];

const BY_NAME = new Map(FUNCTIONS.map((f) => [f.name.toLowerCase(), f]));

/** A function by its native name, in any case; undefined for an unknown name. */
export function findFunction(nativeName: string): FunctionSpec | undefined {
  return BY_NAME.get(nativeName.toLowerCase());
}

/** The least and most arguments a function takes (most is Infinity when it has no limit). */
export function arity(f: FunctionSpec): [number, number] {
  const min = f.args.filter((a) => !a.optional).length;
  if (!f.repeat) return [min, f.args.length];
  return [min, f.repeat.max ?? Number.POSITIVE_INFINITY];
}

/** The argument at a position, the last one repeating. */
export function argumentAt(f: FunctionSpec, index: number): FunctionSpec['args'][number] {
  const last = f.args[f.args.length - 1];
  return (f.args[index] ?? last) as FunctionSpec['args'][number];
}

/** Whether a field takes what a function returns. */
export function fieldTakes(field: Field, result: FunctionResult): boolean {
  switch (result) {
    case 'user':
      return field.type === 'user';
    case 'date':
      return field.type === 'date' || field.type === 'datetime';
    case 'ticket':
      return field.type === 'key';
    case 'track':
      return field.type === 'track';
    case 'area':
      return field.type === 'area';
    case 'ticketType':
      return field.type === 'ticketType';
    case 'option':
      return (
        field.kind === 'custom' &&
        (field.type === 'option' || field.type === 'multi' || field.type === 'cascade')
      );
    case 'release':
      return field.type === 'release';
    case 'sprint':
      return field.type === 'sprint';
    case 'approval':
      return field.kind === 'system' && field.name === 'approvals';
    case 'customerGroup':
      return field.kind === 'system' && field.name === 'customerGroup';
    case 'sla':
      // SLA fields arrive with service tracks (M2-013).
      return false;
  }
}

/** What a function returns, as a refusal names it. */
export const RESULT_NAMES: Readonly<Record<FunctionResult, string>> = {
  user: 'people',
  date: 'a date',
  ticket: 'tickets',
  track: 'tracks',
  area: 'areas',
  ticketType: 'ticket types',
  option: 'options of a select field',
  release: 'releases',
  sprint: 'sprints',
  approval: 'approvals',
  sla: 'an SLA state',
  customerGroup: 'customer groups',
};
