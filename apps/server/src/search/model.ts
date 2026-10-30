import type { TextSearch } from '@taskmoor/query';
import type { SideTable } from '../fields/storage';

/**
 * What the compiler compiles (M1-037; ADR-010): a resolved query (`@taskmoor/query` Plan) with
 * every name looked up. Statuses, people, options, releases and keys are ids here, `NOT` has
 * been pushed down to the clauses, and each clause says which table answers it. The binder
 * (`bind.ts`) builds it with the database at hand; the compiler (`compile.ts`) turns it into
 * SQL without one, so the SQL it writes can be read and reviewed as golden files.
 */

/** The SQL type of a value, which the compiler casts parameters to so indexes apply. */
export type SqlType = 'int' | 'bigint' | 'numeric' | 'float8' | 'text' | 'date' | 'timestamptz';

export type Op = '=' | '<>' | '<' | '<=' | '>' | '>=';

/** A parameter value: numbers, text, and dates and instants as ISO text. */
export type Scalar = number | string;

/** Columns of `ticket` (alias `k`) the compiler names. */
export type TicketColumn =
  | 'id'
  | 'number'
  | 'track_id'
  | 'ticket_type_id'
  | 'status_id'
  | 'priority_id'
  | 'close_reason_id'
  | 'parent_id'
  | 'assignee_id'
  | 'requester_id'
  | 'creator_id'
  | 'created_at'
  | 'updated_at'
  | 'closed_at'
  | 'due_date'
  | 'start_date'
  | 'original_estimate'
  | 'remaining_estimate'
  | 'time_spent'
  | 'visibility_level_id'
  | 'first_response_at'
  | 'last_comment_at';

/** A value of one ticket: a column, or a figure computed from the ticket. */
export type Scalarish =
  | { kind: 'column'; column: TicketColumn; type: SqlType; nullable: boolean }
  /** Time spent against the original estimate in percent; empty without an estimate. */
  | { kind: 'effortRatio' }
  /** How many people follow or voted for the ticket. */
  | { kind: 'count'; relation: 'follower' | 'voter' }
  /** Whole days since the latest comment (M1-125); empty without one. */
  | { kind: 'daysSinceLastComment' };

/** A test on one value. */
export type ValueTest =
  | { kind: 'cmp'; op: Op; value: Scalar }
  | { kind: 'in'; values: Scalar[] }
  /** The text matches a search (spec 01b section 1.8; M1-040). */
  | { kind: 'words'; search: TextSearch };

/** A custom field's side table (ADR-008) and the SQL type of its value column. */
export interface SideRef {
  table: SideTable;
  fieldId: number;
  type: SqlType;
  /** Several rows per ticket (multiple selects, people and so on, labels, a cascade). */
  multiple: boolean;
  /** Its values order as the field sorts (numbers, dates, instants), so a page can walk them. */
  ordered: boolean;
}

/** Rows that belong to a ticket in another table. */
export type Related =
  | {
      relation:
        | 'follower'
        | 'voter'
        | 'area'
        | 'targetRelease'
        | 'foundInRelease'
        | 'parentTrack'
        /** The requester, the assignee and the authors of counted comments (M1-125). */
        | 'participant';
      ids: number[];
    }
  /** Tickets linked either way to one of `ids`. */
  | { relation: 'link'; ids: number[] }
  /** Links of a type: by its name (either end), its outward or its inward description. */
  | { relation: 'linkType'; both: number[]; outward: number[]; inward: number[] }
  /** Time entries whose comment or date passes the test. */
  | { relation: 'timeEntry'; on: 'comment' | 'date'; test: ValueTest }
  /** Sprints the ticket is or was in that match one of `matches` (M1-045). */
  | { relation: 'sprint'; matches: SprintMatch[] };

/**
 * Which sprints a sprint clause names (M1-045; QRY-004, QRY-013). Deleted sprints never match.
 * States and tokens are answered in the statement, so they cost no list of sprint ids however
 * many sprints there are (spec 01b section 1.6: 60,000 and more).
 */
export type SprintMatch =
  /** By id or by name. */
  | { kind: 'ids'; ids: number[] }
  /** `openSprints()` active, `futureSprints()` future, `closedSprints()` closed. */
  | { kind: 'state'; state: 'future' | 'active' | 'closed' }
  /**
   * `@current` the active sprint, `@next` the first future one in the board's order,
   * `@previous` the last one completed: of this board, or of every board on its own.
   */
  | { kind: 'relative'; token: 'current' | 'next' | 'previous'; boardId: number | null };

export type RelationName = Related['relation'] | 'attachment';

/**
 * Tickets a function names (M1-038; QRY-004), answered in the statement by a semi-join on a
 * ticket id, so a set of any size costs no list of ids in the query. The statement's own
 * permission filter decides which of them the person sees.
 */
export type TicketSet =
  /** Tickets the person follows or voted for (`followedTickets()`, `votedTickets()`). */
  | { kind: 'followed' | 'voted'; userId: number }
  /** Tickets the person opened lately (`ticketHistory()`; the home page's visits). */
  | { kind: 'visited'; userId: number }
  /**
   * Tickets these people changed (creating a ticket records its first values as changes) or
   * commented on (comments the viewer reads), at or after `from` and at or before `to`
   * (`updatedBy()`).
   */
  | { kind: 'updatedBy'; userIds: number[]; from?: string; to?: string }
  /**
   * Tickets linked to one of `ticketIds` (`linkedTickets()`): as the link's target where the
   * given ticket is the source with a type in `outward`, as its source where the given ticket
   * is the target with a type in `inward`; 'all' for any type.
   */
  | {
      kind: 'linked';
      ticketIds: number[];
      outward: number[] | 'all';
      inward: number[] | 'all';
    }
  /** Tickets with a web link of one of these global ids. */
  | { kind: 'webLinks'; globalIds: string[] };

/**
 * Which values of a field's history a clause names (M1-039). History keeps every value as text
 * (`tickets/history.ts`): ids, numbers, ISO days and instants and keys as they are; lists in one
 * row (labels by spaces, ids by commas, a cascade's levels by colons); plain text; rich-text
 * documents as JSON; links as `type:direction:ticket`. Names are the ones a value had when it
 * was written (`*_display`), lower case, for values renamed or removed since (spec 01b 1.3).
 */
export type HistoryTest =
  /** The value is one of `values`, or was called one of `names` then. */
  | { kind: 'values'; values: string[]; names: string[] }
  /** One of the list's items is one of `values`, or was called one of `names` then. */
  | {
      kind: 'items';
      separator: ' ' | ',' | ':';
      /** How the names of the items are joined: ", ", or " / " for a cascade. */
      nameSeparator: ', ' | ' / ';
      values: string[];
      names: string[];
    }
  /** The text matches one of `searches`; `document`: the value is a rich-text document. */
  | { kind: 'words'; searches: TextSearch[]; document: boolean }
  /** A link to one of `tickets`. */
  | { kind: 'linkTo'; tickets: number[] }
  /** A link of a type: either way (`both`), as its source (`outward`) or target (`inward`). */
  | { kind: 'linkType'; both: number[]; outward: number[]; inward: number[] };

/** The values a history clause names on one side of a change: some, EMPTY, or both. */
export interface HistorySide {
  test: HistoryTest | null;
  empty: boolean;
}

/** One end of a history clause's time window, as ISO text, and whether it is inside. */
export interface TimeEdge {
  at: string;
  inclusive: boolean;
}

/**
 * A condition on ticket `k`. `some` matches tickets with a matching value; `none` matches
 * tickets that have values and none of them matches, so a negated clause never brings back
 * tickets whose field is empty (spec 01b section 1.1: only IS EMPTY matches those).
 */
export type Quantifier = 'some' | 'none';

export type Cond =
  | { kind: 'and'; items: Cond[] }
  | { kind: 'or'; items: Cond[] }
  | { kind: 'const'; value: boolean }
  /** `negated` only with an `in` test (NOT IN); comparisons come already turned around. */
  | { kind: 'scalar'; on: Scalarish; test: ValueTest; negated: boolean }
  | { kind: 'empty'; on: Scalarish; negated: boolean }
  | { kind: 'labels'; values: string[]; quantifier: Quantifier }
  | { kind: 'labelsEmpty'; negated: boolean }
  /**
   * Text search in the summary, description, environment or comments (spec 01b section 1.8;
   * M1-040). Comments count only where the viewer reads them (`commentReadableSql`, M1-018): a
   * hidden comment never matches and never makes `comment IS NOT EMPTY` true.
   */
  | {
      kind: 'words';
      source: TextSource;
      search: TextSearch;
      negated: boolean;
      /**
       * Few tickets match (counted in the word index when the query was bound, M1-040): start
       * from the index instead of testing each ticket as the order is walked.
       */
      fromIndex?: boolean;
    }
  | { kind: 'wordsEmpty'; source: 'description' | 'environment' | 'comment'; negated: boolean }
  /**
   * The master text field: summary, description, environment, the comments the viewer reads
   * and the text custom fields.
   */
  | {
      kind: 'text';
      search: TextSearch;
      fieldIds: number[];
      negated: boolean;
      /**
       * The planner expects so many tickets to match (M1-040) that a page (`page`) or a count
       * (`count`) is better served by testing each ticket as the order is walked than by
       * starting from the word indexes (`compile.ts`, `masterText`; `bind.ts`, `textForms`).
       */
      perRow?: { page: boolean; count: boolean };
    }
  | { kind: 'side'; side: SideRef; test: ValueTest; quantifier: Quantifier }
  | { kind: 'sideEmpty'; side: SideRef; negated: boolean }
  | { kind: 'related'; related: Related; quantifier: Quantifier }
  | { kind: 'relatedEmpty'; relation: RelationName; negated: boolean }
  /**
   * The ticket (`id`) or its parent (`parent_id`) is in a set a function names; negated, it is
   * not (and a ticket without a parent never matches, spec 01b section 1.1). A parent counts
   * only when the viewer may see it.
   */
  | { kind: 'ticketSet'; on: 'id' | 'parent_id'; set: TicketSet; negated: boolean }
  /**
   * WAS and CHANGED over `ticket_change` (M1-039; QRY-005). WAS: some stretch of time in which
   * the field held one of `held`'s values (EMPTY: none), begun by a change by one of `by`, that
   * overlaps the window from `after` to `before`; negated (WAS NOT), no such stretch. CHANGED: a
   * change after the ticket's creation (its first values are history too, not changes) that
   * took away one of `from`'s values and brought one of `to`'s, by one of `by`, within the window.
   * `state` rows hold the field's whole new value, so a stretch lasts until the field's next
   * row; `delta` rows add (to) or remove (from) one value (links), whose stretch lasts until a
   * row removes it.
   */
  | {
      kind: 'history';
      /** The field's name in `ticket_change` (`status`, `dueDate`, `cf[12]`, `link`). */
      field: string;
      op: 'was' | 'changed';
      negated: boolean;
      rows: 'state' | 'delta';
      /** Every ticket starts with a value (status, type, track): never empty before its first row. */
      startsSet?: boolean;
      held?: HistorySide;
      from?: HistorySide;
      to?: HistorySide;
      by?: number[];
      after?: TimeEdge;
      before?: TimeEdge;
    }
  /**
   * WAS on a field set once, when the ticket is created (creator, created): the ticket's value,
   * held from its creation on and set by its creator (`by`); `before` bounds the creation time.
   */
  | {
      kind: 'held';
      on: 'creator_id' | 'created_at';
      test: ValueTest | null;
      empty: boolean;
      by?: number[];
      before?: TimeEdge;
      negated: boolean;
    };

/** Where a text search looks, besides custom text fields. */
export type TextSource = 'summary' | 'description' | 'environment' | 'comment';

/**
 * A text search that must match, which relevance ranks (M1-040): one source, a custom text
 * field, or the master text field (summary, description and environment; comments and text
 * fields make a ticket match `text ~` but do not raise its rank).
 */
export type RankedSearch =
  | { on: TextSource | 'text'; search: TextSearch }
  | { on: 'custom'; fieldId: number; search: TextSearch };

/** A value results are ordered by. */
export type OrderSource =
  | { kind: 'column'; column: TicketColumn; type: SqlType; nullable: boolean }
  | { kind: 'lowerSummary' }
  | { kind: 'trackKey' }
  | { kind: 'typeName' }
  | { kind: 'levelRank' }
  | { kind: 'statusOrder' }
  /** Higher priorities rank higher: DESC puts the highest first. */
  | { kind: 'priorityRank' }
  | { kind: 'closeReasonOrder' }
  | { kind: 'personName'; column: 'assignee_id' | 'requester_id' | 'creator_id' }
  | { kind: 'count'; relation: 'follower' | 'voter' }
  | { kind: 'areaName' }
  | { kind: 'releaseOrder'; role: 'target' | 'found' }
  /** The ticket's latest sprint in its board's order (M1-045); without one, last. */
  | { kind: 'sprintOrder' }
  | { kind: 'effortRatio' }
  /**
   * The place in the ranking by how well the ticket matches `searches` (M1-040): the best match
   * comes first in ascending order, as rank does on a board.
   */
  | { kind: 'relevance'; searches: RankedSearch[] }
  /** A custom field: its value, sort key, option order, person, group, release or area. */
  | { kind: 'side'; side: SideRef; by: SideOrder };

export type SideOrder =
  | 'value'
  | 'sortKey'
  | 'optionOrder'
  | 'cascadeChildOrder'
  | 'personName'
  | 'groupName'
  | 'releaseOrder'
  | 'areaName';

export interface OrderKey {
  source: OrderSource;
  direction: 'asc' | 'desc';
}

/**
 * The values of a first order key that reads one ticket column holding few ids (priorities,
 * statuses, types, levels, close reasons, tracks): each order value with the ids that have it.
 * The compiler can then walk one value at a time (`compile.ts`, "value branches").
 */
export interface KeyDomain {
  column: TicketColumn;
  type: SqlType;
  /** The column can be empty; its tickets sort last. */
  nullable: boolean;
  values: { value: Scalar; ids: number[] }[];
}

/** A query ready to compile. */
export interface Bound {
  where: Cond;
  /** Never empty: without ORDER BY, newest first (spec 01b section 1.7). */
  orderBy: OrderKey[];
  /** The first key's values, when it takes few (read in the same request as the query). */
  domain?: KeyDomain;
  /** Notes for the person: values that matched nothing they may see. */
  warnings: string[];
}

/** Whether an order source can be empty, so it sorts empties last. */
export function nullableOrder(source: OrderSource): boolean {
  switch (source.kind) {
    case 'column':
      return source.nullable;
    case 'lowerSummary':
    case 'trackKey':
    case 'typeName':
    case 'levelRank':
    case 'statusOrder':
    case 'count':
    case 'relevance':
      return false;
    default:
      return true;
  }
}

/** The SQL type of an order source's value, for reading a cursor back. */
export function orderType(source: OrderSource): SqlType {
  switch (source.kind) {
    case 'column':
      return source.type;
    case 'lowerSummary':
    case 'trackKey':
    case 'typeName':
    case 'personName':
    case 'areaName':
      return 'text';
    case 'count':
      return 'bigint';
    case 'effortRatio':
      return 'numeric';
    case 'relevance':
      return 'float8';
    case 'side':
      switch (source.by) {
        case 'value':
          return source.side.type;
        case 'sortKey':
        case 'personName':
        case 'groupName':
        case 'areaName':
          return 'text';
        default:
          return 'int';
      }
    default:
      return 'int';
  }
}
