import type { Expr, FieldRef, OrderBy, Predicate, Query, Value } from './ast';

/**
 * The Jira-compatible dialect (M1-035, QRY-003). It shares the native grammar (file 06) and
 * differs only in vocabulary (docs/specs/00-terminology.md), so it maps onto the native tree by
 * renaming fields and functions:
 * `toNative` reads either vocabulary and writes Taskmoor's names, `toJira` writes the names a
 * Jira-compatible client expects. Names match without regard to case; names that are the same
 * in both vocabularies, custom fields and unknown names pass through unchanged.
 */

/** Native field name and its Jira-compatible names, the first being the one `toJira` writes. */
export const FIELD_NAMES: readonly (readonly [native: string, ...jira: string[]])[] = [
  ['track', 'project', 'space'],
  ['parentTrack', 'parentProject', 'parentSpace'],
  ['trackType', 'projectType', 'spaceType'],
  ['trackCategory', 'category'],
  ['type', 'issuetype', 'issueType'],
  ['key', 'issuekey', 'issue', 'issueKey'],
  ['created', 'createdDate'],
  ['updated', 'updatedDate'],
  ['due', 'duedate', 'dueDate'],
  ['closed', 'resolutiondate', 'resolutionDate', 'resolved'],
  ['closeReason', 'resolution'],
  ['stage', 'statusCategory'],
  ['requester', 'reporter'],
  ['follower', 'watcher'],
  ['followers', 'watchers'],
  ['area', 'component'],
  ['targetRelease', 'fixVersion'],
  ['foundInRelease', 'affectedVersion'],
  ['effortRatio', 'workRatio'],
  ['timeEntryComment', 'worklogComment'],
  ['timeEntryDate', 'worklogDate'],
  ['visibilityLevel', 'level'],
  ['savedSearch', 'filter', 'request', 'savedFilter', 'searchRequest'],
  ['ticketLink', 'issueLink', 'workItemLink'],
  ['ticketLinkType', 'issueLinkType', 'workItemLinkType'],
  ['linkedTicket', 'linkedWorkItem'],
  ['parentOutcome', 'parentEpic'],
  ['journeyTicket', 'journeyWorkItem'],
  ['customerGroup', 'organization'],
  ['requestForm', 'requestType'],
  ['requestChannel', 'requestChannelType'],
  ['requestLastActivity', 'requestLastActivityTime'],
  ['parent', 'parent', 'Epic link'],
  ['changeGatingType', 'Change gating type'],
  ['labels', 'labels', 'label'],
  ['summary', 'summary', 'title'],
  // Same name in both vocabularies; listed so their case is normalised.
  ...[
    'approvals',
    'assignee',
    'creator',
    'attachments',
    'comment',
    'description',
    'environment',
    'lastViewed',
    'hierarchyLevel',
    'originalEstimate',
    'remainingEstimate',
    'timeSpent',
    'priority',
    'status',
    'sprint',
    'text',
    'voter',
    'votes',
  ].map((name) => [name, name] as const),
];

/** Native function name and its Jira-compatible names, the first being the one `toJira` writes. */
export const FUNCTION_NAMES: readonly (readonly [
  native: string,
  jira: string,
  ...more: string[],
])[] = [
  ['tracksOwnedByUser', 'projectsLeadByUser', 'spacesLeadByUser'],
  [
    'tracksWhereUserHasPermission',
    'projectsWhereUserHasPermission',
    'spacesWhereUserHasPermission',
  ],
  ['tracksWhereUserHasRole', 'projectsWhereUserHasRole', 'spacesWhereUserHasRole'],
  ['areasOwnedByUser', 'componentsLeadByUser'],
  ['linkedTickets', 'linkedIssues', 'linkedWorkItems'],
  ['ticketHistory', 'issueHistory', 'workItemHistory'],
  [
    'ticketsWithWebLinksByGlobalId',
    'issuesWithRemoteLinksByGlobalId',
    'workItemsWithRemoteLinksByGlobalId',
  ],
  ['votedTickets', 'votedIssues', 'votedWorkItems'],
  ['followedTickets', 'watchedIssues', 'watchedWorkItems'],
  ['standardTicketTypes', 'standardIssueTypes', 'standardWorkTypes'],
  ['subticketTypes', 'subTaskIssueTypes', 'subtaskWorkTypes'],
  ['shippedReleases', 'releasedVersions'],
  ['upcomingReleases', 'unreleasedVersions'],
  ['latestShippedRelease', 'latestReleasedVersion'],
  ['earliestUpcomingRelease', 'earliestUnreleasedVersion'],
  ['customerGroupDetail', 'organizationDetail'],
  ['customerGroupMembers', 'organizationMembers'],
  // Same name in both vocabularies; listed so their case is normalised.
  ...[
    'currentUser',
    'membersOf',
    'now',
    'currentLogin',
    'lastLogin',
    'startOfDay',
    'startOfWeek',
    'startOfMonth',
    'startOfYear',
    'endOfDay',
    'endOfWeek',
    'endOfMonth',
    'endOfYear',
    'openSprints',
    'closedSprints',
    'futureSprints',
    'updatedBy',
    'cascadeOption',
    'choiceOption',
    'approved',
    'approver',
    'breached',
    'completed',
    'customerDetail',
    'entitlementDetail',
    'entitlementProduct',
    'everBreached',
    'myApproval',
    'myPendingApproval',
    'myPending',
    'paused',
    'pending',
    'pendingApprovalBy',
    'pendingBy',
    'remaining',
    'running',
    'withinCalendarHours',
  ].map((name) => [name, name] as const),
];

type Names = ReadonlyMap<string, string>;

const lower = (s: string) => s.toLowerCase();

const TO_NATIVE_FIELDS: Names = new Map(
  FIELD_NAMES.flatMap(([native, ...jira]) => [native, ...jira].map((n) => [lower(n), native])),
);
const TO_JIRA_FIELDS: Names = new Map(
  FIELD_NAMES.flatMap(([native, first, ...more]) =>
    [native, first ?? native, ...more].map((n) => [lower(n), first ?? native]),
  ),
);
const TO_NATIVE_FUNCTIONS: Names = new Map(
  FUNCTION_NAMES.flatMap(([native, ...jira]) => [native, ...jira].map((n) => [lower(n), native])),
);
const TO_JIRA_FUNCTIONS: Names = new Map(
  FUNCTION_NAMES.flatMap(([native, first, ...more]) =>
    [native, first, ...more].map((n) => [lower(n), first]),
  ),
);

/** Rewrites a query in either vocabulary to Taskmoor's names. Spans are kept. */
export function toNative(query: Query): Query {
  return rename(query, TO_NATIVE_FIELDS, TO_NATIVE_FUNCTIONS);
}

/** Rewrites a query in either vocabulary to the Jira-compatible names. Spans are kept. */
export function toJira(query: Query): Query {
  return rename(query, TO_JIRA_FIELDS, TO_JIRA_FUNCTIONS);
}

function rename(query: Query, fields: Names, functions: Names): Query {
  const field = (f: FieldRef): FieldRef =>
    f.custom !== undefined ? f : { ...f, name: fields.get(lower(f.name)) ?? f.name };
  const value = (v: Value): Value =>
    v.kind === 'function'
      ? { ...v, name: functions.get(lower(v.name)) ?? v.name, args: v.args.map(value) }
      : v;
  const predicate = (p: Predicate): Predicate => ({ ...p, values: p.values.map(value) });
  const expr = (e: Expr): Expr => {
    switch (e.kind) {
      case 'and':
      case 'or':
        return { ...e, items: e.items.map(expr) };
      case 'not':
        return { ...e, expr: expr(e.expr) };
      case 'compare':
        return { ...e, field: field(e.field), value: value(e.value) };
      case 'in':
        return { ...e, field: field(e.field), values: e.values.map(value) };
      case 'empty':
        return { ...e, field: field(e.field) };
      case 'was':
        return {
          ...e,
          field: field(e.field),
          values: e.values.map(value),
          predicates: e.predicates.map(predicate),
        };
      case 'changed':
        return { ...e, field: field(e.field), predicates: e.predicates.map(predicate) };
    }
  };
  const order = (o: OrderBy): OrderBy => ({ ...o, field: field(o.field) });
  return {
    where: query.where ? expr(query.where) : null,
    orderBy: query.orderBy.map(order),
  };
}
