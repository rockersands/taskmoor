import { z } from 'zod';
import { sprintSettingsInput } from '../sprints/model';

/**
 * A board's configuration (M1-043; spec 01b section 3.1; ADR-049). The routes validate it with
 * these schemas and store it as JSON on the board (`board.columns`, `swimlanes`,
 * `board_filters`, `card_rules`).
 *
 * - **Columns** map statuses: a status sits in at most one column; a ticket whose status no
 *   column takes is counted in the unmapped panel and not shown (AGL-002). The rightmost column
 *   means done. Each column may have a minimum and a maximum number of tickets (AGL-003).
 * - **Swimlanes** group the cards: by queries (first matching lane wins, then the catch-all
 *   lane, which always exists and so cannot be deleted), by assignee (unassigned first or
 *   last), by parent (lanes in the parents' rank order, then tickets without a parent), or
 *   none (AGL-004). ORDER BY in a lane query is ignored.
 * - **Board filters** are named query fragments; the active ones combine with AND (AGL-005).
 * - **Card rules**: the colour strip (by ticket type, priority, assignee or queries, first
 *   matching query wins), up to 10 extra fields and the days-in-column marker (AGL-006).
 *
 * Column, lane, board filter and colour rule ids are short strings the server gives items that
 * come without one; clients keep them across updates, so an active board filter or a column a
 * card moves to keeps its name.
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const name = z.string().trim().min(1).max(255);
const query = z.string().trim().min(1).max(10_000);
export const itemId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const wip = z.number().int().min(0).max(1_000_000).nullable();

export const BOARD_KINDS = ['scrum', 'kanban'] as const;
export const SWIMLANE_MODES = ['none', 'queries', 'assignees', 'parents'] as const;
export const COLOUR_MODES = ['none', 'type', 'priority', 'assignee', 'queries'] as const;
export const MAX_COLUMNS = 30;
export const MAX_LANES = 20;
export const MAX_BOARD_FILTERS = 30;
export const MAX_COLOUR_RULES = 20;
/** Extra fields on a card: Jira allows 3, Taskmoor 10 (AGL-006). */
export const MAX_CARD_FIELDS = 10;

/** Ticket properties a card may show besides its key, summary, type and status. */
export const CARD_FIELDS = [
  'assignee',
  'priority',
  'dueDate',
  'startDate',
  'labels',
  'targetReleases',
  'areas',
  'requester',
  'parent',
  'track',
  'voteCount',
  'followerCount',
  'timeTracking',
  'createdAt',
  'updatedAt',
] as const;
const cardField = z.union([z.enum(CARD_FIELDS), z.string().regex(/^cf\[\d{1,10}\]$/)]);

export const columnInput = z
  .object({
    id: itemId.optional(),
    name,
    statusIds: z.array(id).max(200).default([]),
    min: wip.default(null),
    max: wip.default(null),
  })
  .strict()
  .refine((c) => c.min === null || c.max === null || c.min <= c.max, {
    message: 'min_above_max',
    path: ['min'],
  });

export const laneInput = z.object({ id: itemId.optional(), name, query }).strict();

export const swimlanesInput = z
  .object({
    mode: z.enum(SWIMLANE_MODES),
    lanes: z.array(laneInput).max(MAX_LANES).default([]),
    /** Assignee lanes: the lane of unassigned tickets comes first or last. */
    unassigned: z.enum(['first', 'last']).default('last'),
    /** The catch-all lane's name. */
    otherName: name.default('Everything else'),
  })
  .strict();

export const boardFilterInput = z
  .object({
    id: itemId.optional(),
    name,
    query,
    description: z.string().max(1000).default(''),
  })
  .strict();

export const colourRuleInput = z
  .object({
    id: itemId.optional(),
    query,
    colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strict();

export const cardRulesInput = z
  .object({
    colourBy: z.enum(COLOUR_MODES),
    colours: z.array(colourRuleInput).max(MAX_COLOUR_RULES).default([]),
    fields: z
      .array(cardField)
      .max(MAX_CARD_FIELDS)
      .refine((f) => new Set(f).size === f.length, 'each field once')
      .default([]),
    daysInColumn: z.boolean().default(true),
  })
  .strict();

export type ColumnInput = z.infer<typeof columnInput>;
export type SwimlanesInput = z.infer<typeof swimlanesInput>;
export type BoardFilterInput = z.infer<typeof boardFilterInput>;
export type CardRulesInput = z.infer<typeof cardRulesInput>;

export interface Column {
  id: string;
  name: string;
  statusIds: number[];
  min: number | null;
  max: number | null;
}
export interface Lane {
  id: string;
  name: string;
  query: string;
}
export interface Swimlanes {
  mode: (typeof SWIMLANE_MODES)[number];
  lanes: Lane[];
  unassigned: 'first' | 'last';
  otherName: string;
}
export interface BoardFilter {
  id: string;
  name: string;
  query: string;
  description: string;
}
export interface ColourRule {
  id: string;
  query: string;
  colour: string;
}
export interface CardRules {
  colourBy: (typeof COLOUR_MODES)[number];
  colours: ColourRule[];
  fields: string[];
  daysInColumn: boolean;
}

/** The board's source: its own query, or a saved search (M1-063; ADR-049, ADR-053). */
export const sourceInput = z.union([
  z.object({ query }).strict(),
  z.object({ savedSearchId: id }).strict(),
]);
export type BoardSource = z.infer<typeof sourceInput>;
/** A sub-filter is always a query of its own. */
export const subFilterInput = z.object({ query }).strict();

/** The query a source stands for: a saved search reads as a reference to it. */
export const sourceQuery = (source: BoardSource): string =>
  'query' in source ? source.query : `savedSearch = ${source.savedSearchId}`;

export const createBoardBody = z
  .object({
    name,
    description: z.string().max(10_000).optional(),
    kind: z.enum(BOARD_KINDS),
    /** A track, or nothing: the board then belongs to the person who creates it. */
    trackId: id.nullable().optional(),
    source: sourceInput,
    subFilter: subFilterInput.nullable().optional(),
    columns: z.array(columnInput).min(1).max(MAX_COLUMNS).optional(),
    swimlanes: swimlanesInput.optional(),
    boardFilters: z.array(boardFilterInput).max(MAX_BOARD_FILTERS).optional(),
    boardFilterDisplay: z.enum(['buttons', 'dropdown']).optional(),
    cardRules: cardRulesInput.optional(),
    /** Estimation statistic, time tracking and parallel sprints (M1-044, AGL-007). */
    sprintSettings: sprintSettingsInput.optional(),
    adminIds: z.array(id).max(50).optional(),
  })
  .strict();

export const updateBoardBody = z
  .object({
    version: z.number().int().positive().optional(),
    /**
     * For a board that manages its workflow (M1-126): where the tickets of a removed column go,
     * by status id; the leftmost column otherwise.
     */
    statusMapping: z.record(z.string().regex(/^\d{1,10}$/), id).optional(),
    name: name.optional(),
    description: z.string().max(10_000).optional(),
    kind: z.enum(BOARD_KINDS).optional(),
    source: sourceInput.optional(),
    subFilter: subFilterInput.nullable().optional(),
    columns: z.array(columnInput).min(1).max(MAX_COLUMNS).optional(),
    swimlanes: swimlanesInput.optional(),
    boardFilters: z.array(boardFilterInput).max(MAX_BOARD_FILTERS).optional(),
    boardFilterDisplay: z.enum(['buttons', 'dropdown']).optional(),
    cardRules: cardRulesInput.optional(),
    /** Estimation statistic, time tracking and parallel sprints (M1-044, AGL-007). */
    sprintSettings: sprintSettingsInput.optional(),
    adminIds: z.array(id).max(50).optional(),
  })
  .strict();

/** The default lanes and board filters of spec 01b section 3.1. */
export const DEFAULT_SWIMLANES: Swimlanes = {
  mode: 'none',
  lanes: [{ id: 'expedite', name: 'Expedite', query: 'priority = Urgent' }],
  unassigned: 'last',
  otherName: 'Everything else',
};
export const DEFAULT_BOARD_FILTERS: BoardFilter[] = [
  { id: 'mine', name: 'Only my tickets', query: 'assignee = currentUser()', description: '' },
  { id: 'recent', name: 'Recently updated', query: 'updated >= -1d', description: '' },
];
export const DEFAULT_CARD_RULES: CardRules = {
  colourBy: 'type',
  colours: [],
  fields: ['assignee', 'priority'],
  daysInColumn: true,
};

/**
 * Gives every item an id: its own when it has one, else `<prefix><n>` with the first free n.
 * Returns null when two items share an id.
 */
export function withIds<T extends { id?: string | undefined }>(
  items: readonly T[],
  prefix: string,
): (T & { id: string })[] | null {
  const taken = new Set<string>();
  for (const item of items) {
    if (item.id === undefined) continue;
    if (taken.has(item.id)) return null;
    taken.add(item.id);
  }
  let n = 0;
  const next = () => {
    let candidate: string;
    do candidate = `${prefix}${++n}`;
    while (taken.has(candidate));
    taken.add(candidate);
    return candidate;
  };
  return items.map((item) => ({ ...item, id: item.id ?? next() }));
}

/** The first status id two columns share, or null. */
export function sharedStatus(columns: readonly { statusIds: readonly number[] }[]): number | null {
  const seen = new Set<number>();
  for (const column of columns) {
    for (const statusId of column.statusIds) {
      if (seen.has(statusId)) return statusId;
      seen.add(statusId);
    }
  }
  return null;
}

/** A column's WIP state: over its maximum, under its minimum, or neither (AGL-003 (1)). */
export function wipState(
  column: Pick<Column, 'min' | 'max'>,
  count: number,
): 'over' | 'under' | null {
  if (column.max !== null && count > column.max) return 'over';
  if (column.min !== null && count < column.min) return 'under';
  return null;
}

/**
 * When a card entered its current column (AGL-006 (2)): the last status change that came from
 * a status outside that column, or its creation. `changes` are the ticket's status changes,
 * oldest first, as status ids.
 */
export function enteredColumn(
  columnOf: (statusId: number) => string | null,
  currentStatusId: number,
  createdAt: Date,
  changes: readonly { from: number | null; to: number | null; at: Date }[],
): Date {
  const column = columnOf(currentStatusId);
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i] as (typeof changes)[number];
    const from = change.from === null ? null : columnOf(change.from);
    if (from !== column) return change.at;
  }
  return createdAt;
}
