import type { Expr, FieldRef, OrderBy, Predicate, Query, Value } from './ast';

/**
 * The Jira-compatible dialect (M1-035, QRY-003). It shares the native grammar (file 06) and
 * differs only in vocabulary, so it maps onto the native tree by renaming fields and functions:
 * `toNative` reads either vocabulary and writes Tracksmith's names, `toJira` writes the names a
 * Jira-compatible client expects. Names match without regard to case; names that are the same
 * in both vocabularies, custom fields and unknown names pass through unchanged.
 */

/** Native field name and its Jira-compatible names, the first being the one `toJira` writes. */
export const FIELD_NAMES: readonly (readonly [native: string, ...jira: string[]])[] = [
  ['space', 'project'],
  ['parentSpace', 'parentProject'],
  ['spaceType', 'projectType'],
  ['type', 'issuetype', 'issueType'],
  ['key', 'issuekey', 'issue', 'issueKey'],
  ['created', 'createdDate'],
  ['updated', 'updatedDate'],
  ['due', 'duedate', 'dueDate'],
  ['resolved', 'resolutiondate', 'resolutionDate'],
  ['filter', 'filter', 'request', 'savedFilter', 'searchRequest'],
  ['workItemLink', 'issueLink'],
  ['workItemLinkType', 'issueLinkType'],
  ['parent', 'parent', 'Epic link'],
  ['changeGatingType', 'Change gating type'],
  ['labels', 'labels', 'label'],
  ['summary', 'summary', 'title'],
  // Same name in both vocabularies; listed so their case is normalised.
  ...[
    'affectedVersion',
    'approvals',
    'assignee',
    'reporter',
    'creator',
    'attachments',
    'category',
    'comment',
    'description',
    'environment',
    'component',
    'lastViewed',
    'fixVersion',
    'hierarchyLevel',
    'level',
    'organization',
    'requestType',
    'requestChannelType',
    'requestLastActivityTime',
    'originalEstimate',
    'remainingEstimate',
    'timeSpent',
    'workRatio',
    'priority',
    'resolution',
    'status',
    'statusCategory',
    'sprint',
    'text',
    'voter',
    'votes',
    'watcher',
    'watchers',
    'worklogComment',
    'worklogDate',
  ].map((name) => [name, name] as const),
];

/** Native function name and its Jira-compatible name. */
export const FUNCTION_NAMES: readonly (readonly [native: string, jira: string])[] = [
  ['spacesLeadByUser', 'projectsLeadByUser'],
  ['spacesWhereUserHasPermission', 'projectsWhereUserHasPermission'],
  ['spacesWhereUserHasRole', 'projectsWhereUserHasRole'],
  ['linkedWorkItems', 'linkedIssues'],
  ['workItemHistory', 'issueHistory'],
  ['workItemsWithRemoteLinksByGlobalId', 'issuesWithRemoteLinksByGlobalId'],
  ['votedWorkItems', 'votedIssues'],
  ['watchedWorkItems', 'watchedIssues'],
  ['standardWorkTypes', 'standardIssueTypes'],
  ['subtaskWorkTypes', 'subTaskIssueTypes'],
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
    'releasedVersions',
    'unreleasedVersions',
    'latestReleasedVersion',
    'earliestUnreleasedVersion',
    'componentsLeadByUser',
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
    'organizationDetail',
    'organizationMembers',
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
  FUNCTION_NAMES.flatMap(([native, jira]) => [
    [lower(native), native],
    [lower(jira), native],
  ]),
);
const TO_JIRA_FUNCTIONS: Names = new Map(
  FUNCTION_NAMES.flatMap(([native, jira]) => [
    [lower(native), jira],
    [lower(jira), jira],
  ]),
);

/** Rewrites a query in either vocabulary to Tracksmith's names. Spans are kept. */
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
