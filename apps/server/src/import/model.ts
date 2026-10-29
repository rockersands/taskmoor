import type { TrackType } from '@taskmoor/db';

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
 * backup reader, the Cloud REST reader and CSV (later tasks) only extract and map.
 */

/** The kinds the framework loads, in the order they run: each needs only kinds before it. */
export const ENTITY_KINDS = [
  'user',
  'group',
  'status',
  'ticket_type',
  'track',
  'ticket',
  'comment',
  'link',
  'history',
  'time_entry',
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
}

/** Something left out or changed on the way, counted per kind, code and detail in the report. */
export interface Warning {
  code: string;
  /** A field name, a value or another detail that groups warnings of one code. */
  detail?: string;
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
}

export interface GroupCommand {
  kind: 'group';
  name: string;
  description: string;
  members: Ref[];
}

export interface StatusCommand {
  kind: 'status';
  name: string;
  stage: Stage;
}

export interface TicketTypeCommand {
  kind: 'ticket_type';
  name: string;
  description: string;
  level: 'standard' | 'subticket';
}

export interface TrackCommand {
  kind: 'track';
  key: string;
  name: string;
  description: string;
  owner: Ref | null;
  trackType: TrackType;
}

export interface TicketCommand {
  kind: 'ticket';
  track: Ref;
  /** The source number, kept so keys survive the move (IMP-011). */
  number: number;
  type: Ref;
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
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  originalEstimate: number | null;
  remainingEstimate: number | null;
}

export interface CommentCommand {
  kind: 'comment';
  ticket: Ref;
  author: Ref | null;
  /** Markdown. */
  body: string;
  visibleGroup: Ref | null;
  createdAt: string;
  updatedAt: string;
}

export interface LinkCommand {
  kind: 'link';
  source: Ref;
  target: Ref;
  /** A link type by name, created with these phrases when the target has none of that name. */
  linkType: { name: string; outward: string; inward: string };
  createdAt: string;
  creator: Ref | null;
}

export interface HistoryCommand {
  kind: 'history';
  ticket: Ref;
  actor: Ref | null;
  at: string;
  /** Fields as history names them (`tickets/history.ts`). */
  items: { field: string; from: HistoryValue; to: HistoryValue }[];
}

export interface TimeEntryCommand {
  kind: 'time_entry';
  ticket: Ref;
  author: Ref;
  startedAt: string;
  seconds: number;
  description: string;
}

export type Command =
  | UserCommand
  | GroupCommand
  | StatusCommand
  | TicketTypeCommand
  | TrackCommand
  | TicketCommand
  | CommentCommand
  | LinkCommand
  | HistoryCommand
  | TimeEntryCommand;

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
  open(source: unknown): ImportSource;
  map: Mapper;
}
