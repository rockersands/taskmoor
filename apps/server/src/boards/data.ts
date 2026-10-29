import type { Database, JsonValue } from '@taskmoor/db';
import { type Catalogue, parseQuery, resolveQuery } from '@taskmoor/query';
import type { FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import type { Catalog, FieldCatalogs } from '../fields/catalog';
import { customFieldViews } from '../fields/values';
import { searchScope } from '../routes/search';
import { bindPlan } from '../search/bind';
import { queryCatalogue } from '../search/catalogue';
import { compileCond } from '../search/compile';
import type { Cond } from '../search/model';
import { readOnly } from '../search/run';
import { commentReadableSql } from '../tickets/comments';
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

export interface Scope {
  ws: number;
  filter: { sql: RawBuilder<boolean>; tracks: readonly number[] | 'all' };
  catalog: Catalog;
  catalogue: Catalogue;
  userId: number | null;
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
  return { ws, filter, catalog, catalogue, userId: request.user?.id ?? null };
}

/** The editor's own scope, to check the queries they save as they could run them. */
export async function editorScope(
  db: Db,
  catalogs: FieldCatalogs,
  request: FastifyRequest,
): Promise<Scope> {
  const { ws, filter, catalog, catalogue } = await searchScope(db, catalogs, request, false);
  return { ws, filter, catalog, catalogue, userId: request.user?.id ?? null };
}

/** A query's condition on ticket `k`; ORDER BY is ignored. Throws QueryError or SearchError. */
export async function bindCondition(db: Db, scope: Scope, text: string, now: Date): Promise<Cond> {
  const plan = resolveQuery(parseQuery(text), scope.catalogue, {
    currentUserId: scope.userId,
    now,
  });
  const bound = await bindPlan(
    { ...plan, orderBy: [] },
    { db, workspaceId: scope.ws, catalog: scope.catalog, catalogue: scope.catalogue },
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
  const ctx = { comments: commentReadableSql(scope.ws, scope.userId) };
  const cond = async (text: string) => compileCond(await bindCondition(db, scope, text, now), ctx);
  const base: RawBuilder<boolean>[] = [
    sql<boolean>`k.workspace_id = ${scope.ws}::int`,
    sql<boolean>`k.deleted_at IS NULL`,
    scope.filter.sql,
  ];
  if (scope.filter.tracks !== 'all') {
    base.push(sql<boolean>`k.track_id = ANY(${[...scope.filter.tracks]}::int[])`);
  }
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
}): Promise<BoardData> {
  const { db, request, scope, board, limit, timeoutMs } = input;
  const now = input.now ?? new Date();
  const columns = board.columns;
  const columnOf = new Map<number, string>();
  for (const c of columns) for (const s of c.statusIds) columnOf.set(s, c.id);
  const mapped = [...columnOf.keys()];
  const nothing = scope.filter.tracks !== 'all' && scope.filter.tracks.length === 0;
  const compiled = await compileBoard(db, scope, board, input.active, now);

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
           ORDER BY k.rank, k.id
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

  // The cards' details, read again with the viewer's filter.
  const ids = shownRows.map((r) => r.id);
  const details =
    ids.length === 0
      ? []
      : await ticketQuery(db, scope.ws)
          .where('k.id', 'in', ids)
          .where('k.deleted_at', 'is', null)
          .where(scope.filter.sql)
          .execute();
  const byId = new Map(details.map((d) => [d.id, d]));
  const parentIds = [
    ...new Set(shownRows.flatMap((r) => (r.parent_id === null ? [] : [r.parent_id]))),
  ];
  const visibleParents = await request.authz.visibleTickets(parentIds);
  const wantsCustom = board.cardRules.fields.some((f) => f.startsWith('cf['));
  const custom = wantsCustom
    ? await customFieldViews(db, scope.ws, await input.catalogs.get(scope.ws), details)
    : new Map<number, Record<string, JsonValue>>();

  // Days in column: from the status changes of the cards shown.
  const entered = new Map<number, Date>();
  if (board.cardRules.daysInColumn && ids.length > 0) {
    const changes = await db
      .selectFrom('ticket_change')
      .select(['ticket_id', 'from_value', 'to_value', 'at'])
      .where('ticket_id', 'in', ids)
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
      const d = byId.get(r.id);
      if (!d) continue;
      entered.set(
        r.id,
        enteredColumn(
          (s) => columnOf.get(s) ?? null,
          r.status_id,
          d.created_at,
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
      const d = byId.get(r.id);
      if (d && r.assignee_id !== null) people.set(r.assignee_id, d.assignee_name ?? '');
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
            .where('p.id', 'in', seen)
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
    const d = byId.get(r.id);
    if (!d) continue;
    const view = ticketView(
      d,
      d.parent_id !== null && visibleParents.has(d.parent_id),
      (custom.get(d.id) ?? {}) as Record<string, JsonValue>,
    );
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
      status: { id: view.status.id, name: view.status.name },
      ticketType: {
        id: view.ticketType.id,
        name: view.ticketType.name,
        icon: view.ticketType.icon,
        color: view.ticketType.color,
      },
      columnId,
      laneId: laneOf.get(r.id) ?? 'other',
      rank: view.rank,
      version: view.version,
      colour,
      fields: Object.fromEntries(board.cardRules.fields.map((f) => [f, cardField(view, f)])),
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
