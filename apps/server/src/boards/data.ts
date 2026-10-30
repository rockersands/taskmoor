import type { Database, JsonValue } from '@taskmoor/db';
import { type Catalogue, parseQuery, resolveQuery } from '@taskmoor/query';
import type { FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import type { Catalog, FieldCatalogs } from '../fields/catalog';
import { customFieldViews } from '../fields/values';
import { searchPerson, searchScope } from '../routes/search';
import { bindPlan } from '../search/bind';
import { queryCatalogue } from '../search/catalogue';
import { compileCond } from '../search/compile';
import type { Cond } from '../search/model';
import { functionNames, loginTimes, readOnly } from '../search/run';
import { expandSavedSearches } from '../search/saved';
import { commentReadableSql } from '../tickets/comments';
import { ticketKey } from '../tickets/model';
import { type TicketView, ticketQuery, ticketView } from '../tickets/store';
import { loadMap, publishedStatuses, trackMapId, workflowsOf } from '../workflows/maps';
import {
  type BoardFilter,
  type CardRules,
  type Column,
  enteredColumn,
  type Swimlanes,
  wipState,
} from './model';

/**
 * Reading a board (M1-043; AGL-002 to AGL-006, AGL-013, AGL-014). Every statement goes through
 * the search compiler's conditions with the viewer's ticket filter in it (QRY-008), so a board
 * never shows, counts or groups a ticket its viewer may not see.
 *
 * - The board's tickets: its filter query AND its sub-filter, in the viewer's tickets.
 * - Column counts (WIP) and the unmapped panel come from one GROUP BY over those tickets
 *   before board filters, so a board filter never changes a count (AGL-003 (2)).
 * - Cards: those tickets AND the active board filters, in a mapped status, in global rank
 *   order (AGL-009). Query lanes and query colours are CASE expressions in the same
 *   statement: the first matching lane or colour rule wins (AGL-004 (1), AGL-006 (1)).
 */
type Db = Kysely<Database>;

export interface BoardRecord {
  id: number;
  name: string;
  filterQuery: string;
  subFilterQuery: string | null;
  columns: Column[];
  swimlanes: Swimlanes;
  boardFilters: BoardFilter[];
  cardRules: CardRules;
  locationTrackId: number | null;
}

/** A board's row as the queries and the sprint lifecycle read it. */
export function boardRecord(row: {
  id: number;
  name: string;
  filter_query: string | null;
  saved_search_id: number | null;
  sub_filter_query: string | null;
  columns: unknown;
  swimlanes: unknown;
  board_filters: unknown;
  card_rules: unknown;
  location_track_id: number | null;
}): BoardRecord {
  return {
    id: row.id,
    name: row.name,
    filterQuery: row.filter_query ?? `savedSearch = ${row.saved_search_id}`,
    subFilterQuery: row.sub_filter_query,
    columns: row.columns as Column[],
    swimlanes: row.swimlanes as Swimlanes,
    boardFilters: row.board_filters as BoardFilter[],
    cardRules: row.card_rules as CardRules,
    locationTrackId: row.location_track_id,
  };
}

export interface Scope {
  ws: number;
  filter: { sql: RawBuilder<boolean>; tracks: readonly number[] | 'all' };
  catalog: Catalog;
  catalogue: Catalogue;
  userId: number | null;
  /** The viewer as the query functions and dates read them (M1-038). */
  person: ReturnType<typeof searchPerson>;
}

/**
 * What a board's queries may name, and the viewer's ticket filter. A board's queries are shared
 * configuration, checked when its editor saved them, so they resolve against every track and
 * field of the workspace: a viewer who does not browse one of the board's tracks still sees
 * the rest of the board. What they may see is still decided by the filter alone.
 */
export async function boardScope(
  db: Db,
  catalogs: FieldCatalogs,
  request: FastifyRequest,
): Promise<Scope> {
  const { ws, filter, catalog } = await searchScope(db, catalogs, request, false);
  const catalogue = await queryCatalogue(db, ws, catalog, 'all');
  return {
    ws,
    filter,
    catalog,
    catalogue,
    userId: request.user?.id ?? null,
    person: searchPerson(request),
  };
}

/**
 * A board's queries as the board shows them to anyone, with no viewer: what the worker's cycle
 * roll-over (M1-045) carries over. Functions about the viewer find nobody.
 */
export async function workspaceScope(
  db: Db,
  catalogs: FieldCatalogs,
  workspaceId: number,
): Promise<Scope> {
  const catalog = await catalogs.get(workspaceId);
  const catalogue = await queryCatalogue(db, workspaceId, catalog, 'all');
  return {
    ws: workspaceId,
    filter: { sql: sql<boolean>`true`, tracks: 'all' },
    catalog,
    catalogue,
    userId: null,
    person: {
      currentUserId: null,
      timeZone: null,
      sessionId: null,
      allowedTracks: async () => 'all' as const,
    },
  };
}

/** The editor's own scope, to check the queries they save as they could run them. */
export async function editorScope(
  db: Db,
  catalogs: FieldCatalogs,
  request: FastifyRequest,
): Promise<Scope> {
  const { ws, filter, catalog, catalogue } = await searchScope(db, catalogs, request, false);
  return {
    ws,
    filter,
    catalog,
    catalogue,
    userId: request.user?.id ?? null,
    person: searchPerson(request),
  };
}

/**
 * A query's condition on ticket `k`; ORDER BY is ignored. Throws QueryError or SearchError.
 * `boardId` is the board the query belongs to: its sprints are `@current`, `@next` and
 * `@previous` (QRY-013).
 */
export async function bindCondition(
  db: Db,
  scope: Scope,
  text: string,
  now: Date,
  boardId: number | null = null,
): Promise<Cond> {
  const { person } = scope;
  const query = await expandSavedSearches(db, scope.ws, person.currentUserId, parseQuery(text));
  const names = functionNames(query);
  const logins =
    names.has('currentlogin') || names.has('lastlogin')
      ? await loginTimes(db, scope.ws, person.currentUserId, person.sessionId)
      : undefined;
  const plan = resolveQuery(query, scope.catalogue, {
    currentUserId: person.currentUserId,
    now,
    timeZone: person.timeZone,
    ...(logins ? { logins } : {}),
  });
  const bound = await bindPlan(
    { ...plan, orderBy: [] },
    {
      db,
      workspaceId: scope.ws,
      catalog: scope.catalog,
      catalogue: scope.catalogue,
      currentUserId: person.currentUserId,
      filter: scope.filter.sql,
      allowedTracks: person.allowedTracks,
      boardId,
    },
  );
  return bound.where;
}

const and = (parts: RawBuilder<boolean>[]) =>
  parts.length === 0 ? sql<boolean>`true` : sql<boolean>`(${sql.join(parts, sql` AND `)})`;

/** The CASE that gives each ticket the index of the first condition it meets, else -1. */
function firstMatch(conds: readonly RawBuilder<boolean>[]): RawBuilder<number> {
  if (conds.length === 0) return sql<number>`-1`;
  const whens = conds.map((c, i) => sql`WHEN ${c} THEN ${sql.lit(i)}`);
  return sql<number>`(CASE ${sql.join(whens, sql` `)} ELSE -1 END)`;
}

export interface Compiled {
  /** The board's tickets the viewer sees: filter query AND sub-filter. */
  scope: RawBuilder<boolean>;
  /** The active board filters, ANDed. */
  filters: RawBuilder<boolean>;
  lanes: RawBuilder<boolean>[];
  colours: RawBuilder<boolean>[];
  warnings: string[];
}

const compileContext = (scope: Scope) => ({
  comments: commentReadableSql(scope.ws, scope.userId),
  filter: scope.filter.sql,
  workspaceId: scope.ws,
});

/** The tickets of the workspace the viewer sees, before any query. */
function viewerBase(scope: Scope): RawBuilder<boolean>[] {
  const base: RawBuilder<boolean>[] = [
    sql<boolean>`k.workspace_id = ${scope.ws}::int`,
    sql<boolean>`k.deleted_at IS NULL`,
    scope.filter.sql,
  ];
  if (scope.filter.tracks !== 'all') {
    base.push(sql<boolean>`k.track_id = ANY(${[...scope.filter.tracks]}::int[])`);
  }
  return base;
}

/**
 * Any query's tickets as the viewer sees them, as a condition on the ticket `k` (M1-062: the
 * general reports). An empty query is every ticket they see; a bad one throws, as a search does.
 */
export async function compileQuery(
  db: Db,
  scope: Scope,
  text: string,
  now: Date,
): Promise<RawBuilder<boolean>> {
  const base = viewerBase(scope);
  if (text.trim() !== '') {
    base.push(compileCond(await bindCondition(db, scope, text, now), compileContext(scope)));
  }
  return and(base);
}

/**
 * The board's conditions for a viewer. A bad filter query or sub-filter throws (the board
 * cannot be shown); a lane or colour query the viewer's catalogue cannot read matches nothing
 * and adds a warning, so the rest of the board still shows.
 */
export async function compileBoard(
  db: Db,
  scope: Scope,
  board: BoardRecord,
  active: readonly BoardFilter[],
  now: Date,
): Promise<Compiled> {
  const ctx = compileContext(scope);
  const cond = async (text: string) =>
    compileCond(await bindCondition(db, scope, text, now, board.id), ctx);
  const base = viewerBase(scope);
  base.push(await cond(board.filterQuery));
  if (board.subFilterQuery !== null) base.push(await cond(board.subFilterQuery));
  const filters: RawBuilder<boolean>[] = [];
  for (const f of active) filters.push(await cond(f.query));
  const warnings: string[] = [];
  const lenient = async (label: string, text: string) => {
    try {
      return await cond(text);
    } catch (error) {
      warnings.push(`${label}: ${(error as Error).message}`);
      return sql<boolean>`false`;
    }
  };
  const lanes: RawBuilder<boolean>[] = [];
  if (board.swimlanes.mode === 'queries') {
    for (const lane of board.swimlanes.lanes) {
      lanes.push(await lenient(`Lane "${lane.name}"`, lane.query));
    }
  }
  const colours: RawBuilder<boolean>[] = [];
  if (board.cardRules.colourBy === 'queries') {
    for (const [i, rule] of board.cardRules.colours.entries()) {
      colours.push(await lenient(`Colour rule ${i + 1}`, rule.query));
    }
  }
  return { scope: and(base), filters: and(filters), lanes, colours, warnings };
}

/** The tracks the board's tickets are in, and its location track (for its statuses). */
export async function boardTracks(
  db: Db,
  compiled: Compiled,
  locationTrackId: number | null,
  timeoutMs: number,
): Promise<number[]> {
  const rows = await readOnly(db, timeoutMs, async (trx) => {
    const { rows } = await sql<{ id: number }>`
      SELECT t.id FROM track t
       WHERE t.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM ticket k WHERE k.track_id = t.id AND ${compiled.scope})
       ORDER BY t.id`.execute(trx);
    return rows;
  });
  const ids = new Set(rows.map((r) => r.id));
  if (locationTrackId !== null) ids.add(locationTrackId);
  return [...ids].sort((a, b) => a - b);
}

export interface BoardStatus {
  id: number;
  name: string;
  stage: string;
  order: number;
}

/**
 * The statuses of the workflows the board's tracks use, for every ticket type (a ticket's
 * workflow is the one its track's map gives its type, ADR-045), in status order.
 */
export async function statusesOfTracks(
  db: Db,
  workspaceId: number,
  trackIds: readonly number[],
): Promise<BoardStatus[]> {
  const workflows = new Set<number>();
  const maps = new Set<number>();
  for (const trackId of trackIds) {
    const mapId = await trackMapId(db, workspaceId, trackId);
    if (mapId !== undefined) maps.add(mapId);
  }
  for (const mapId of maps) {
    const map = await loadMap(db, workspaceId, mapId);
    if (map) for (const w of workflowsOf(map)) workflows.add(w);
  }
  const published = await publishedStatuses(db, [...workflows]);
  const ids = new Set<number>();
  for (const w of published.values()) for (const s of w.statuses) ids.add(s);
  if (ids.size === 0) return [];
  const rows = await db
    .selectFrom('status')
    .select(['id', 'name', 'stage', 'sort_order'])
    .where('workspace_id', '=', workspaceId)
    .where('id', 'in', [...ids])
    .orderBy('sort_order')
    .orderBy('id')
    .execute();
  return rows.map((r) => ({ id: r.id, name: r.name, stage: r.stage, order: r.sort_order }));
}

/** Names of statuses by id, for the unmapped panel. */
async function statusNames(db: Db, workspaceId: number, ids: readonly number[]) {
  if (ids.length === 0) return new Map<number, { name: string; stage: string }>();
  const rows = await db
    .selectFrom('status')
    .select(['id', 'name', 'stage'])
    .where('workspace_id', '=', workspaceId)
    .where('id', 'in', [...ids])
    .execute();
  return new Map(rows.map((r) => [r.id, { name: r.name, stage: r.stage }]));
}

export interface CardView {
  id: number;
  key: string;
  summary: string;
  status: { id: number; name: string };
  ticketType: { id: number; name: string; icon: string | null; color: string | null };
  columnId: string;
  laneId: string;
  rank: string;
  version: number;
  /** The colour strip, or null. */
  colour: string | null;
  /** The extra fields the card rules ask for, by name. */
  fields: Record<string, unknown>;
  daysInColumn: number | null;
}

export interface LaneView {
  id: string;
  name: string;
  /** The lane catching what no other lane takes. */
  catchAll: boolean;
  /** Assignee lanes: the person; parent lanes: the parent ticket. */
  assignee?: { id: number; name: string } | null;
  parent?: { id: number; key: string; summary: string } | null;
}

export interface BoardData {
  columns: (Column & {
    /** Tickets in the column, those a board filter hides included (AGL-003 (2)). */
    count: number;
    /** Cards shown in it. */
    shown: number;
    wip: 'over' | 'under' | null;
  })[];
  lanes: LaneView[];
  cards: CardView[];
  /** Tickets in statuses no column takes: hidden, counted here (AGL-002 (2)). */
  unmapped: { count: number; statuses: { id: number; name: string; count: number }[] };
  /** More cards matched than `limit`; the board shows the first ones in rank order. */
  truncated: boolean;
  warnings: string[];
}

/** A card property, for the extra fields of the card rules. */
function cardField(view: TicketView, name: string): unknown {
  const custom = /^cf\[(\d+)\]$/.exec(name);
  if (custom) return view.fields[custom[1] as string] ?? null;
  switch (name) {
    case 'assignee':
      return view.assignee;
    case 'priority':
      return view.priority && { id: view.priority.id, name: view.priority.name };
    case 'parent':
      return view.parent?.key ? view.parent : null;
    case 'track':
      return view.track;
    default:
      return (view as unknown as Record<string, unknown>)[name] ?? null;
  }
}

/** What a card shows of its ticket, from either way of reading it. */
interface CardSource {
  id: number;
  key: string;
  summary: string;
  status: { id: number; name: string };
  ticketType: { id: number; name: string; icon: string | null; color: string | null };
  assignee: { id: number; name: string } | null;
  priority: { id: number; name: string; color: string | null } | null;
  rank: string;
  version: number;
  createdAt: Date;
  fields: Record<string, unknown>;
}

/** Card fields the slim statement reads; any other one needs the full ticket view. */
const SLIM_FIELDS = new Set([
  'assignee',
  'priority',
  'dueDate',
  'startDate',
  'createdAt',
  'updatedAt',
]);

/**
 * The cards' tickets, read again with the viewer's filter (a ticket hidden between the two
 * statements stays hidden). With only slim card fields, one statement of plain joins; else the
 * ticket list's view, custom fields included (`fields: cf[N]`).
 */
async function cardSources(
  db: Db,
  scope: Scope,
  ids: readonly number[],
  fields: readonly string[],
  visibleParents: ReadonlySet<number>,
  catalogs: FieldCatalogs,
): Promise<Map<number, CardSource>> {
  const out = new Map<number, CardSource>();
  if (ids.length === 0) return out;
  const idList = sql<boolean>`k.id = ANY(${[...ids]}::int[])`;
  if (fields.every((f) => SLIM_FIELDS.has(f))) {
    const rows = await db
      .selectFrom('ticket as k')
      .innerJoin('track as t', 't.id', 'k.track_id')
      .innerJoin('ticket_type as ty', 'ty.id', 'k.ticket_type_id')
      .innerJoin('status as st', 'st.id', 'k.status_id')
      .leftJoin('app_user as a', 'a.id', 'k.assignee_id')
      .leftJoin('priority as p', 'p.id', 'k.priority_id')
      .select([
        'k.id',
        'k.number',
        't.key as track_key',
        'k.summary',
        'k.status_id',
        'st.name as status_name',
        'k.ticket_type_id',
        'ty.name as type_name',
        'ty.icon as type_icon',
        'ty.color as type_color',
        'k.assignee_id',
        'a.name as assignee_name',
        'k.priority_id',
        'p.name as priority_name',
        'p.color as priority_color',
        'k.due_date',
        'k.start_date',
        'k.rank',
        'k.version',
        'k.created_at',
        'k.updated_at',
      ])
      .where(idList)
      .where('k.deleted_at', 'is', null)
      .where(scope.filter.sql)
      .execute();
    for (const r of rows) {
      const assignee =
        r.assignee_id === null ? null : { id: r.assignee_id, name: r.assignee_name ?? '' };
      const priority =
        r.priority_id === null
          ? null
          : { id: r.priority_id, name: r.priority_name ?? '', color: r.priority_color ?? null };
      const values: Record<string, unknown> = {
        assignee,
        priority: priority && { id: priority.id, name: priority.name },
        dueDate: r.due_date,
        startDate: r.start_date,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      };
      out.set(r.id, {
        id: r.id,
        key: ticketKey(r.track_key, r.number),
        summary: r.summary,
        status: { id: r.status_id, name: r.status_name },
        ticketType: {
          id: r.ticket_type_id,
          name: r.type_name,
          icon: r.type_icon,
          color: r.type_color,
        },
        assignee,
        priority,
        rank: r.rank,
        version: r.version,
        createdAt: r.created_at,
        fields: Object.fromEntries(fields.map((f) => [f, values[f] ?? null])),
      });
    }
    return out;
  }
  const details = await ticketQuery(db, scope.ws)
    .where(idList)
    .where('k.deleted_at', 'is', null)
    .where(scope.filter.sql)
    .execute();
  const custom = fields.some((f) => f.startsWith('cf['))
    ? await customFieldViews(db, scope.ws, await catalogs.get(scope.ws), details)
    : new Map<number, Record<string, JsonValue>>();
  for (const d of details) {
    const view = ticketView(
      d,
      d.parent_id !== null && visibleParents.has(d.parent_id),
      (custom.get(d.id) ?? {}) as Record<string, JsonValue>,
    );
    out.set(d.id, {
      id: view.id,
      key: view.key,
      summary: view.summary,
      status: { id: view.status.id, name: view.status.name },
      ticketType: {
        id: view.ticketType.id,
        name: view.ticketType.name,
        icon: view.ticketType.icon,
        color: view.ticketType.color,
      },
      assignee: view.assignee && { id: view.assignee.id, name: view.assignee.name },
      priority: view.priority && {
        id: view.priority.id,
        name: view.priority.name,
        color: view.priority.color,
      },
      rank: view.rank,
      version: view.version,
      createdAt: d.created_at,
      fields: Object.fromEntries(fields.map((f) => [f, cardField(view, f)])),
    });
  }
  return out;
}

/** A stable colour for an id (type, priority or person), from a fixed palette of tokens. */
const PALETTE = ['#2f6fdb', '#1f8a5b', '#b25e09', '#8a3ffc', '#c4314b', '#00828a', '#5c6b7a'];
const paletteColour = (n: number) => PALETTE[n % PALETTE.length] as string;

export async function loadBoardData(input: {
  db: Db;
  request: FastifyRequest;
  catalogs: FieldCatalogs;
  scope: Scope;
  board: BoardRecord;
  active: readonly BoardFilter[];
  limit: number;
  timeoutMs: number;
  now?: Date;
  /** On a Scrum board, only the tickets of these sprints (the active ones, M1-044). */
  sprintIds?: readonly number[];
}): Promise<BoardData> {
  const { db, request, scope, board, limit, timeoutMs } = input;
  const now = input.now ?? new Date();
  const columns = board.columns;
  const columnOf = new Map<number, string>();
  for (const c of columns) for (const s of c.statusIds) columnOf.set(s, c.id);
  const mapped = [...columnOf.keys()];
  const nothing = scope.filter.tracks !== 'all' && scope.filter.tracks.length === 0;
  const compiled = await compileBoard(db, scope, board, input.active, now);
  if (input.sprintIds !== undefined) {
    compiled.scope = and([
      compiled.scope,
      sql<boolean>`k.id IN (SELECT st.ticket_id FROM sprint_ticket st
        WHERE st.sprint_id = ANY(${[...input.sprintIds]}::int[]))`,
    ]);
  }

  interface CardRow {
    id: number;
    status_id: number;
    parent_id: number | null;
    assignee_id: number | null;
    lane: number;
    colour: number;
  }
  const { counts, rows } = nothing
    ? { counts: [] as { status_id: number; n: number }[], rows: [] as CardRow[] }
    : await readOnly(db, timeoutMs, async (trx) => {
        const counted = await sql<{ status_id: number; n: number }>`
          SELECT k.status_id, count(*)::int AS n FROM ticket k
           WHERE ${compiled.scope} GROUP BY k.status_id`.execute(trx);
        const cards =
          mapped.length === 0
            ? { rows: [] as CardRow[] }
            : await sql<CardRow>`
          SELECT k.id, k.status_id, k.parent_id, k.assignee_id,
                 ${firstMatch(compiled.lanes)} AS lane, ${firstMatch(compiled.colours)} AS colour
            FROM ticket k
           WHERE ${compiled.scope} AND ${compiled.filters}
             AND k.status_id = ANY(${mapped}::int[])
           ORDER BY k.rank
           LIMIT ${limit + 1}`.execute(trx);
        return { counts: counted.rows, rows: cards.rows };
      });
  const truncated = rows.length > limit;
  const shownRows = rows.slice(0, limit);

  // Counts per column, and the unmapped panel.
  const perColumn = new Map<string, number>();
  const unmappedCounts: { id: number; count: number }[] = [];
  for (const c of counts) {
    const column = columnOf.get(c.status_id);
    if (column) perColumn.set(column, (perColumn.get(column) ?? 0) + c.n);
    else unmappedCounts.push({ id: c.status_id, count: c.n });
  }
  const unmappedNames = await statusNames(
    db,
    scope.ws,
    unmappedCounts.map((u) => u.id),
  );

  // The cards' details, read again with the viewer's filter: a slim statement when the card
  // rules ask only for what it reads, the ticket list's full view otherwise.
  const ids = shownRows.map((r) => r.id);
  const parentIds = [
    ...new Set(shownRows.flatMap((r) => (r.parent_id === null ? [] : [r.parent_id]))),
  ];
  const visibleParents = await request.authz.visibleTickets(parentIds);
  const sources = await cardSources(
    db,
    scope,
    ids,
    board.cardRules.fields,
    visibleParents,
    input.catalogs,
  );

  // Days in column: from the status changes of the cards shown.
  const entered = new Map<number, Date>();
  if (board.cardRules.daysInColumn && ids.length > 0) {
    const changes = await db
      .selectFrom('ticket_change')
      .select(['ticket_id', 'from_value', 'to_value', 'at'])
      .where(sql<boolean>`ticket_id = ANY(${ids}::int[])`)
      .where('field', '=', 'status')
      .orderBy('ticket_id')
      .orderBy('at')
      .orderBy('id')
      .execute();
    const grouped = new Map<number, { from: number | null; to: number | null; at: Date }[]>();
    for (const c of changes) {
      const list = grouped.get(c.ticket_id) ?? [];
      list.push({
        from: c.from_value === null ? null : Number(c.from_value),
        to: c.to_value === null ? null : Number(c.to_value),
        at: c.at,
      });
      grouped.set(c.ticket_id, list);
    }
    for (const r of shownRows) {
      const d = sources.get(r.id);
      if (!d) continue;
      entered.set(
        r.id,
        enteredColumn(
          (s) => columnOf.get(s) ?? null,
          r.status_id,
          d.createdAt,
          grouped.get(r.id) ?? [],
        ),
      );
    }
  }

  // Lanes.
  const lanes: LaneView[] = [];
  const laneOf = new Map<number, string>();
  const mode = board.swimlanes.mode;
  if (mode === 'none') {
    lanes.push({ id: 'all', name: '', catchAll: true });
    for (const r of shownRows) laneOf.set(r.id, 'all');
  } else if (mode === 'queries') {
    for (const lane of board.swimlanes.lanes) {
      lanes.push({ id: lane.id, name: lane.name, catchAll: false });
    }
    lanes.push({ id: 'other', name: board.swimlanes.otherName, catchAll: true });
    for (const r of shownRows) {
      laneOf.set(r.id, r.lane >= 0 ? (board.swimlanes.lanes[r.lane]?.id ?? 'other') : 'other');
    }
  } else if (mode === 'assignees') {
    const people = new Map<number, string>();
    for (const r of shownRows) {
      const d = sources.get(r.id);
      if (d && r.assignee_id !== null) people.set(r.assignee_id, d.assignee?.name ?? '');
    }
    const named = [...people.entries()]
      .sort(([a, an], [b, bn]) => an.localeCompare(bn) || a - b)
      .map(([id, name]) => ({
        id: `user-${id}`,
        name,
        catchAll: false,
        assignee: { id, name },
      }));
    const unassigned: LaneView = {
      id: 'unassigned',
      name: 'Unassigned',
      catchAll: true,
      assignee: null,
    };
    lanes.push(
      ...(board.swimlanes.unassigned === 'first' ? [unassigned, ...named] : [...named, unassigned]),
    );
    for (const r of shownRows) {
      laneOf.set(r.id, r.assignee_id === null ? 'unassigned' : `user-${r.assignee_id}`);
    }
  } else {
    // By parent: lanes in the parents' rank order, then tickets without a (visible) parent.
    const seen = parentIds.filter((p) => visibleParents.has(p));
    const parents =
      seen.length === 0
        ? []
        : await db
            .selectFrom('ticket as p')
            .innerJoin('track as t', 't.id', 'p.track_id')
            .select(['p.id', 'p.number', 'p.summary', 't.key'])
            .where(sql<boolean>`p.id = ANY(${seen}::int[])`)
            .orderBy('p.rank')
            .orderBy('p.id')
            .execute();
    for (const p of parents) {
      lanes.push({
        id: `parent-${p.id}`,
        name: p.summary,
        catchAll: false,
        parent: { id: p.id, key: `${p.key}-${p.number}`, summary: p.summary },
      });
    }
    lanes.push({ id: 'other', name: board.swimlanes.otherName, catchAll: true, parent: null });
    for (const r of shownRows) {
      laneOf.set(
        r.id,
        r.parent_id !== null && visibleParents.has(r.parent_id) ? `parent-${r.parent_id}` : 'other',
      );
    }
  }

  const cards: CardView[] = [];
  const shownPerColumn = new Map<string, number>();
  for (const r of shownRows) {
    const view = sources.get(r.id);
    if (!view) continue;
    const columnId = columnOf.get(r.status_id) as string;
    shownPerColumn.set(columnId, (shownPerColumn.get(columnId) ?? 0) + 1);
    let colour: string | null = null;
    switch (board.cardRules.colourBy) {
      case 'type':
        colour = view.ticketType.color ?? paletteColour(view.ticketType.id);
        break;
      case 'priority':
        colour = view.priority ? (view.priority.color ?? paletteColour(view.priority.id)) : null;
        break;
      case 'assignee':
        colour = view.assignee ? paletteColour(view.assignee.id) : null;
        break;
      case 'queries':
        colour = r.colour >= 0 ? (board.cardRules.colours[r.colour]?.colour ?? null) : null;
        break;
      default:
        colour = null;
    }
    const since = entered.get(r.id);
    cards.push({
      id: view.id,
      key: view.key,
      summary: view.summary,
      status: view.status,
      ticketType: view.ticketType,
      columnId,
      laneId: laneOf.get(r.id) ?? 'other',
      rank: view.rank,
      version: view.version,
      colour,
      fields: view.fields,
      daysInColumn: since
        ? Math.max(0, Math.floor((now.getTime() - since.getTime()) / 86_400_000))
        : null,
    });
  }

  return {
    columns: columns.map((c) => {
      const count = perColumn.get(c.id) ?? 0;
      return { ...c, count, shown: shownPerColumn.get(c.id) ?? 0, wip: wipState(c, count) };
    }),
    lanes,
    cards,
    unmapped: {
      count: unmappedCounts.reduce((sum, u) => sum + u.count, 0),
      statuses: unmappedCounts
        .map((u) => ({ id: u.id, name: unmappedNames.get(u.id)?.name ?? '', count: u.count }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
    },
    truncated,
    warnings: compiled.warnings,
  };
}
