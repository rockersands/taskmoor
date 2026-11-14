import type { FieldValueType, OutputType } from '@taskmoor/formula';

/**
 * The shapes of a plan's Grid (ADR-122 stage 10, PLN-010) as the browser reads them: a structure's
 * recipe (`structureSpec` on the server), the list of a plan's structures and the columnar
 * skeleton of `GET /api/v1/plans/:id/structures/:sid/rows`. The server keeps its own copy of the
 * recipe in `apps/server/src/plans/structures.ts`; the two follow the ADR word for word.
 */

/** The steps, applied in this order whatever order they are stored in (ADR-122 question 23). */
export type StructureStep =
  /** Add tickets: the plan's tickets, maybe narrowed by a query (exactly one). */
  | { kind: 'insert'; query?: string }
  /** Group by a single-valued field (0 to 2): `track`, `assignee`, `status`, `type`, `priority` or `cf[N]`. */
  | { kind: 'group'; field: string }
  /** Add children: every visible descendant by parent, down every level (0 or 1). */
  | { kind: 'children' }
  /** Add linked tickets by a link type and a direction, up to `depth` (0 to 2 steps). */
  | { kind: 'links'; linkTypeId: number; direction: 'outward' | 'inward'; depth: 1 | 2 | 3 };

export type TotalFn = 'sum' | 'min' | 'max' | 'count' | 'progress';

export type StructureColumn =
  /** A ticket column: `key`, one of `SYSTEM_COLUMNS` or `cf[N]` (`search/columns.ts`), edited in place. */
  | { kind: 'ticket'; field: string }
  /**
   * A total of the rows below. `of` is a value ref (below) for `sum`, `min` and `max`; `count`
   * and `progress` take none.
   */
  | { kind: 'total'; fn: TotalFn; of?: string }
  /** A formula in the formula field language, stored with fields by id (`{cf[12]}`, `{due}`). */
  | { kind: 'formula'; name: string; expression: string; output: OutputType; decimals: number };

export interface StructureSpec {
  steps: StructureStep[];
  columns: StructureColumn[];
}

/**
 * Something of a saved structure that does not work for this viewer: `path` is `steps.<i>` or
 * `columns.<i>` of the structure as stored, or the Add tickets step's query they cannot run.
 */
export interface StructureProblem {
  path: string;
  reason: string;
  /** A formula's error, as `GET /api/v1/formulas/check` gives it. */
  error?: { code: string; message: string; start?: number; end?: number };
  /** A query's error in words. */
  message?: string;
}

/** A row of `GET /api/v1/plans/:id/structures`. */
export interface StructureSummary {
  id: number;
  name: string;
  spec: StructureSpec;
  updatedAt: string;
  version: number;
  /** Whether some part of it does not work for this viewer; the rest still does. */
  broken: boolean;
}

/** `GET /api/v1/plans/:id/structures`. */
export interface StructureList {
  structures: StructureSummary[];
  editable: boolean;
  limits: GridLimits;
}

/** The ADR's limits table, as the list answers it. */
export interface GridLimits {
  structures: number;
  rows: number;
  steps: { insert: number; group: number; children: number; links: number };
  linkDepth: number;
  columns: number;
  totals: number;
  formulas: number;
  /** Characters of an Add tickets step's query. */
  query: number;
  /** Ids per rows-in-view read. */
  ids: number;
  /** Characters of a name. */
  name: number;
}

export const GRID_LIMITS: GridLimits = {
  structures: 20,
  rows: 100_000,
  steps: { insert: 1, group: 2, children: 1, links: 2 },
  linkDepth: 3,
  columns: 30,
  totals: 10,
  formulas: 5,
  query: 2_000,
  ids: 500,
  name: 100,
};

/** Where a row came from: `via` in the skeleton. */
export const VIA_INSERTED = 0;
export const VIA_CHILD = 1;
/** The nth links step (0-based) places its rows with `via` 2 + n. */
export const viaLinks = (n: number) => 2 + n;
export const placedByLink = (via: number) => via >= 2;

/**
 * A value a total or formula reads, by its formula ref: `originalEstimate`, `remainingEstimate`,
 * `timeSpent`, `start`, `due`, `summary` and the other ids of the server's `SYSTEM_REFS`, or
 * `cf[N]`. Dates are day numbers (days since 1970-01-01; ISO dates are read too); durations are
 * seconds.
 */
export interface GridField {
  ref: string;
  type: FieldValueType;
}

/** One group row: its field and its label ("No value" for the empty group). */
export interface GridGroup {
  row: number;
  field: string;
  label: string;
}

/**
 * The columnar skeleton: one entry per row in every array, rows in preorder (a row's rows below
 * follow it). Small at 100,000 rows; cells come from `POST .../grid/tickets` by window.
 */
export interface GridSkeleton {
  /** Drops an older answer that arrives after a newer one. */
  generation: number;
  /** The rows the structure reached, which may be more than `rows` holds when `more`. */
  total: number;
  /** Cut at 100,000 rows ("Shows the first 100,000 rows"). */
  more: boolean;
  /** The viewer's day, as a day number, for formula columns. */
  today: number;
  /** Working days, Monday first, for formula columns. */
  workingWeek: boolean[];
  fields: GridField[];
  rows: GridRows;
  groups: GridGroup[];
  /** Only the refs that totals and formulas read. */
  values: Record<string, (number | string | null)[]>;
}

export interface GridRows {
  /** The ticket id; 0 for a group row. */
  ticket: number[];
  key: string[];
  /** The parent's row index; -1 at the top. */
  parent: number[];
  depth: number[];
  /** The rank of the ticket's hierarchy level (-1 for subtickets). */
  level: number[];
  track: number[];
  /** False for a ticket outside the plan ("Not in this plan"). */
  inPlan: boolean[];
  /** 0 inserted, 1 child, 2 + n the nth links step. */
  via: number[];
  /** In a status of the closed stage. */
  closed: boolean[];
  /** Hidden live children and hidden linked tickets of the steps' types: a count only. */
  notShown: number[];
  /** Reaches of this ticket that the structure shows elsewhere. */
  elsewhere: number[];
}

/**
 * `GET /api/v1/plans/:id/structures/:sid/rows` (`default` for `:sid`): the skeleton with the
 * structure it was built from and what does not work for this viewer.
 */
export interface GridAnswer extends GridSkeleton {
  plan: { id: number; name: string };
  structure: {
    id: number | null;
    name: string | null;
    spec: StructureSpec;
    version: number | null;
  };
  /** Inside a scenario the Grid shows live values and is read-only (question 16). */
  scenario?: { id: number; name: string };
  live?: boolean;
  editable: boolean;
  broken: boolean;
  problems: StructureProblem[];
}

/** A plan with no saved structure shows this one, unsaved (ADR-122 question 21). */
export const DEFAULT_STRUCTURE: StructureSpec = {
  steps: [{ kind: 'insert' }, { kind: 'children' }],
  columns: [
    { kind: 'ticket', field: 'key' },
    { kind: 'ticket', field: 'summary' },
    { kind: 'ticket', field: 'status' },
    { kind: 'ticket', field: 'assignee' },
    { kind: 'total', fn: 'count' },
    { kind: 'total', fn: 'progress' },
  ],
};
