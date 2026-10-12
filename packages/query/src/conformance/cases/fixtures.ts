import { type Catalogue, makeCatalogue } from '../../fields';
import type { QueryCase, Section } from '../case';

/**
 * The catalogue the suite resolves against: the system fields plus a handful of custom fields
 * and two spaces, all synthetic.
 */
export const CATALOGUE: Catalogue = makeCatalogue(
  [
    { kind: 'custom', id: 10016, name: 'Story Points', type: 'number' },
    { kind: 'custom', id: 10020, name: 'Team', type: 'option' },
    { kind: 'custom', id: 10021, name: 'Platforms', type: 'multi' },
    { kind: 'custom', id: 10022, name: 'Target date', type: 'date' },
    { kind: 'custom', id: 10023, name: 'Approver', type: 'user' },
    { kind: 'custom', id: 10024, name: 'Notes', type: 'text' },
    { kind: 'custom', id: 10025, name: 'Tags', type: 'labels' },
  ],
  { ABC: 1, WEB: 2 },
);

/** Value types a field can have, as the operator rules of section 1.2 see them. */
export type ValueType =
  | 'text'
  | 'number'
  | 'date'
  | 'user'
  | 'option'
  | 'multi'
  | 'labels'
  | 'release'
  | 'priority'
  | 'status'
  | 'key'
  | 'track'
  | 'type'
  | 'sprint'
  | 'attachments'
  | 'area'
  | 'savedSearch';

export interface SpecField {
  canonical: string;
  /** Names that must also resolve to the same field (section 1.5). */
  aliases: string[];
  type: ValueType;
  /** A value in canonical query syntax that fits the type. */
  sample: string;
  /** True when the field is sortable (section 1.7: any sortable field). */
  sortable?: boolean;
  /** True when the field is in this package's catalogue today. */
  known?: boolean;
  note?: string;
}

/** Section 1.5, restated: canonical identifier, accepted aliases, type and a sample value. */
export const FIELDS: readonly SpecField[] = [
  {
    canonical: 'foundInRelease',
    aliases: ['affectedVersion'],
    type: 'release',
    sample: '"1.0"',
    sortable: true,
  },
  {
    canonical: 'approvals',
    aliases: [],
    type: 'option',
    sample: 'approved()',
    note: 'service spaces',
  },
  {
    canonical: 'assignee',
    aliases: [],
    type: 'user',
    sample: 'currentUser()',
    sortable: true,
    known: true,
  },
  {
    canonical: 'requester',
    aliases: ['reporter'],
    type: 'user',
    sample: 'currentUser()',
    sortable: true,
    known: true,
  },
  { canonical: 'creator', aliases: [], type: 'user', sample: 'currentUser()', sortable: true },
  { canonical: 'attachments', aliases: [], type: 'attachments', sample: 'EMPTY' },
  { canonical: 'trackCategory', aliases: ['category'], type: 'option', sample: '"Internal"' },
  {
    canonical: 'changeGatingType',
    aliases: ['"Change gating type"'],
    type: 'option',
    sample: '"Change manager"',
  },
  { canonical: 'comment', aliases: [], type: 'text', sample: '"login"' },
  { canonical: 'description', aliases: [], type: 'text', sample: '"login"', known: true },
  { canonical: 'environment', aliases: [], type: 'text', sample: '"staging"' },
  {
    canonical: 'summary',
    aliases: ['title'],
    type: 'text',
    sample: '"login"',
    sortable: true,
    known: true,
  },
  { canonical: 'area', aliases: ['component'], type: 'area', sample: '"API"', sortable: true },
  {
    canonical: 'created',
    aliases: ['createdDate'],
    type: 'date',
    sample: '-1w',
    sortable: true,
    known: true,
  },
  {
    canonical: 'updated',
    aliases: ['updatedDate'],
    type: 'date',
    sample: '-1w',
    sortable: true,
    known: true,
  },
  { canonical: 'due', aliases: ['dueDate'], type: 'date', sample: '2026-12-31', sortable: true },
  {
    canonical: 'closed',
    aliases: ['resolved', 'resolutionDate'],
    type: 'date',
    sample: '-1w',
    sortable: true,
    known: true,
  },
  { canonical: 'lastViewed', aliases: [], type: 'date', sample: '-1d', sortable: true },
  { canonical: 'parent', aliases: ['"Epic link"'], type: 'key', sample: 'ABC-1', known: true },
  {
    canonical: 'savedSearch',
    aliases: ['filter', 'request', 'savedFilter', 'searchRequest'],
    type: 'savedSearch',
    sample: '10001',
  },
  {
    canonical: 'targetRelease',
    aliases: ['fixVersion'],
    type: 'release',
    sample: '"2.0"',
    sortable: true,
  },
  { canonical: 'hierarchyLevel', aliases: [], type: 'number', sample: '1', sortable: true },
  {
    canonical: 'labels',
    aliases: ['label'],
    type: 'labels',
    sample: 'backend',
    sortable: true,
    known: true,
  },
  {
    canonical: 'visibilityLevel',
    aliases: ['level'],
    type: 'option',
    sample: '"Internal"',
    sortable: true,
  },
  { canonical: 'customerGroup', aliases: ['organization'], type: 'option', sample: '"Acme"' },
  { canonical: 'requestForm', aliases: ['requestType'], type: 'option', sample: '"Bug report"' },
  { canonical: 'requestChannel', aliases: ['requestChannelType'], type: 'option', sample: 'email' },
  {
    canonical: 'requestLastActivity',
    aliases: ['requestLastActivityTime'],
    type: 'date',
    sample: '-1d',
    sortable: true,
  },
  { canonical: 'originalEstimate', aliases: [], type: 'number', sample: '3600', sortable: true },
  { canonical: 'remainingEstimate', aliases: [], type: 'number', sample: '1800', sortable: true },
  { canonical: 'timeSpent', aliases: [], type: 'number', sample: '600', sortable: true },
  {
    canonical: 'effortRatio',
    aliases: ['workRatio'],
    type: 'number',
    sample: '50',
    sortable: true,
  },
  {
    canonical: 'track',
    aliases: ['project', 'space'],
    type: 'track',
    sample: 'ABC',
    sortable: true,
    known: true,
  },
  {
    canonical: 'parentTrack',
    aliases: ['parentProject', 'parentSpace'],
    type: 'track',
    sample: 'ABC',
  },
  {
    canonical: 'trackType',
    aliases: ['projectType', 'spaceType'],
    type: 'option',
    sample: 'software',
  },
  {
    canonical: 'priority',
    aliases: [],
    type: 'priority',
    sample: 'High',
    sortable: true,
    known: true,
  },
  {
    canonical: 'closeReason',
    aliases: ['resolution'],
    type: 'option',
    sample: 'Done',
    sortable: true,
  },
  {
    canonical: 'status',
    aliases: [],
    type: 'status',
    sample: '"In Progress"',
    sortable: true,
    known: true,
  },
  {
    canonical: 'stage',
    aliases: ['statusCategory'],
    type: 'status',
    sample: 'Done',
    sortable: true,
    known: true,
  },
  { canonical: 'sprint', aliases: [], type: 'sprint', sample: '42', sortable: true },
  { canonical: 'text', aliases: [], type: 'text', sample: '"login"' },
  {
    canonical: 'type',
    aliases: ['issuetype', 'issueType'],
    type: 'type',
    sample: 'Bug',
    sortable: true,
    known: true,
  },
  {
    canonical: 'key',
    aliases: ['issue', 'issueKey'],
    type: 'key',
    sample: 'ABC-12',
    sortable: true,
    known: true,
  },
  { canonical: 'voter', aliases: [], type: 'user', sample: 'currentUser()' },
  { canonical: 'votes', aliases: [], type: 'number', sample: '3', sortable: true },
  { canonical: 'follower', aliases: ['watcher'], type: 'user', sample: 'currentUser()' },
  { canonical: 'followers', aliases: ['watchers'], type: 'number', sample: '3', sortable: true },
  {
    canonical: 'ticketLink',
    aliases: ['issueLink', 'workItemLink'],
    type: 'key',
    sample: 'ABC-12',
  },
  {
    canonical: 'ticketLinkType',
    aliases: ['issueLinkType', 'workItemLinkType'],
    type: 'option',
    sample: 'blocks',
  },
  { canonical: 'timeEntryComment', aliases: ['worklogComment'], type: 'text', sample: '"paired"' },
  { canonical: 'timeEntryDate', aliases: ['worklogDate'], type: 'date', sample: '-1w' },
];

/** The custom fields of the catalogue, by name and by id (section 1.1 and 1.5). */
export const CUSTOM_FIELDS: readonly SpecField[] = [
  {
    canonical: '"Story Points"',
    aliases: ['cf[10016]'],
    type: 'number',
    sample: '8',
    sortable: true,
    known: true,
  },
  {
    canonical: 'Team',
    aliases: ['cf[10020]'],
    type: 'option',
    sample: 'Platform',
    sortable: true,
    known: true,
  },
  { canonical: 'Platforms', aliases: ['cf[10021]'], type: 'multi', sample: 'ios', known: true },
  {
    canonical: '"Target date"',
    aliases: ['cf[10022]'],
    type: 'date',
    sample: '2026-12-31',
    sortable: true,
    known: true,
  },
  {
    canonical: 'Approver',
    aliases: ['cf[10023]'],
    type: 'user',
    sample: 'currentUser()',
    known: true,
  },
  { canonical: 'Notes', aliases: ['cf[10024]'], type: 'text', sample: '"draft"', known: true },
  { canonical: 'Tags', aliases: ['cf[10025]'], type: 'labels', sample: 'urgent', known: true },
];

export type Operator =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'IN'
  | 'NOT IN'
  | '~'
  | '!~'
  | 'IS'
  | 'IS NOT'
  | 'WAS'
  | 'WAS NOT'
  | 'WAS IN'
  | 'WAS NOT IN'
  | 'CHANGED';

export const OPERATORS: readonly Operator[] = [
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'IN',
  'NOT IN',
  '~',
  '!~',
  'IS',
  'IS NOT',
  'WAS',
  'WAS NOT',
  'WAS IN',
  'WAS NOT IN',
  'CHANGED',
];

const ORDERED: ReadonlySet<ValueType> = new Set(['number', 'date', 'release', 'priority']);
const TEXT: ReadonlySet<ValueType> = new Set(['text']);

/**
 * Which operators a value type accepts (section 1.2 restated with the field notes of 1.5):
 * ordering comparisons for numbers, dates, versions and priorities; `~` and `!~` for text, which
 * takes no equality or list operators; attachments only IS and IS NOT; history operators on
 * every field (Taskmoor exceeds Jira's six).
 */
export function operatorAllowed(op: Operator, type: ValueType): boolean {
  if (type === 'attachments') return op === 'IS' || op === 'IS NOT';
  if (op === 'IS' || op === 'IS NOT') return true;
  if (op === '~' || op === '!~') return TEXT.has(type);
  if (TEXT.has(type))
    return (
      op === 'WAS' || op === 'WAS NOT' || op === 'WAS IN' || op === 'WAS NOT IN' || op === 'CHANGED'
    );
  if (op === '>' || op === '>=' || op === '<' || op === '<=') return ORDERED.has(type);
  return true;
}

export interface SpecFunction {
  name: string;
  legacy?: string;
  /** Minimum and maximum argument counts. */
  args: [number, number];
  /** Sample arguments in canonical syntax. */
  sample: string[];
  /** The clause shape the function is used in: `assignee = currentUser()` or `sprint IN openSprints()`. */
  usage: { field: string; op: '=' | 'IN' | '>=' };
  /** True when this package resolves it today. */
  known?: boolean;
}

/** Section 1.6, restated. */
export const FUNCTIONS: readonly SpecFunction[] = [
  {
    name: 'currentUser',
    args: [0, 0],
    sample: [],
    usage: { field: 'assignee', op: '=' },
    known: true,
  },
  {
    name: 'membersOf',
    args: [1, 1],
    sample: ['"developers"'],
    usage: { field: 'assignee', op: 'IN' },
  },
  { name: 'now', args: [0, 0], sample: [], usage: { field: 'created', op: '>=' }, known: true },
  { name: 'currentLogin', args: [0, 0], sample: [], usage: { field: 'updated', op: '>=' } },
  { name: 'lastLogin', args: [0, 0], sample: [], usage: { field: 'updated', op: '>=' } },
  {
    name: 'startOfDay',
    args: [0, 1],
    sample: ['-1d'],
    usage: { field: 'created', op: '>=' },
    known: true,
  },
  {
    name: 'startOfWeek',
    args: [0, 1],
    sample: ['-1w'],
    usage: { field: 'created', op: '>=' },
    known: true,
  },
  {
    name: 'startOfMonth',
    args: [0, 1],
    sample: ['-1M'],
    usage: { field: 'created', op: '>=' },
    known: true,
  },
  {
    name: 'startOfYear',
    args: [0, 1],
    sample: ['-1y'],
    usage: { field: 'created', op: '>=' },
    known: true,
  },
  {
    name: 'endOfDay',
    args: [0, 1],
    sample: ['1d'],
    usage: { field: 'created', op: '>=' },
    known: true,
  },
  {
    name: 'endOfWeek',
    args: [0, 1],
    sample: ['1w'],
    usage: { field: 'created', op: '>=' },
    known: true,
  },
  {
    name: 'endOfMonth',
    args: [0, 1],
    sample: ['1M'],
    usage: { field: 'created', op: '>=' },
    known: true,
  },
  {
    name: 'endOfYear',
    args: [0, 1],
    sample: ['1y'],
    usage: { field: 'created', op: '>=' },
    known: true,
  },
  { name: 'openSprints', args: [0, 0], sample: [], usage: { field: 'sprint', op: 'IN' } },
  { name: 'closedSprints', args: [0, 0], sample: [], usage: { field: 'sprint', op: 'IN' } },
  { name: 'futureSprints', args: [0, 0], sample: [], usage: { field: 'sprint', op: 'IN' } },
  {
    name: 'shippedReleases',
    legacy: 'releasedVersions',
    args: [0, 1],
    sample: ['ABC'],
    usage: { field: 'targetRelease', op: 'IN' },
  },
  {
    name: 'upcomingReleases',
    legacy: 'unreleasedVersions',
    args: [0, 1],
    sample: ['ABC'],
    usage: { field: 'targetRelease', op: 'IN' },
  },
  {
    name: 'latestShippedRelease',
    legacy: 'latestReleasedVersion',
    args: [1, 1],
    sample: ['ABC'],
    usage: { field: 'targetRelease', op: '=' },
  },
  {
    name: 'earliestUpcomingRelease',
    legacy: 'earliestUnreleasedVersion',
    args: [1, 1],
    sample: ['ABC'],
    usage: { field: 'targetRelease', op: '=' },
  },
  {
    name: 'areasOwnedByUser',
    legacy: 'componentsLeadByUser',
    args: [0, 1],
    sample: ['"alice"'],
    usage: { field: 'area', op: 'IN' },
  },
  {
    name: 'tracksOwnedByUser',
    legacy: 'projectsLeadByUser',
    args: [0, 1],
    sample: ['"alice"'],
    usage: { field: 'track', op: 'IN' },
  },
  {
    name: 'tracksWhereUserHasPermission',
    legacy: 'projectsWhereUserHasPermission',
    args: [1, 1],
    sample: ['"Browse"'],
    usage: { field: 'track', op: 'IN' },
  },
  {
    name: 'tracksWhereUserHasRole',
    legacy: 'projectsWhereUserHasRole',
    args: [1, 1],
    sample: ['"Developers"'],
    usage: { field: 'track', op: 'IN' },
  },
  {
    name: 'linkedTickets',
    legacy: 'linkedIssues',
    args: [1, 3],
    sample: ['ABC-12', '"blocks"'],
    usage: { field: 'key', op: 'IN' },
  },
  {
    name: 'ticketHistory',
    legacy: 'issueHistory',
    args: [0, 0],
    sample: [],
    usage: { field: 'key', op: 'IN' },
  },
  {
    name: 'ticketsWithWebLinksByGlobalId',
    legacy: 'issuesWithRemoteLinksByGlobalId',
    args: [1, 100],
    sample: ['"g1"', '"g2"'],
    usage: { field: 'key', op: 'IN' },
  },
  {
    name: 'votedTickets',
    legacy: 'votedIssues',
    args: [0, 0],
    sample: [],
    usage: { field: 'key', op: 'IN' },
  },
  {
    name: 'followedTickets',
    legacy: 'watchedIssues',
    args: [0, 0],
    sample: [],
    usage: { field: 'key', op: 'IN' },
  },
  {
    name: 'updatedBy',
    args: [1, 3],
    sample: ['"alice"', '-1w'],
    usage: { field: 'key', op: 'IN' },
  },
  {
    name: 'standardTicketTypes',
    legacy: 'standardIssueTypes',
    args: [0, 0],
    sample: [],
    usage: { field: 'type', op: 'IN' },
  },
  {
    name: 'subticketTypes',
    legacy: 'subTaskIssueTypes',
    args: [0, 0],
    sample: [],
    usage: { field: 'type', op: 'IN' },
  },
  {
    name: 'cascadeOption',
    args: [1, 2],
    sample: ['"Hardware"', '"Laptop"'],
    usage: { field: 'Team', op: 'IN' },
  },
  {
    name: 'choiceOption',
    args: [1, 50],
    sample: ['10100', '10101'],
    usage: { field: 'Team', op: 'IN' },
  },
  { name: 'approved', args: [0, 0], sample: [], usage: { field: 'approvals', op: '=' } },
  { name: 'approver', args: [1, 5], sample: ['"alice"'], usage: { field: 'approvals', op: '=' } },
  { name: 'breached', args: [0, 0], sample: [], usage: { field: '"Time to resolution"', op: '=' } },
  {
    name: 'completed',
    args: [0, 0],
    sample: [],
    usage: { field: '"Time to resolution"', op: '=' },
  },
  {
    name: 'customerDetail',
    args: [2, 2],
    sample: ['"Country"', '"Spain"'],
    usage: { field: 'requester', op: 'IN' },
  },
  {
    name: 'entitlementDetail',
    args: [2, 2],
    sample: ['"Tier"', '"Gold"'],
    usage: { field: 'customerGroup', op: 'IN' },
  },
  {
    name: 'entitlementProduct',
    args: [1, 1],
    sample: ['"Cloud"'],
    usage: { field: 'customerGroup', op: 'IN' },
  },
  {
    name: 'everBreached',
    args: [0, 0],
    sample: [],
    usage: { field: '"Time to resolution"', op: '=' },
  },
  { name: 'myApproval', args: [0, 0], sample: [], usage: { field: 'approvals', op: '=' } },
  { name: 'myPendingApproval', args: [0, 0], sample: [], usage: { field: 'approvals', op: '=' } },
  { name: 'myPending', args: [0, 0], sample: [], usage: { field: 'approvals', op: '=' } },
  {
    name: 'customerGroupDetail',
    legacy: 'organizationDetail',
    args: [2, 2],
    sample: ['"Region"', '"EU"'],
    usage: { field: 'customerGroup', op: 'IN' },
  },
  {
    name: 'customerGroupMembers',
    legacy: 'organizationMembers',
    args: [1, 1],
    sample: ['"Acme"'],
    usage: { field: 'requester', op: 'IN' },
  },
  { name: 'paused', args: [0, 0], sample: [], usage: { field: '"Time to resolution"', op: '=' } },
  { name: 'pending', args: [0, 0], sample: [], usage: { field: 'approvals', op: '=' } },
  {
    name: 'pendingApprovalBy',
    args: [1, 5],
    sample: ['"alice"'],
    usage: { field: 'approvals', op: '=' },
  },
  { name: 'pendingBy', args: [1, 5], sample: ['"alice"'], usage: { field: 'approvals', op: '=' } },
  {
    name: 'remaining',
    args: [1, 1],
    sample: ['"4h"'],
    usage: { field: '"Time to resolution"', op: '=' },
  },
  { name: 'running', args: [0, 0], sample: [], usage: { field: '"Time to resolution"', op: '=' } },
  {
    name: 'withinCalendarHours',
    args: [0, 0],
    sample: [],
    usage: { field: '"Time to resolution"', op: '=' },
  },
];

type Omitted = 'id' | 'requirement' | 'section' | 'spec';
type CaseBody = QueryCase extends infer C ? (C extends unknown ? Omit<C, Omitted> : never) : never;

/** Builds the cases of one section with a shared requirement and spec reference. */
export function section(requirement: QueryCase['requirement'], sectionName: Section, spec: string) {
  let n = 0;
  return (slug: string, body: CaseBody): QueryCase => {
    n++;
    return {
      ...body,
      id: `${requirement}-${slug}-${String(n).padStart(3, '0')}`,
      requirement,
      section: sectionName,
      spec,
    } as QueryCase;
  };
}

/** The field expression as it prints: quoted names stay quoted, `cf[n]` stays. */
export const fieldText = (name: string) => name;
