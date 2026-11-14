import type {
  AreaDefaultAssignee,
  DashboardLayout,
  Database,
  GranteeKind,
  JsonValue,
  NotificationRecipient,
  SavedSearchShareScope,
  TrackType,
} from '@taskmoor/db';
import type { Kysely } from 'kysely';
import type { WidgetKind } from '../dashboards/model';
import type { FieldType } from '../fields/types';

/**
 * The importer framework's model (M1-086; IMP-009, IMP-010, ADR-048). An import runs three
 * stages a batch at a time:
 *
 * - **extract**: a source (`ImportSource`) yields records of one entity kind after a cursor, a
 *   page at a time, in a stable order. Kinds run in dependency order (`ENTITY_KINDS`), so a
 *   ticket's track and people exist before it; kinds the framework has no loader for are counted
 *   as unsupported, never dropped silently.
 * - **map**: the source's mapper turns a record into a command of the target model, or says why
 *   it cannot (skipped or failed), with warnings for parts it leaves out. References to other
 *   records stay source references (`Ref`) until the load resolves them.
 * - **load**: the loader of the command's kind plans it (create, update, link to an existing
 *   object, or nothing changed) and, unless the run is a dry run, writes it.
 *
 * A source format brings its reader and mapper; the commands and loaders are shared, so the
 * backup reader, the Cloud REST reader, CSV (`csv.ts`) and Taskmoor's own export
 * (`taskmoor.ts`, M1-098) only extract and map.
 */

/**
 * The kinds the framework loads, in the order they run: each needs only kinds before it.
 * History runs last, since its entries name comments, time entries and attachments.
 */
export const ENTITY_KINDS = [
  'user',
  'group',
  'team',
  'role',
  'status',
  'priority',
  'close_reason',
  'ticket_type',
  'link_type',
  'track',
  'release',
  'area',
  'field',
  'field_context',
  'field_option',
  'field_rule_set',
  'layout_set',
  'access_policy',
  'visibility_policy',
  'visibility_level',
  'notification_policy',
  'global_grant',
  'workflow',
  'workflow_map',
  'board',
  'ticket',
  'sprint',
  'comment',
  'link',
  'web_link',
  'time_entry',
  'attachment',
  'checklist',
  'history',
  // Saved searches, their subscriptions and dashboards (M1-094): queries name everything above.
  'saved_search',
  'subscription',
  'dashboard',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export function isEntityKind(value: string): value is EntityKind {
  return (ENTITY_KINDS as readonly string[]).includes(value);
}

/** A reference to another source record by kind and source id. */
export interface Ref {
  kind: EntityKind;
  id: string;
}

/** A record as a source yields it: format-specific data under a kind and a source id. */
export interface SourceRecord {
  kind: string;
  id: string;
  data: Record<string, unknown>;
  /**
   * How people know the record in the source (a name, a key, an address), for the report's
   * mapping of configuration (M1-088); left out, the command's name stands in.
   */
  label?: string;
}

/** A record and the cursor that resumes after it. */
export interface SourceItem extends SourceRecord {
  cursor: string;
}

/**
 * Where an import reads from. `read` returns up to `limit` records of a kind after `after`
 * (null: from the start), in an order that never changes between calls, so a run can stop
 * after any page and resume from the last cursor it committed.
 */
export interface ImportSource {
  /** The importer, such as `synthetic`; part of every external id. */
  readonly importSource: string;
  /** The instance the data comes from, as the source identifies it. */
  readonly system: string;
  /** The kinds the source holds, framework kinds or not. */
  kinds(): Promise<string[]>;
  read(kind: string, after: string | null, limit: number): Promise<SourceItem[]>;
  /** The bytes of a file the source holds (attachments), by the locator a record gives. */
  openFile?(locator: string): Promise<NodeJS.ReadableStream>;
  /** The size of such a file, or null when the source has none by that locator. */
  fileSize?(locator: string): Promise<number | null>;
  /**
   * Records of a kind the framework has no loader for, counted without reading them, and why
   * the source leaves them out (M1-088). Null, or no such method: the run reads them a page at
   * a time to count them, under the reason `no_importer_for_kind`.
   */
  unsupported?(kind: string): Promise<{ count: number; reason: string } | null>;
  /**
   * What the source itself has to report, once per run: characters it removed while reading,
   * say (IMP-001 (2)). They join the report's warnings under the kind `source`.
   */
  notes?(): Promise<SourceNote[]>;
  /**
   * Work before the first batch (M1-095): a remote source fetches into its stage, committing as
   * it goes. 'more' when `until` passed first: the job's next part goes on from where it got to.
   */
  prepare?(until: number): Promise<'ready' | 'more'>;
  /**
   * How a delta run (M1-096) tells which records of a kind the source no longer holds:
   *
   * - `all`: the run reads every record of the kind the source has (a backup), so one an earlier
   *   run imported that this run did not read is gone;
   * - `listed`: the run reads only what changed, but the source stages the ids it still holds as
   *   `import_staged` rows of kind `listed:<kind>` (a Cloud site's ticket ids);
   * - `within_tickets`: the run reads every record of the kind under each ticket it reads (a
   *   changed ticket's comments), so one under those tickets it did not read is gone;
   * - null, or no such method: it cannot tell, and nothing of the kind is reported.
   */
  coverage?(kind: string): Promise<Coverage>;
}

/** What a source can say about records it no longer holds (`ImportSource.coverage`). */
export type Coverage = 'all' | 'listed' | 'within_tickets' | null;

/** What a format may need to open a source: the run it reads for and the database. */
export interface OpenContext {
  db: Kysely<Database>;
  runId: string;
  workspaceId: number;
}

/** Something left out or changed on the way, counted per kind, code and detail in the report. */
export interface Warning {
  code: string;
  /** A field name, a value or another detail that groups warnings of one code. */
  detail?: string;
}

/** A warning about the source as a whole, with its count and up to five places it concerns. */
export interface SourceNote extends Warning {
  count: number;
  examples: string[];
}

/** A status's place in the workflow stages (spec 01a). */
export type Stage = 'new' | 'active' | 'closed';

/** A history value: text (dates, numbers, labels) or a reference the load resolves to an id. */
export type HistoryValue =
  | { text: string | null; display: string | null }
  | { ref: Ref; display: string | null };

export interface UserCommand {
  kind: 'user';
  /** Null when the source hides it: the user becomes a placeholder (IMP-007). */
  email: string | null;
  name: string;
  /** Inactive and deleted source accounts become deactivated users, so attribution stays. */
  active: boolean;
  timeZone: string | null;
  locale?: string | null;
  /**
   * The person is one the target already has (M1-095): `existing`, found by `email`; `scim`, a
   * person provisioned over SCIM with that address. Never created or changed; when nobody is
   * found, a deactivated placeholder keeps the attribution and the record warns
   * `person_unmapped`.
   */
  link?: 'existing' | 'scim';
}

export interface GroupCommand {
  kind: 'group';
  name: string;
  description: string;
  members: Ref[];
}

/** A site team (M1-123): linked to the target's team of the same name, members added. */
export interface TeamCommand {
  kind: 'team';
  name: string;
  description: string;
  lead: Ref | null;
  members: Ref[];
}

/** A track role, linked to the target's role of the same name. */
export interface RoleCommand {
  kind: 'role';
  name: string;
  description: string;
}

export interface StatusCommand {
  kind: 'status';
  name: string;
  stage: Stage;
  description?: string;
  /** The target must have it (CSV names statuses): linked, never created. */
  mustExist?: boolean;
  /** A workflow of the same import names it, so a new status is not left out of workflows. */
  inWorkflow?: boolean;
}

/** Priorities and close reasons are linked by name, or added after the target's own. */
export interface PriorityCommand {
  kind: 'priority';
  name: string;
  description: string;
  icon: string | null;
  color: string | null;
}

export interface CloseReasonCommand {
  kind: 'close_reason';
  name: string;
  description: string;
}

export interface TicketTypeCommand {
  kind: 'ticket_type';
  name: string;
  description: string;
  level: 'standard' | 'subticket' | 'outcome';
  icon?: string | null;
  color?: string | null;
  /** The target must have it (CSV names types): linked, never created. */
  mustExist?: boolean;
}

/** A link type, linked by name. */
export interface LinkTypeCommand {
  kind: 'link_type';
  name: string;
  outward: string;
  inward: string;
}

export interface TrackCommand {
  kind: 'track';
  key: string;
  name: string;
  description: string;
  owner: Ref | null;
  trackType: TrackType;
  /**
   * `key`: the target's track of this key is the one meant (CSV rows name an existing track);
   * the record links to it and never changes it. Left out, a taken key fails the record.
   */
  match?: 'key';
  /** The last number the source gave out in the track: the counter starts past it. */
  lastNumber?: number;
  icon?: string | null;
  color?: string | null;
  /**
   * The people and groups that hold each role in the track (M1-088): added, never removed, so
   * actors given in Taskmoor stay.
   */
  roleActors?: { role: Ref; user: Ref | null; group: Ref | null }[];
  /**
   * Keys the track had in the source before a rename (M1-128): kept as earlier keys, so its
   * tickets open and queries find them by those keys too. A key another track holds stays
   * theirs, with a warning.
   */
  formerKeys?: string[];
}

/** A release of a track, linked by name within the track. */
export interface ReleaseCommand {
  kind: 'release';
  track: Ref;
  name: string;
  description: string;
  startDate: string | null;
  releaseDate: string | null;
  shippedAt: string | null;
  archivedAt: string | null;
}

/** An area of a track, linked by name within the track. */
export interface AreaCommand {
  kind: 'area';
  track: Ref;
  name: string;
  description: string;
  owner: Ref | null;
  /** The team that owns it (M1-123); left as the target has it when the source has none. */
  ownerTeam?: Ref | null;
  defaultAssignee: AreaDefaultAssignee;
  archivedAt: string | null;
}

/**
 * A custom field. `config` is as the source stores it: a formula's expression names fields by
 * source id (`{cf[12]}`), which the load maps. A track's own field names its track.
 */
export interface FieldCommand {
  kind: 'field';
  name: string;
  description: string;
  type: FieldType;
  multiple: boolean;
  config: Record<string, JsonValue>;
  track: Ref | null;
}

/** Where a field applies; the default value in stored form with source ids. */
export interface FieldContextCommand {
  kind: 'field_context';
  field: Ref;
  name: string;
  description: string;
  defaultValue: JsonValue | null;
  config: Record<string, JsonValue>;
  scopes: { track: Ref | null; type: Ref | null }[];
}

/** An option of a context; a cascading child names its parent. */
export interface FieldOptionCommand {
  kind: 'field_option';
  context: Ref;
  parent: Ref | null;
  value: string;
  sortOrder: number;
  disabled: boolean;
  /** Part of its context's default value (options are loaded after their contexts). */
  default?: boolean;
}

/** A field a rule or a layout names: a system field by its key, or a custom field. */
export type FormField = { key: string } | { custom: Ref };

/**
 * A field rule set (M1-089): required, hidden and help text per field, for every ticket type
 * (`type` null) or one, and the tracks that use it. Linked by name to the target's shared set
 * (whose rules then stay as they are), or created.
 */
export interface FieldRuleSetCommand {
  kind: 'field_rule_set';
  name: string;
  description: string;
  rules: {
    type: Ref | null;
    field: FormField;
    required: boolean;
    hidden: boolean;
    description: string | null;
  }[];
  tracks: Ref[];
}

/** A layout set (M1-089): per ticket type (or every type) and operation, tabs of fields. */
export interface LayoutSetCommand {
  kind: 'layout_set';
  name: string;
  description: string;
  layouts: {
    type: Ref | null;
    operation: 'create' | 'edit' | 'view';
    tabs: { name: string; fields: FormField[] }[];
    /** Whether fields the layout does not place appear after it. */
    others: 'show' | 'omit';
  }[];
  tracks: Ref[];
}

/** Who a grant or a visibility level names: the grantee and the one reference it needs. */
export interface GrantTo {
  grantee: GranteeKind;
  role: Ref | null;
  group: Ref | null;
  user: Ref | null;
  /** A user or group custom field. */
  field: Ref | null;
}

/**
 * An access policy (M1-092): track permissions per grantee, and the tracks that use it. Linked
 * by name to the target's shared policy (whose grants then stay as they are), or created.
 */
export interface AccessPolicyCommand {
  kind: 'access_policy';
  name: string;
  description: string;
  grants: { permission: string; to: GrantTo }[];
  tracks: Ref[];
}

/** A visibility policy and the tracks that use it; its levels follow as their own records. */
export interface VisibilityPolicyCommand {
  kind: 'visibility_policy';
  name: string;
  description: string;
  tracks: Ref[];
}

/** A visibility level of a policy, with who sees tickets at it. */
export interface VisibilityLevelCommand {
  kind: 'visibility_level';
  policy: Ref;
  name: string;
  description: string;
  position: number;
  /** The level a new ticket of the policy's tracks takes. */
  isDefault: boolean;
  members: GrantTo[];
}

/** A notification policy: who hears of each event, and the tracks that use it. */
export interface NotificationPolicyCommand {
  kind: 'notification_policy';
  name: string;
  description: string;
  rules: {
    event: string;
    recipient: NotificationRecipient;
    user: Ref | null;
    group: Ref | null;
    role: Ref | null;
    field: Ref | null;
  }[];
  tracks: Ref[];
}

/** A global permission for a group, or for everyone signed in (`group` null). */
export interface GlobalGrantCommand {
  kind: 'global_grant';
  permission: string;
  group: Ref | null;
}

/**
 * A workflow's published definition as the source stores it (statuses, groups, roles, people
 * and fields by source id), mapped on load. The default workflow links to the target's.
 */
export interface WorkflowCommand {
  kind: 'workflow';
  name: string;
  description: string;
  isDefault: boolean;
  definition: JsonValue;
}

/** Which workflow each ticket type uses, and the tracks that use the map. */
export interface WorkflowMapCommand {
  kind: 'workflow_map';
  name: string;
  description: string;
  isDefault: boolean;
  defaultWorkflow: Ref;
  entries: { type: Ref; workflow: Ref }[];
  tracks: Ref[];
}

/**
 * A board of a track (M1-095): its query (null: the track's tickets), and its columns with the
 * statuses each holds. Linked by name within its track, or created; a re-run updates it.
 */
export interface BoardCommand {
  kind: 'board';
  name: string;
  description: string;
  boardKind: 'scrum' | 'kanban';
  track: Ref;
  query: string | null;
  columns: { name: string; statuses: Ref[]; min: number | null; max: number | null }[];
  /** A sub-filter narrowing the query (M1-093: a Kanban board's sub-query). */
  subQuery?: string | null;
  /**
   * Board filters (M1-093: quick filters); left out, a new board takes the defaults and an
   * update keeps its own. Each query is checked against the target and left out with a warning
   * when it does not resolve there.
   */
  boardFilters?: { name: string; query: string; description: string }[];
  /**
   * The custom fields the queries name as `cf[<source id>]`: the loader writes the target's
   * ids in their place (M1-093).
   */
  fields?: Ref[];
  /**
   * Names the queries use that several custom fields of the source have (in lower case), with
   * those fields (T-195): the loader names a name by the one field here they all became, and
   * leaves out a query that names it when they became different fields. `oneShape` says whether
   * the fields have one type and multiplicity, which is what makes them one field (a field joins
   * one of its name and shape), so a dry run, which makes none, can tell; absent when the source
   * does not say.
   */
  sharedNames?: { name: string; fields: Ref[]; oneShape?: boolean }[];
}

/**
 * A sprint of a board (M1-095), with its dates and the tickets in it. A closed sprint's tickets
 * stay in its history; a ticket is in one open sprint at most, so a second open one is left out
 * with a warning.
 */
export interface SprintCommand {
  kind: 'sprint';
  board: Ref;
  name: string;
  goal: string;
  state: 'future' | 'active' | 'closed';
  startAt: string | null;
  endAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  tickets: Ref[];
}

/** A custom value given as cell text (CSV), read against a target field by its id. */
export interface CustomText {
  fieldId: number;
  /** The cells (a column may repeat); a field with several values splits them on `separator`. */
  texts: string[];
  separator: string;
}

export interface TicketCommand {
  kind: 'ticket';
  track: Ref;
  /**
   * The source number, kept so keys survive the move (IMP-011); null takes the track's next
   * number (CSV rows without a key).
   */
  number: number | null;
  /** Null: the track's default type (CSV rows without a type). */
  type: Ref | null;
  status: Ref | null;
  summary: string;
  /** Markdown; converted to the canonical document on load. */
  description: string | null;
  assignee: Ref | null;
  requester: Ref | null;
  creator: Ref | null;
  parent: Ref | null;
  /** A priority by name. */
  priority: string | null;
  labels: string[];
  startDate: string | null;
  dueDate: string | null;
  /** Null: the time of the import (a CSV without the column). */
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  originalEstimate: number | null;
  remainingEstimate: number | null;
  /**
   * Rich text as stored (ProseMirror documents, mentions by source id), instead of the
   * Markdown of `description`: Taskmoor's own export.
   */
  docs?: { description: JsonValue | null; environment: JsonValue | null };
  closeReason?: Ref | null;
  /** The priority by reference, instead of by name (`priority`). */
  priorityRef?: Ref | null;
  /** A ticket in the source's trash: it stays in the target's. */
  trash?: { deletedAt: string; deletedBy: Ref | null; trashedWith: Ref | null } | null;
  /** The ticket's visibility level (M1-092); left out, an update keeps the current one. */
  visibilityLevel?: Ref | null;
  /** The source's rank key, kept when the target has no ticket at it. */
  rank?: string;
  /** Seconds; a verbatim import keeps it instead of summing time entries. */
  timeSpent?: number;
  /** Custom values in stored form, keyed by source field id, references by source id. */
  fields?: Record<string, JsonValue>;
  /** Custom values as text (CSV), read against the target's fields. */
  customTexts?: CustomText[];
  releases?: { target: Ref[]; found: Ref[] };
  areas?: Ref[];
  followers?: Ref[];
  voters?: Ref[];
  /** A parent named by key, for a parent the source does not hold (CSV). */
  parentKey?: string | null;
  /**
   * Keys the ticket had before it moved between tracks (M1-091): each keeps resolving to it
   * (CORE-023 (3)), left at `at` (null: when the ticket was created).
   */
  formerKeys?: { track: Ref; number: number; at: string | null }[];
  /**
   * `key`: a ticket the target already has at this track and number is the one meant, and the
   * record updates it (CSV create-or-update by key, IMP-012).
   */
  match?: 'key';
  /** Properties an update leaves as they are: columns a CSV does not map. */
  keep?: readonly TicketProperty[];
}

/** The properties of a ticket command an update may keep. */
export const TICKET_PROPERTIES = [
  'type',
  'status',
  'summary',
  'description',
  'assignee',
  'requester',
  'creator',
  'parent',
  'priority',
  'labels',
  'startDate',
  'dueDate',
  'createdAt',
  'updatedAt',
  'closedAt',
  'originalEstimate',
  'remainingEstimate',
  'targetReleases',
  'foundReleases',
  'areas',
  'fields',
] as const;
export type TicketProperty = (typeof TICKET_PROPERTIES)[number];

export interface CommentCommand {
  kind: 'comment';
  ticket: Ref;
  author: Ref | null;
  /** Markdown. */
  body: string;
  visibleGroup: Ref | null;
  createdAt: string;
  updatedAt: string;
  /** The body as stored (mentions by source id), instead of the Markdown. */
  doc?: JsonValue;
  visibleRole?: Ref | null;
  editedAt?: string | null;
  editedBy?: Ref | null;
  /** A deleted comment stays deleted (history names it). */
  deletedAt?: string | null;
  deletedBy?: Ref | null;
}

export interface LinkCommand {
  kind: 'link';
  source: Ref;
  target: Ref;
  /** A link type by name, created with these phrases when the target has none of that name. */
  linkType: { name: string; outward: string; inward: string };
  /** Null when the source does not say: the later of the two tickets' creation (M1-091). */
  createdAt: string | null;
  creator: Ref | null;
}

/** A link from a ticket to a page outside (M1-091), as `ticket_web_link` holds it. */
export interface WebLinkCommand {
  kind: 'web_link';
  ticket: Ref;
  url: string;
  title: string;
  summary: string;
  iconUrl: string | null;
  relationship: string;
  /** The linked object's id in its own system, which integrations find their links by. */
  globalId: string | null;
  createdAt: string | null;
  creator: Ref | null;
}

/** A ticket's checklist with its items, as Taskmoor's own export holds it (CORE-033). */
export interface ChecklistCommand {
  kind: 'checklist';
  ticket: Ref;
  name: string;
  position: number;
  creator: Ref | null;
  createdAt: string;
  updatedAt: string;
  items: {
    text: string;
    state: 'open' | 'in_progress' | 'done' | 'rejected';
    position: number;
    creator: Ref | null;
    /** Who wrote the words as they read now, when not the creator (T-203). */
    editor: Ref | null;
    createdAt: string;
    updatedAt: string;
  }[];
}

export interface HistoryCommand {
  kind: 'history';
  ticket: Ref;
  actor: Ref | null;
  at: string;
  /** Fields as history names them (`tickets/history.ts`). */
  items: { field: string; from: HistoryValue; to: HistoryValue }[];
  /**
   * Entries exactly as the source stores them (values with source ids, `cf[<source id>]`),
   * mapped on load (`remap.ts`): Taskmoor's own export, instead of `items`.
   */
  stored?: StoredHistoryItem[];
}

export interface StoredHistoryItem {
  field: string;
  from: string | null;
  to: string | null;
  fromDisplay: string | null;
  toDisplay: string | null;
  /** The workflow transition that made it; ids inside a definition carry over unchanged. */
  transition: number | null;
}

export interface TimeEntryCommand {
  kind: 'time_entry';
  ticket: Ref;
  author: Ref;
  startedAt: string;
  seconds: number;
  description: string;
  visibleGroup?: Ref | null;
  visibleRole?: Ref | null;
  createdBy?: Ref | null;
  createdAt?: string;
  updatedAt?: string;
}

/** A file on a ticket; `file` is where the source holds its bytes (`ImportSource.openFile`). */
export interface AttachmentCommand {
  kind: 'attachment';
  ticket: Ref;
  name: string;
  declaredType: string;
  sniffedType: string | null;
  size: number;
  sha256: string;
  author: Ref | null;
  createdAt: string;
  width: number | null;
  height: number | null;
  file: string;
}

export type Command =
  | UserCommand
  | GroupCommand
  | TeamCommand
  | RoleCommand
  | StatusCommand
  | PriorityCommand
  | CloseReasonCommand
  | TicketTypeCommand
  | LinkTypeCommand
  | TrackCommand
  | ReleaseCommand
  | AreaCommand
  | FieldCommand
  | FieldContextCommand
  | FieldOptionCommand
  | FieldRuleSetCommand
  | LayoutSetCommand
  | AccessPolicyCommand
  | VisibilityPolicyCommand
  | VisibilityLevelCommand
  | NotificationPolicyCommand
  | GlobalGrantCommand
  | WorkflowCommand
  | WorkflowMapCommand
  | BoardCommand
  | TicketCommand
  | SprintCommand
  | CommentCommand
  | LinkCommand
  | WebLinkCommand
  | TimeEntryCommand
  | AttachmentCommand
  | ChecklistCommand
  | HistoryCommand
  | SavedSearchCommand
  | SubscriptionCommand
  | DashboardCommand;

// --- Saved searches, subscriptions and dashboards (M1-094; ADR-096) ---------------------------

/** Why a saved query cannot translate, or what to know about it (`translate/jql.ts`). */
export interface QueryNote {
  code: string;
  detail: string;
  /** A sentence for people, naming what was found. */
  message: string;
}

/** Who besides the owner sees a saved search or a dashboard (the scopes of ADR-053). */
export interface ShareCommand {
  scope: SavedSearchShareScope;
  user?: Ref;
  group?: Ref;
  track?: Ref;
  /** With a track: only that role's actors. */
  role?: Ref | null;
}

export interface SavedQueryCommand {
  /** The query as the source wrote it. */
  source: string;
  /** Step 1's template (a query tree with references); null when it cannot translate. */
  template: JsonValue | null;
  /** Why it cannot translate. */
  problems: QueryNote[];
  /** It translates but names a module this version lacks. */
  flags: QueryNote[];
}

export interface SavedSearchCommand {
  kind: 'saved_search';
  name: string;
  description: string;
  owner: Ref;
  query: SavedQueryCommand;
  shares: ShareCommand[];
  /** People who starred it. */
  stars: Ref[];
}

export interface SubscriptionCommand {
  kind: 'subscription';
  savedSearch: Ref;
  /** Who made it; the recipient when it goes to no group. */
  creator: Ref;
  group: Ref | null;
  schedule: 'daily' | 'weekly' | 'monthly' | 'cron';
  hour: number;
  minute: number;
  weekday: number | null;
  dayOfMonth: number | null;
  cron: string | null;
  timeZone: string;
  onlyIfResults: boolean;
  lastRunAt: string | null;
}

/** A widget: its settings, and the references that finish them on load. */
export interface WidgetCommand {
  kind: WidgetKind;
  column: number;
  title: string;
  config: Record<string, JsonValue>;
  /** `config.query` from a saved search (`savedSearch = <id>`) or a track (`track = KEY`). */
  query?: { savedSearch: Ref } | { track: Ref };
  /** `config.boardId`. */
  board?: Ref;
  /** `config.field`, a custom field (`cf[<id>]`). */
  field?: Ref;
}

export interface DashboardCommand {
  kind: 'dashboard';
  name: string;
  description: string;
  owner: Ref;
  layout: DashboardLayout;
  widgets: WidgetCommand[];
  shares: ShareCommand[];
}

/** What the map stage makes of a record. */
export type Mapped =
  | { command: Command; warnings?: Warning[] }
  /** Deliberately left out (an archived object the user chose not to import, say). */
  | { skip: string; warnings?: Warning[] }
  | { fail: string; warnings?: Warning[] };

/** A source format's mapper: source records of the framework's kinds to commands. */
export type Mapper = (record: SourceRecord) => Mapped;

/** A source format: how to open its source from a run's stored settings, and its mapper. */
export interface ImportFormat {
  importSource: string;
  open(source: unknown, context?: OpenContext): ImportSource;
  map: Mapper;
  /**
   * The source holds complete history and derived values (Taskmoor's own export): tickets get
   * no starting values written for them, history entries are written as they are, and time
   * spent and formulas are kept rather than computed.
   */
  verbatim?: boolean;
  /**
   * The source records every change to a ticket in its own history (a backup's change groups, a
   * Cloud site's changelog), which arrives as `history` records: a re-run that updates a ticket
   * writes no history entries of its own for the difference (M1-096), so a delta run ends with
   * the history a fresh import of the same source would write.
   */
  sourceHistory?: boolean;
}
