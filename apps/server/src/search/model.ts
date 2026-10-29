import type { SideTable } from '../fields/storage';

/**
 * What the compiler compiles (M1-037; ADR-010): a resolved query (`@taskmoor/query` Plan) with
 * every name looked up. Statuses, people, options, releases and keys are ids here, `NOT` has
 * been pushed down to the clauses, and each clause says which table answers it. The binder
 * (`bind.ts`) builds it with the database at hand; the compiler (`compile.ts`) turns it into
 * SQL without one, so the SQL it writes can be read and reviewed as golden files.
 */

/** The SQL type of a value, which the compiler casts parameters to so indexes apply. */
export type SqlType = 'int' | 'bigint' | 'numeric' | 'text' | 'date' | 'timestamptz';

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
  | 'visibility_level_id';

/** A value of one ticket: a column, or a figure computed from the ticket. */
export type Scalarish =
  | { kind: 'column'; column: TicketColumn; type: SqlType; nullable: boolean }
  /** Time spent against the original estimate in percent; empty without an estimate. */
  | { kind: 'effortRatio' }
  /** How many people follow or voted for the ticket. */
  | { kind: 'count'; relation: 'follower' | 'voter' };

/** A test on one value. */
export type ValueTest =
  | { kind: 'cmp'; op: Op; value: Scalar }
  | { kind: 'in'; values: Scalar[] }
  /** Every word of the text occurs (spec 01b section 1.8, the M1-037 subset). */
  | { kind: 'words'; text: string };

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
      relation: 'follower' | 'voter' | 'area' | 'targetRelease' | 'foundInRelease' | 'parentTrack';
      ids: number[];
    }
  /** Tickets linked either way to one of `ids`. */
  | { relation: 'link'; ids: number[] }
  /** Links of a type: by its name (either end), its outward or its inward description. */
  | { relation: 'linkType'; both: number[]; outward: number[]; inward: number[] }
  /** Time entries whose comment or date passes the test. */
  | { relation: 'timeEntry'; on: 'comment' | 'date'; test: ValueTest };

export type RelationName = Related['relation'] | 'attachment';

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
   * Word search in the summary, description, environment or comments. Comments count only
   * where the viewer reads them (`commentReadableSql`, M1-018): a hidden comment never matches
   * and never makes `comment IS NOT EMPTY` true.
   */
  | {
      kind: 'words';
      source: 'summary' | 'description' | 'environment' | 'comment';
      text: string;
      negated: boolean;
    }
  | { kind: 'wordsEmpty'; source: 'description' | 'environment' | 'comment'; negated: boolean }
  /**
   * The master text field: summary, description, environment, the comments the viewer reads
   * and the text custom fields.
   */
  | { kind: 'text'; text: string; fieldIds: number[]; negated: boolean }
  | { kind: 'side'; side: SideRef; test: ValueTest; quantifier: Quantifier }
  | { kind: 'sideEmpty'; side: SideRef; negated: boolean }
  | { kind: 'related'; related: Related; quantifier: Quantifier }
  | { kind: 'relatedEmpty'; relation: RelationName; negated: boolean };

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
  | { kind: 'effortRatio' }
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
