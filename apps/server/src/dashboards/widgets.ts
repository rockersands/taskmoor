import type { Database } from '@taskmoor/db';
import { localDate, parseQuery, printQuery } from '@taskmoor/query';
import type { FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { boardScope, compileQuery, type Scope } from '../boards/data';
import { trackBoardQuery } from '../boards/one-per-track';
import type { FieldCatalogs } from '../fields/catalog';
import { readStatusChanges } from '../reports/events';
import { datesBetween, dayEnd, dayStart, timeInStatus } from '../reports/flow';
import {
  type Axis,
  averageAge,
  createdVsClosed,
  groupBy,
  oneDimensional,
  type Period,
  parseAxis,
  periodsBetween,
  timeSince,
  timeToClose,
  timeTracking,
  twoDimensional,
  workload,
} from '../reports/general';
import { viewerTimeZone } from '../reports/zone';
import { visibleBoardRecord } from '../routes/boards';
import { searchPerson } from '../routes/search';
import {
  hasStarted,
  type SprintRow,
  sprintBurndown,
  sprintQuery,
  sprintView,
} from '../routes/sprints';
import { prepareSearch, readOnly, runPage } from '../search/run';
import { priorityLevels } from '../tickets/priority-level';
import { timeSettings } from '../tickets/time';
import type { Widget, WidgetSettings } from './model';

/**
 * A widget's data, computed as the viewer from its settings (M1-064; RPT-004 (1), RPT-005;
 * ADR-060): every query runs with the viewer's ticket filter, every board is checked as theirs,
 * so a shared dashboard shows each person only what they may see. A widget that cannot show
 * anything says why (`unavailable`): a board or sprint the viewer does not see, a field that
 * does not group, no active sprint.
 */
export interface WidgetContext {
  db: Kysely<Database>;
  catalogs: FieldCatalogs;
  timeoutMs: number;
  request: FastifyRequest;
  /**
   * The track whose page shows the widget (ADR-116): there an empty query means that track, not
   * every ticket, and the viewer's own lists stay inside it. The viewer's filter still applies.
   */
  track?: { key: string };
  /**
   * The viewer's own filter on a track's Summary (T-075a; RPT-006 "view and filter"): a condition
   * every query the widget runs must also meet. It narrows, never widens, and changes nothing
   * saved. Widgets that read a sprint rather than a query (burndown, health, days remaining) are
   * not narrowed.
   */
  filter?: string;
}

/**
 * A query that also meets `filter` (T-075a): both conditions joined by AND, each kept whole (an OR
 * in either stays inside its own brackets), in the query's own order; the filter's order, if it
 * has one, is ignored. Throws QueryError when either does not read, as a search would.
 */
export function narrowQuery(query: string, filter: string | undefined): string {
  if (filter === undefined || filter.trim() === '') return query;
  const extra = parseQuery(filter).where;
  if (!extra) return query;
  const base = parseQuery(query);
  const where = base.where
    ? { kind: 'and' as const, items: [base.where, extra], span: { start: 0, end: 0 } }
    : extra;
  return printQuery({ where, orderBy: base.orderBy });
}

export type Unavailable = {
  unavailable:
    | 'board_not_found'
    | 'not_scrum'
    | 'no_active_sprint'
    | 'sprint_not_found'
    | 'field'
    | 'time_tracking_off';
};

/** Running totals of a list of counts. */
const running = (list: readonly number[]) => {
  let n = 0;
  return list.map((v) => {
    n += v;
    return n;
  });
};

/** Not in a status of the closed stage: the one definition of done (ADR-120), as search's `stage`. */
const OPEN = sql<boolean>`NOT EXISTS (SELECT 1 FROM status st
                                       WHERE st.id = k.status_id AND st.stage = 'closed')`;
/** Targets the release, as search's `targetRelease`. */
const targets = (release: number) =>
  sql<boolean>`EXISTS (SELECT 1 FROM ticket_release tr
                        WHERE tr.ticket_id = k.id AND tr.role = 'target'
                          AND tr.release_id = ${release}::int)`;

const ASSIGNED =
  'assignee = currentUser() AND closeReason IS EMPTY ORDER BY priority DESC, updated DESC';
const FOLLOWED = 'follower = currentUser() ORDER BY updated DESC';
const DAY = 86_400_000;

/** A custom field's name, which heads a table counted by it; a system field's name is the app's. */
const fieldName = (axis: Axis, s: Scope) =>
  axis.kind === 'custom' ? { fieldName: s.catalog.fields.get(axis.fieldId)?.name ?? null } : {};

/** A value as the query language reads it: a quoted string with its quotes escaped. */
const quoted = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The system fields whose names are unique on the site, so a search may name their values. Ticket
 * types are not: a local-mode track's type may share its name with a shared one (T-359).
 */
const NAMED_AXES: ReadonlySet<string> = new Set(['status', 'priority', 'closeReason']);

/** The order grouped tickets lists each group in, most recently updated first (`groupBy`). */
const GROUP_ORDER = parseQuery('ORDER BY updated DESC').orderBy;

/**
 * The search that finds every ticket of one value of a grouped report (S3-ST-2): the report's own
 * query, narrowed to the value. A name where the catalogue's names are unique (statuses,
 * priorities, close reasons, groups), a label's text, and otherwise an id, which a bare number is
 * before a name (people, types, releases, areas, teams, options); no value is `IS EMPTY`. It lists
 * the tickets in the report's order, so its first ones are the ones the group shows (T-359). The
 * rest gathered as other has no single search: null.
 */
export function valueQuery(
  query: string,
  field: string,
  axis: Axis,
  value: { id: string | null; name: string | null; kind: 'value' | 'none' | 'other' },
): string | null {
  if (value.kind === 'other' || axis.kind === 'all') return null;
  let condition: string;
  if (value.kind === 'none' || value.id === null) {
    condition = `${field} IS EMPTY`;
  } else {
    const text = axis.kind === 'system' ? axis.field === 'labels' : axis.values === 'label';
    const named = axis.kind === 'system' ? NAMED_AXES.has(axis.field) : axis.values === 'group';
    const literal = text
      ? quoted(value.id)
      : named && value.name !== null
        ? quoted(value.name)
        : value.id;
    condition = `${field} = ${literal}`;
  }
  return printQuery({
    where: parseQuery(narrowQuery(query, condition)).where,
    orderBy: GROUP_ORDER,
  });
}

/** The viewer's time zone: their browser's, else their profile's, else UTC (T-272). */
const zoneOf = (request: FastifyRequest): string => viewerTimeZone(request);

/** The last `days` local days up to today, as dates and instants. */
function window(request: FastifyRequest, days: number) {
  const timeZone = zoneOf(request);
  const now = Date.now();
  const to = localDate(new Date(now), timeZone);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY)
    .toISOString()
    .slice(0, 10);
  return {
    timeZone,
    from,
    to,
    start: new Date(dayStart(from, timeZone)),
    end: new Date(Math.min(dayEnd(to, timeZone), now)),
    now,
  };
}

/** The first tickets of a query, as the search page orders them. */
async function ticketList(ctx: WidgetContext, scope: Scope, q: string, limit: number) {
  const { db, request, timeoutMs } = ctx;
  const { compiled } = await prepareSearch({
    db,
    workspaceId: scope.ws,
    catalog: scope.catalog,
    catalogue: scope.catalogue,
    filter: scope.filter,
    q,
    ...searchPerson(request),
  });
  const page = await runPage(db, compiled, { limit, count: true, timeoutMs });
  const rows =
    page.ids.length === 0
      ? []
      : (
          await sql<{
            id: number;
            key: string;
            summary: string;
            status: string;
            priority: string | null;
            priority_id: number | null;
            type: string;
            type_icon: string | null;
            assignee: string | null;
            updated_at: Date;
          }>`
            SELECT k.id, t.key || '-' || k.number AS key, k.summary, s.name AS status,
                   p.name AS priority, k.priority_id, y.name AS type, y.icon AS type_icon,
                   u.name AS assignee, k.updated_at
              FROM ticket k
              JOIN track t ON t.id = k.track_id
              JOIN status s ON s.id = k.status_id
              JOIN ticket_type y ON y.id = k.ticket_type_id
              LEFT JOIN priority p ON p.id = k.priority_id
              LEFT JOIN app_user u ON u.id = k.assignee_id
             WHERE k.id = ANY(${page.ids}::int[])`.execute(db)
        ).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const levels = await priorityLevels(db, scope.ws);
  return {
    tickets: page.ids.flatMap((id) => {
      const r = byId.get(id);
      return r
        ? [
            {
              id: r.id,
              key: r.key,
              summary: r.summary,
              status: r.status,
              type: r.type,
              typeIcon: r.type_icon,
              priority: r.priority,
              priorityLevel: r.priority_id === null ? null : (levels.get(r.priority_id) ?? 4),
              assignee: r.assignee,
              updatedAt: r.updated_at.toISOString(),
            },
          ]
        : [];
    }),
    total: page.total ?? { count: page.ids.length, exact: true },
  };
}

/** The instant each period ends: the next one's start, or now for the last. */
function periodEnds(periods: readonly string[], to: string, timeZone: string, now: number) {
  return periods.map((_, i) => {
    const next = periods[i + 1];
    return new Date(Math.min(next ? dayStart(next, timeZone) : dayEnd(to, timeZone), now));
  });
}

/** The board's sprint the widget follows: the chosen one, or the first active one. */
async function widgetSprint(
  ctx: WidgetContext,
  config: { boardId: number; sprintId?: number | null },
): Promise<
  | { board: NonNullable<Awaited<ReturnType<typeof visibleBoardRecord>>>; sprint: SprintRow }
  | Unavailable
> {
  const board = await visibleBoardRecord(ctx.db, ctx.request, config.boardId);
  if (!board) return { unavailable: 'board_not_found' };
  if (board.kind !== 'scrum') return { unavailable: 'not_scrum' };
  let q = sprintQuery(ctx.db, ctx.request.workspaceId).where('board_id', '=', board.record.id);
  q =
    config.sprintId !== undefined && config.sprintId !== null
      ? q.where('id', '=', config.sprintId)
      : q.where('state', '=', 'active').orderBy('started_at').orderBy('id');
  const sprint = await q.executeTakeFirst();
  if (!sprint) {
    return { unavailable: config.sprintId ? 'sprint_not_found' : 'no_active_sprint' };
  }
  return { board, sprint };
}

export async function widgetData(ctx: WidgetContext, widget: Widget): Promise<unknown> {
  const { db, request, catalogs } = ctx;
  const ws = request.workspaceId;
  const inTrack = ctx.track ? trackBoardQuery(ctx.track.key) : null;
  const blank = typeof widget.config.query === 'string' && widget.config.query.trim() === '';
  const given = inTrack && blank ? { ...widget.config, query: inTrack } : widget.config;
  // The viewer's own filter narrows every query the widget runs (T-075a).
  const config =
    ctx.filter && typeof given.query === 'string'
      ? { ...given, query: narrowQuery(given.query, ctx.filter) }
      : given;
  const within = (q: string) => narrowQuery(inTrack ? `${inTrack} AND ${q}` : q, ctx.filter);
  const scope = () => boardScope(db, catalogs, request);
  const where = async (q: string) => compileQuery(db, await scope(), q, new Date());
  // Reads run read-only under the search time limit.
  const read = <T>(work: (trx: Transaction<Database>) => Promise<T>) =>
    readOnly(db, ctx.timeoutMs, work);
  switch (widget.kind) {
    case 'introduction':
    case 'quick-links':
    case 'track-summary':
      return null;
    case 'search-results': {
      const c = config as WidgetSettings<'search-results'>;
      return ticketList(ctx, await scope(), c.query, c.limit);
    }
    case 'assigned-to-me':
      return ticketList(
        ctx,
        await scope(),
        within(ASSIGNED),
        (config as WidgetSettings<'assigned-to-me'>).limit,
      );
    case 'followed-tickets':
      return ticketList(
        ctx,
        await scope(),
        within(FOLLOWED),
        (config as WidgetSettings<'followed-tickets'>).limit,
      );
    case 'created-vs-closed':
    case 'recently-created': {
      const c = config as WidgetSettings<'created-vs-closed'>;
      const w = window(request, c.days);
      const condition = await where(c.query);
      const counts = await read((trx) =>
        createdVsClosed(trx, {
          workspaceId: ws,
          scope: condition,
          from: w.from,
          to: w.to,
          start: w.start,
          end: w.end,
          timeZone: w.timeZone,
          period: c.period as Period,
        }),
      );
      if (widget.kind === 'recently-created') {
        return { timeZone: w.timeZone, periods: counts.periods, created: counts.created };
      }
      return {
        timeZone: w.timeZone,
        periods: counts.periods,
        created: c.cumulative ? running(counts.created) : counts.created,
        closed: c.cumulative ? running(counts.closed) : counts.closed,
        cumulative: c.cumulative,
      };
    }
    case 'average-age': {
      const c = config as WidgetSettings<'average-age'>;
      const w = window(request, c.days);
      const periods = periodsBetween(w.from, w.to, c.period as Period);
      const condition = await where(c.query);
      const ages = await read((trx) =>
        averageAge(trx, { scope: condition, ends: periodEnds(periods, w.to, w.timeZone, w.now) }),
      );
      return {
        timeZone: w.timeZone,
        periods,
        age: ages.map((a) => a.age),
        open: ages.map((a) => a.open),
      };
    }
    case 'time-to-close': {
      const c = config as WidgetSettings<'time-to-close'>;
      const w = window(request, c.days);
      const condition = await where(c.query);
      return {
        timeZone: w.timeZone,
        ...(await read((trx) =>
          timeToClose(trx, {
            workspaceId: ws,
            scope: condition,
            from: w.from,
            to: w.to,
            start: w.start,
            end: w.end,
            timeZone: w.timeZone,
            period: c.period as Period,
          }),
        )),
      };
    }
    case 'pie':
    case 'ticket-statistics': {
      const c = config as WidgetSettings<'ticket-statistics'>;
      const s = await scope();
      const axis = parseAxis(c.field, s);
      if (typeof axis === 'string') return { unavailable: 'field' } satisfies Unavailable;
      const condition = await compileQuery(db, s, c.query, new Date());
      const counted = await read((trx) =>
        oneDimensional(trx, { workspaceId: ws, scope: condition, axis }),
      );
      if (widget.kind === 'ticket-statistics' && c.sort === 'total') {
        const rank = (kind: string) => (kind === 'value' ? 0 : 1);
        counted.values.sort((a, b) => rank(a.kind) - rank(b.kind) || b.total - a.total);
      }
      return { field: c.field, ...fieldName(axis, s), ...counted };
    }
    case 'two-dimensional': {
      const c = config as WidgetSettings<'two-dimensional'>;
      const s = await scope();
      const x = parseAxis(c.x, s);
      const y = parseAxis(c.y, s);
      if (typeof x === 'string' || typeof y === 'string') {
        return { unavailable: 'field' } satisfies Unavailable;
      }
      const condition = await compileQuery(db, s, c.query, new Date());
      const custom = (a: Axis) =>
        a.kind === 'custom' ? (s.catalog.fields.get(a.fieldId)?.name ?? null) : null;
      return {
        fields: { x: c.x, y: c.y },
        // A custom field's name heads its rows or columns; a system field's name is the app's.
        fieldNames: { x: custom(x), y: custom(y) },
        ...(await read((trx) => twoDimensional(trx, { workspaceId: ws, scope: condition, x, y }))),
      };
    }
    case 'time-since': {
      const c = config as WidgetSettings<'time-since'>;
      const w = window(request, c.days);
      const condition = await where(c.query);
      const counted = await read((trx) =>
        timeSince(trx, {
          scope: condition,
          field: c.field,
          from: w.from,
          to: w.to,
          start: w.start,
          end: w.end,
          timeZone: w.timeZone,
          period: c.period as Period,
        }),
      );
      return {
        timeZone: w.timeZone,
        field: c.field,
        periods: counted.periods,
        counts: c.cumulative ? running(counted.counts) : counted.counts,
        cumulative: c.cumulative,
      };
    }
    case 'group-by': {
      const c = config as WidgetSettings<'group-by'>;
      const s = await scope();
      const axis = parseAxis(c.field, s);
      if (typeof axis === 'string') return { unavailable: 'field' } satisfies Unavailable;
      const condition = await compileQuery(db, s, c.query, new Date());
      const grouped = await read((trx) =>
        groupBy(trx, { workspaceId: ws, scope: condition, axis, limit: c.limit }),
      );
      return {
        field: c.field,
        ...fieldName(axis, s),
        ...grouped,
        // Each group names the search that finds all of it, past the tickets listed (S3-ST-2).
        values: grouped.values.map((v) => ({
          ...v,
          query: valueQuery(c.query, c.field, axis, v),
        })),
      };
    }
    case 'workload': {
      const c = config as WidgetSettings<'workload'>;
      const s = await scope();
      const axis = parseAxis(c.field, s);
      if (typeof axis === 'string') return { unavailable: 'field' } satisfies Unavailable;
      let condition = await compileQuery(db, s, c.query, new Date());
      if (c.open) condition = sql<boolean>`${condition} AND ${OPEN}`;
      if (c.release !== null) condition = sql<boolean>`${condition} AND ${targets(c.release)}`;
      const added = await read((trx) =>
        workload(trx, { workspaceId: ws, scope: condition, axis, statistic: c.statistic }),
      );
      return {
        field: c.field,
        ...fieldName(axis, s),
        statistic: c.statistic,
        open: c.open,
        release: c.release,
        ...added,
      };
    }
    case 'time-tracking': {
      const c = config as WidgetSettings<'time-tracking'>;
      if (!(await timeSettings(db, ws)).enabled) {
        return { unavailable: 'time_tracking_off' } satisfies Unavailable;
      }
      let condition = await where(c.query);
      if (c.release !== null) condition = sql<boolean>`${condition} AND ${targets(c.release)}`;
      return {
        release: c.release,
        ...(await read((trx) => timeTracking(trx, { scope: condition, limit: c.limit }))),
      };
    }
    case 'sprint-burndown':
    case 'sprint-health': {
      const found = await widgetSprint(ctx, config as WidgetSettings<'sprint-burndown'>);
      if ('unavailable' in found) return found;
      const { board, sprint } = found;
      if (!hasStarted(sprint)) return { unavailable: 'no_active_sprint' } satisfies Unavailable;
      const chart = await sprintBurndown(db, catalogs, request, sprint, board, zoneOf(request));
      if (widget.kind === 'sprint-burndown')
        return { board: { id: board.record.id, name: board.name }, ...chart };
      const startMs = sprint.started_at.getTime();
      const span = Math.max(1, sprint.end_at.getTime() - startMs);
      const at = Math.min(Date.now(), sprint.completed_at?.getTime() ?? Date.now());
      return {
        board: { id: board.record.id, name: board.name },
        sprint: chart.sprint,
        statistic: chart.statistic,
        /** Fractions from 0 to 1 (the time may run past 1 when a sprint overruns). */
        elapsed: Math.max(0, (at - startMs) / span),
        completed: chart.end.scope === 0 ? 0 : chart.end.completed / chart.end.scope,
        scopeChange:
          chart.start.scope === 0 ? 0 : (chart.end.scope - chart.start.scope) / chart.start.scope,
        remaining: chart.end.remaining,
        scope: chart.end.scope,
      };
    }
    case 'days-remaining': {
      const found = await widgetSprint(ctx, config as WidgetSettings<'days-remaining'>);
      if ('unavailable' in found) return found;
      const { board, sprint } = found;
      if (!hasStarted(sprint)) return { unavailable: 'no_active_sprint' } satisfies Unavailable;
      const timeZone = zoneOf(request);
      const today = localDate(new Date(), timeZone);
      const last = localDate(sprint.end_at, timeZone);
      return {
        board: { id: board.record.id, name: board.name },
        sprint: sprintView(sprint),
        timeZone,
        daysRemaining: last < today ? 0 : datesBetween(today, last).length - 1,
      };
    }
    case 'average-time-in-status': {
      const c = config as WidgetSettings<'average-time-in-status'>;
      const w = window(request, c.days);
      const condition = await where(c.query);
      const tickets = await read(async (trx) => {
        const { rows } = await sql<{ id: number }>`
          SELECT k.id FROM ticket k WHERE ${condition}`.execute(trx);
        return readStatusChanges(
          trx,
          ws,
          rows.map((r) => r.id),
          w.end,
        );
      });
      const totals = timeInStatus({ tickets, from: w.start.getTime(), to: w.end.getTime() });
      const names =
        totals.length === 0
          ? []
          : await db
              .selectFrom('status')
              .select(['id', 'name', 'sort_order'])
              .where('workspace_id', '=', ws)
              .where(
                'id',
                'in',
                totals.map((t) => t.statusId),
              )
              .execute();
      const byId = new Map(names.map((n) => [n.id, n]));
      return {
        timeZone: w.timeZone,
        statuses: totals
          .filter((t) => byId.has(t.statusId))
          .sort(
            (a, b) =>
              (byId.get(a.statusId)?.sort_order ?? 0) - (byId.get(b.statusId)?.sort_order ?? 0) ||
              a.statusId - b.statusId,
          )
          .map((t) => ({
            status: { id: t.statusId, name: byId.get(t.statusId)?.name ?? '' },
            tickets: t.tickets,
            average: t.tickets === 0 ? 0 : Math.round(t.total / t.tickets / 1000),
            entries: t.entries,
          })),
      };
    }
  }
}
