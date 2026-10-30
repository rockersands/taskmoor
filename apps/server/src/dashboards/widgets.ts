import type { Database } from '@taskmoor/db';
import { knownTimeZone, localDate } from '@taskmoor/query';
import type { FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { boardScope, compileQuery, type Scope } from '../boards/data';
import type { FieldCatalogs } from '../fields/catalog';
import { readStatusChanges } from '../reports/events';
import { datesBetween, dayEnd, dayStart, timeInStatus } from '../reports/flow';
import {
  averageAge,
  createdVsClosed,
  oneDimensional,
  type Period,
  parseAxis,
  periodsBetween,
  timeToClose,
  twoDimensional,
} from '../reports/general';
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
}

export type Unavailable = {
  unavailable: 'board_not_found' | 'not_scrum' | 'no_active_sprint' | 'sprint_not_found' | 'field';
};

const ASSIGNED =
  'assignee = currentUser() AND closeReason IS EMPTY ORDER BY priority DESC, updated DESC';
const FOLLOWED = 'follower = currentUser() ORDER BY updated DESC';
const DAY = 86_400_000;

/** The viewer's time zone, else UTC. */
function zoneOf(request: FastifyRequest): string {
  const zone = searchPerson(request).timeZone;
  return zone && knownTimeZone(zone) ? zone : 'UTC';
}

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
            assignee: string | null;
            updated_at: Date;
          }>`
            SELECT k.id, t.key || '-' || k.number AS key, k.summary, s.name AS status,
                   p.name AS priority, u.name AS assignee, k.updated_at
              FROM ticket k
              JOIN track t ON t.id = k.track_id
              JOIN status s ON s.id = k.status_id
              LEFT JOIN priority p ON p.id = k.priority_id
              LEFT JOIN app_user u ON u.id = k.assignee_id
             WHERE k.id = ANY(${page.ids}::int[])`.execute(db)
        ).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
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
              priority: r.priority,
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
  const config = widget.config;
  const scope = () => boardScope(db, catalogs, request);
  const where = async (q: string) => compileQuery(db, await scope(), q, new Date());
  // Reads run read-only under the search time limit.
  const read = <T>(work: (trx: Transaction<Database>) => Promise<T>) =>
    readOnly(db, ctx.timeoutMs, work);
  switch (widget.kind) {
    case 'introduction':
    case 'quick-links':
      return null;
    case 'search-results': {
      const c = config as WidgetSettings<'search-results'>;
      return ticketList(ctx, await scope(), c.query, c.limit);
    }
    case 'assigned-to-me':
      return ticketList(
        ctx,
        await scope(),
        ASSIGNED,
        (config as WidgetSettings<'assigned-to-me'>).limit,
      );
    case 'followed-tickets':
      return ticketList(
        ctx,
        await scope(),
        FOLLOWED,
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
      const running = (list: number[]) => {
        let n = 0;
        return list.map((v) => {
          n += v;
          return n;
        });
      };
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
      return { field: c.field, ...counted };
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
      return {
        fields: { x: c.x, y: c.y },
        ...(await read((trx) => twoDimensional(trx, { workspaceId: ws, scope: condition, x, y }))),
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
