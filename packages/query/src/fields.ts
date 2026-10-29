/**
 * What a query can refer to (M1-036; QRY-002, QRY-003; spec 01b sections 1.2 and 1.5): every
 * system field under its native name, its Jira-compatible names and its display name, and the
 * custom fields of a workspace by name or by `cf[id]`. Names match without regard to case. Each
 * field has a type, and the type decides which operators it takes (`OPERATORS_BY_TYPE`).
 *
 * `column` and `history` describe where the compiler (M1-037) finds values: `column` on the
 * ticket table for the fields the M0 compiler spike reads, `history` the field's name in the
 * change history, which records every field (Taskmoor keeps history for all of them).
 */
export type SystemType =
  | 'key'
  | 'number'
  | 'text'
  | 'datetime'
  | 'date'
  | 'user'
  | 'labels'
  | 'track'
  | 'status'
  | 'stage'
  | 'priority'
  | 'ticketType'
  | 'release'
  | 'area'
  | 'option'
  | 'sprint'
  | 'attachments'
  | 'savedSearch';

export type CustomType =
  | 'text'
  | 'number'
  | 'date'
  | 'datetime'
  | 'user'
  | 'group'
  | 'option'
  | 'multi'
  | 'cascade'
  | 'labels'
  | 'release'
  | 'area';

export type FieldType = SystemType | CustomType;

export interface SystemField {
  kind: 'system';
  name: string;
  aliases: readonly string[];
  type: SystemType;
  /** Column on the ticket table, for the fields the compiler spike reads. */
  column?: string;
  /** Name in the change history for WAS and CHANGED; null for a field without history. */
  history?: string | null;
  /** The value may be empty (sorting then puts empties last). */
  nullable?: boolean;
  /** ORDER BY may use it (section 1.7). */
  sortable?: boolean;
  /** A field of a module not built yet: it resolves, the compiler names the module. */
  module?: 'agile' | 'service' | 'journeys' | 'saved-searches';
}

export interface CustomField {
  kind: 'custom';
  id: number;
  name: string;
  type: CustomType;
}

export type Field = SystemField | CustomField;

export interface Catalogue {
  systems: readonly SystemField[];
  customs: readonly CustomField[];
  /** Track key to ID, so `track = ABC` (Jira: `project = ABC`) becomes a number. */
  trackKeys: Readonly<Record<string, number>>;
}

/** Operators, grouped as section 1.2 groups them. */
export type OperatorFamily = 'equality' | 'list' | 'order' | 'contains' | 'empty' | 'history';

const ALL: readonly OperatorFamily[] = ['equality', 'list', 'empty', 'history'];
const ORDERED: readonly OperatorFamily[] = [...ALL, 'order'];

/**
 * Which operators each type takes (QRY-002): ordering comparisons for numbers, dates, releases
 * and priorities; `~` and `!~` for text, which takes no equality or list operators (Jira
 * matches text by words, not whole values); attachments only `IS [NOT] EMPTY`; emptiness and
 * the history operators everywhere else.
 */
export const OPERATORS_BY_TYPE: Readonly<Record<FieldType, readonly OperatorFamily[]>> = {
  key: ALL,
  number: ORDERED,
  text: ['contains', 'empty', 'history'],
  datetime: ORDERED,
  date: ORDERED,
  user: ALL,
  group: ALL,
  labels: ALL,
  track: ALL,
  status: ALL,
  stage: ALL,
  priority: ORDERED,
  ticketType: ALL,
  release: ORDERED,
  area: ALL,
  option: ALL,
  multi: ALL,
  cascade: ALL,
  sprint: ALL,
  attachments: ['empty'],
  savedSearch: ALL,
};

export const takes = (field: Field, family: OperatorFamily): boolean =>
  OPERATORS_BY_TYPE[field.type].includes(family) &&
  (family !== 'history' || field.kind === 'custom' || field.history !== null);

type Def = Omit<SystemField, 'kind' | 'aliases'> & { aliases?: readonly string[] };
const system = (d: Def): SystemField => ({
  kind: 'system',
  history: d.name,
  ...d,
  aliases: d.aliases ?? [],
});

/** Section 1.5, with each field's type; display names are quoted in queries. */
export const SYSTEM_FIELDS: readonly SystemField[] = [
  system({ name: 'id', type: 'number', column: 'id', history: null, sortable: true }),
  system({
    name: 'key',
    aliases: ['issuekey', 'issue', 'issueKey'],
    type: 'key',
    column: 'key',
    sortable: true,
  }),
  system({ name: 'track', aliases: ['project', 'space'], type: 'track', column: 'space_id' }),
  system({
    name: 'parentTrack',
    aliases: ['parentProject', 'parentSpace', 'Parent track'],
    type: 'track',
  }),
  system({ name: 'trackCategory', aliases: ['category', 'Track category'], type: 'option' }),
  system({
    name: 'trackType',
    aliases: ['projectType', 'spaceType', 'Track type'],
    type: 'option',
  }),
  system({
    name: 'type',
    aliases: ['issuetype', 'issueType', 'Ticket type'],
    type: 'ticketType',
    column: 'type',
    sortable: true,
  }),
  system({ name: 'hierarchyLevel', aliases: ['Hierarchy level'], type: 'number', sortable: true }),
  system({ name: 'status', type: 'status', column: 'status', sortable: true }),
  system({
    name: 'stage',
    aliases: ['statusCategory'],
    type: 'stage',
    column: 'status_category',
  }),
  system({
    name: 'priority',
    type: 'priority',
    column: 'priority',
    sortable: true,
    nullable: true,
  }),
  system({
    name: 'closeReason',
    aliases: ['resolution', 'Close reason'],
    type: 'option',
    nullable: true,
    sortable: true,
  }),
  system({ name: 'summary', aliases: ['title'], type: 'text', column: 'summary', sortable: true }),
  system({ name: 'description', type: 'text', column: 'description', nullable: true }),
  system({ name: 'environment', type: 'text', nullable: true }),
  system({ name: 'comment', type: 'text', history: null }),
  // The master text field: summary, description, environment, comments, text custom fields.
  system({ name: 'text', type: 'text', history: null }),
  system({
    name: 'assignee',
    type: 'user',
    column: 'assignee_id',
    nullable: true,
    sortable: true,
  }),
  system({
    name: 'requester',
    aliases: ['reporter'],
    type: 'user',
    column: 'reporter_id',
    sortable: true,
  }),
  system({ name: 'creator', type: 'user', sortable: true }),
  system({ name: 'follower', aliases: ['watcher'], type: 'user', history: null }),
  system({ name: 'voter', type: 'user', history: null }),
  system({
    name: 'followers',
    aliases: ['watchers'],
    type: 'number',
    history: null,
    sortable: true,
  }),
  system({ name: 'votes', type: 'number', history: null, sortable: true }),
  system({ name: 'labels', aliases: ['label'], type: 'labels', column: 'labels' }),
  system({ name: 'area', aliases: ['component'], type: 'area', sortable: true }),
  system({
    name: 'targetRelease',
    aliases: ['fixVersion', 'Target release'],
    type: 'release',
    sortable: true,
  }),
  system({
    name: 'foundInRelease',
    aliases: ['affectedVersion', 'Found in release'],
    type: 'release',
    sortable: true,
  }),
  system({
    name: 'parent',
    aliases: ['Epic link'],
    type: 'key',
    column: 'parent_id',
    nullable: true,
  }),
  system({
    name: 'created',
    aliases: ['createdDate'],
    type: 'datetime',
    column: 'created_at',
    sortable: true,
  }),
  system({
    name: 'updated',
    aliases: ['updatedDate'],
    type: 'datetime',
    column: 'updated_at',
    sortable: true,
  }),
  system({
    name: 'due',
    aliases: ['dueDate', 'Due date'],
    type: 'date',
    history: 'dueDate',
    nullable: true,
    sortable: true,
  }),
  system({
    name: 'start',
    aliases: ['startDate', 'Start date'],
    type: 'date',
    history: 'startDate',
    nullable: true,
    sortable: true,
  }),
  system({
    name: 'closed',
    aliases: ['resolutionDate', 'resolved'],
    type: 'datetime',
    column: 'resolved_at',
    nullable: true,
    sortable: true,
  }),
  system({
    name: 'lastViewed',
    aliases: ['Last viewed'],
    type: 'datetime',
    history: null,
    sortable: true,
  }),
  system({ name: 'attachments', type: 'attachments', history: null }),
  system({
    name: 'savedSearch',
    aliases: ['filter', 'request', 'savedFilter', 'searchRequest', 'Saved search'],
    type: 'savedSearch',
    module: 'saved-searches',
  }),
  system({ name: 'sprint', type: 'sprint', sortable: true }),
  system({
    name: 'visibilityLevel',
    aliases: ['level', 'Visibility level'],
    type: 'option',
  }),
  system({
    name: 'originalEstimate',
    aliases: ['Original estimate'],
    type: 'number',
    nullable: true,
    sortable: true,
  }),
  system({
    name: 'remainingEstimate',
    aliases: ['Remaining estimate'],
    type: 'number',
    nullable: true,
    sortable: true,
  }),
  system({ name: 'timeSpent', aliases: ['Time spent'], type: 'number', sortable: true }),
  system({
    name: 'effortRatio',
    aliases: ['workRatio', 'Effort ratio'],
    type: 'number',
    history: null,
    nullable: true,
    sortable: true,
  }),
  system({
    name: 'ticketLink',
    aliases: ['issueLink', 'workItemLink', 'Ticket link'],
    type: 'key',
    history: 'link',
  }),
  system({
    name: 'ticketLinkType',
    aliases: ['issueLinkType', 'workItemLinkType', 'Ticket link type'],
    type: 'option',
    history: 'link',
  }),
  system({
    name: 'timeEntryComment',
    aliases: ['worklogComment', 'Time entry comment'],
    type: 'text',
    history: null,
  }),
  system({
    name: 'timeEntryDate',
    aliases: ['worklogDate', 'Time entry date'],
    type: 'date',
    history: null,
  }),
  system({ name: 'approvals', type: 'option', module: 'service' }),
  system({
    name: 'changeGatingType',
    aliases: ['Change gating type'],
    type: 'option',
    module: 'service',
  }),
  system({ name: 'customerGroup', aliases: ['organization'], type: 'option', module: 'service' }),
  system({ name: 'requestForm', aliases: ['requestType'], type: 'option', module: 'service' }),
  system({
    name: 'requestChannel',
    aliases: ['requestChannelType'],
    type: 'option',
    module: 'service',
  }),
  system({
    name: 'requestLastActivity',
    aliases: ['requestLastActivityTime'],
    type: 'datetime',
    module: 'service',
  }),
  system({ name: 'journey', type: 'option', module: 'journeys' }),
  system({ name: 'journeyParent', type: 'key', module: 'journeys' }),
  system({ name: 'journeyType', type: 'option', module: 'journeys' }),
  system({ name: 'journeyTypeVersion', type: 'option', module: 'journeys' }),
  system({ name: 'journeyTicket', aliases: ['journeyWorkItem'], type: 'key', module: 'journeys' }),
];

export function makeCatalogue(
  customs: readonly CustomField[] = [],
  trackKeys: Readonly<Record<string, number>> = {},
): Catalogue {
  return { systems: SYSTEM_FIELDS, customs, trackKeys };
}

export type FieldLookup =
  | { field: Field }
  | { ambiguous: readonly CustomField[] }
  | { missing: true };

/**
 * Finds a field by name or alias (any case) or by custom field id. System fields win over
 * custom fields of the same name; two custom fields of one name are ambiguous, and the caller
 * names their ids (QRY-003 (2)).
 */
export function findField(
  catalogue: Catalogue,
  ref: { name: string; custom?: number },
): FieldLookup {
  if (ref.custom !== undefined) {
    const custom = catalogue.customs.find((f) => f.id === ref.custom);
    return custom ? { field: custom } : { missing: true };
  }
  const wanted = ref.name.toLowerCase();
  const system = catalogue.systems.find(
    (f) => f.name.toLowerCase() === wanted || f.aliases.some((a) => a.toLowerCase() === wanted),
  );
  if (system) return { field: system };
  const customs = catalogue.customs.filter((f) => f.name.toLowerCase() === wanted);
  if (customs.length === 1) return { field: customs[0] as CustomField };
  if (customs.length > 1) return { ambiguous: customs };
  return { missing: true };
}

/** A field by name, alias or id; undefined when none or several match. */
export function lookupField(
  catalogue: Catalogue,
  ref: { name: string; custom?: number },
): Field | undefined {
  const found = findField(catalogue, ref);
  return 'field' in found ? found.field : undefined;
}
