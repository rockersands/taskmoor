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

/** A function's native name from either vocabulary, in any case; undefined when unknown. */
export function nativeFunctionName(name: string): string | undefined {
  return TO_NATIVE_FUNCTIONS.get(lower(name));
}

/**
 * Track permissions under their Jira-compatible keys (M1-038), for
 * `tracksWhereUserHasPermission()`: the native code first. A permission is also found by its
 * native code with spaces for underscores (`browse track`), in any case.
 */
export const PERMISSION_NAMES: readonly (readonly [native: string, ...jira: string[]])[] = [
  ['browse_track', 'BROWSE_PROJECTS', 'browse'],
  ['administer_track', 'ADMINISTER_PROJECTS'],
  ['create_tickets', 'CREATE_ISSUES'],
  ['edit_tickets', 'EDIT_ISSUES'],
  ['assign_tickets', 'ASSIGN_ISSUES'],
  ['assignable_user', 'ASSIGNABLE_USER'],
  ['close_tickets', 'CLOSE_ISSUES'],
  ['set_close_reason', 'RESOLVE_ISSUES'],
  ['delete_tickets', 'DELETE_ISSUES'],
  ['link_tickets', 'LINK_ISSUES'],
  ['move_tickets', 'MOVE_ISSUES'],
  ['modify_requester', 'MODIFY_REPORTER'],
  ['schedule_tickets', 'SCHEDULE_ISSUES'],
  ['set_visibility_level', 'SET_ISSUE_SECURITY'],
  ['transition_tickets', 'TRANSITION_ISSUES'],
  ['archive_tickets', 'ARCHIVE_ISSUES'],
  ['restore_archived', 'UNARCHIVE_ISSUES'],
  ['manage_followers', 'MANAGE_WATCHERS'],
  ['view_voters_followers', 'VIEW_VOTERS_AND_WATCHERS'],
  ['manage_sprints', 'MANAGE_SPRINTS_PERMISSION'],
  ['service_agent', 'SERVICEDESK_AGENT'],
  ['view_dev_tools', 'VIEW_DEV_TOOLS'],
  ['view_readonly_workflow', 'VIEW_READONLY_WORKFLOW'],
  ['add_comments', 'ADD_COMMENTS'],
  ['delete_all_comments', 'DELETE_ALL_COMMENTS'],
  ['delete_own_comments', 'DELETE_OWN_COMMENTS'],
  ['edit_all_comments', 'EDIT_ALL_COMMENTS'],
  ['edit_own_comments', 'EDIT_OWN_COMMENTS'],
  ['create_attachments', 'CREATE_ATTACHMENTS'],
  ['delete_all_attachments', 'DELETE_ALL_ATTACHMENTS'],
  ['delete_own_attachments', 'DELETE_OWN_ATTACHMENTS'],
  ['record_time', 'WORK_ON_ISSUES'],
  ['edit_all_time_entries', 'EDIT_ALL_WORKLOGS'],
  ['edit_own_time_entries', 'EDIT_OWN_WORKLOGS'],
  ['delete_all_time_entries', 'DELETE_ALL_WORKLOGS'],
  ['delete_own_time_entries', 'DELETE_OWN_WORKLOGS'],
];

const words = (s: string) =>
  lower(s)
    .replace(/[\s_]+/g, ' ')
    .trim();

const TO_NATIVE_PERMISSIONS: Names = new Map(
  PERMISSION_NAMES.flatMap(([native, ...jira]) => [native, ...jira].map((n) => [words(n), native])),
);

/**
 * A track permission's native code from its code or a Jira-compatible key, with underscores
 * or spaces, in any case (`BROWSE_PROJECTS`, `Browse projects`, `browse_track`); undefined for
 * a name neither vocabulary has.
 */
export function nativePermissionName(name: string): string | undefined {
  return TO_NATIVE_PERMISSIONS.get(words(name));
}

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
