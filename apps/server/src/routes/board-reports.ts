import type { Database } from '@taskmoor/db';
import { knownTimeZone, localDate } from '@taskmoor/query';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { type BoardRecord, boardScope, compileBoard } from '../boards/data';
import type { BoardFilter } from '../boards/model';
import type { FieldCatalogs } from '../fields/catalog';
import { readStatusChanges } from '../reports/events';
import {
  type Averaging,
  cumulativeFlow,
  cyclePoints,
  cycleStatistics,
  datesBetween,
  dayEnd,
  dayStart,
  defaultTicketWindow,
  type FlowTicket,
  histogram,
  rolling,
  timeInStatus,
} from '../reports/flow';
import { viewerTimeZone } from '../reports/zone';
import { readOnly } from '../search/run';
import { searchRefusal } from './search';

/**
 * Flow reports of any board (M1-061; RPT-001; ADR-058): cumulative flow, the control chart and
 * cycle time report, and time in status, over a window of local days on the viewer's time zone:
 * `from` and `to`, or `days` up to `to`; the last 30 by default, up to two years. The tickets
 * are the board's as the viewer sees them (its query, sub-filter and the active board
 * filters), read through the search compiler, and the numbers come from their status changes
 * only. Durations are in seconds.
 */
const MAX_INT = 2_147_483_647;
const MAX_DAYS = 731;
const DAY = 86_400_000;
const idParam = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) }).strict();
const localDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => new Date(Date.parse(`${d}T00:00:00Z`)).toISOString().startsWith(d), 'invalid');
const windowShape = {
  from: localDay.optional(),
  to: localDay.optional(),
  /** Without `from`: this many days up to `to`. */
  days: z.coerce.number().int().min(1).max(MAX_DAYS).optional(),
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .refine((zone) => knownTimeZone(zone))
    .optional(),
  /** Active board filters, by id, comma separated. */
  filters: z.string().max(2000).optional(),
};
const windowQuery = z.object(windowShape).strict();
const cycleQuery = z
  .object({
    ...windowShape,
    /** The columns that count as the work, by id, comma separated. */
    columns: z.string().max(2000).optional(),
    average: z.enum(['tickets', 'days']).default('tickets'),
    /** Tickets or days in the rolling window. */
    window: z.coerce.number().int().min(1).max(10_000).optional(),
    /** Points returned, newest first kept. */
    limit: z.coerce.number().int().min(1).max(10_000).default(2000),
  })
  .strict();

export interface BoardReportDeps {
  catalogs: FieldCatalogs;
  timeoutMs: number;
  /** A board the caller sees, or null after answering 404. */
  board: (request: FastifyRequest, reply: FastifyReply, id: number) => Promise<BoardRecord | null>;
}

const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

const seconds = (ms: number) => Math.round(ms / 1000);
const daysBefore = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);

/** The columns that count as the work unless the viewer picks: those between the first and last. */
export function defaultColumns(board: BoardRecord): string[] {
  const ids = board.columns.map((c) => c.id);
  if (ids.length >= 3) return ids.slice(1, -1);
  return ids.length === 2 ? ids.slice(0, 1) : ids;
}

export function registerBoardReportRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  deps: BoardReportDeps,
): void {
  const { catalogs, timeoutMs } = deps;

  interface Loaded {
    board: BoardRecord;
    timeZone: string;
    from: string;
    to: string;
    /** The window as instants: the start of `from`, the end of `to` or now. */
    start: number;
    end: number;
    now: number;
    tickets: FlowTicket[];
  }

  /** The board, the window and the status changes of the board's tickets; null once answered. */
  async function load(
    request: FastifyRequest,
    reply: FastifyReply,
    q: z.infer<typeof windowQuery>,
  ): Promise<Loaded | null> {
    const user = requireUser(request, reply);
    if (!user) return null;
    const p = idParam.safeParse(request.params);
    if (!p.success) {
      await notFound(reply);
      return null;
    }
    const board = await deps.board(request, reply, p.data.id);
    if (!board) return null;
    const active: BoardFilter[] = [];
    const wanted = (q.filters ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f !== '');
    for (const id of new Set(wanted)) {
      const filter = board.boardFilters.find((f) => f.id === id);
      if (!filter) {
        await invalidFields(reply, { filters: 'not_found' });
        return null;
      }
      active.push(filter);
    }
    const timeZone = viewerTimeZone(request, q.timeZone);
    const now = Date.now();
    const to = q.to ?? localDate(new Date(now), timeZone);
    const from = q.from ?? daysBefore(to, (q.days ?? 30) - 1);
    if (from > to) {
      await invalidFields(reply, { from: 'after_to' });
      return null;
    }
    if (datesBetween(from, to).length > MAX_DAYS) {
      await invalidFields(reply, { from: 'too_long' });
      return null;
    }
    const start = dayStart(from, timeZone);
    const end = Math.min(dayEnd(to, timeZone), now);
    try {
      const scope = await boardScope(db, catalogs, request);
      const compiled = await compileBoard(db, scope, board, active, new Date(now));
      const tickets = await readOnly(db, timeoutMs, async (trx) => {
        const { rows } = await sql<{ id: number }>`
          SELECT k.id FROM ticket k WHERE ${compiled.scope} AND ${compiled.filters}`.execute(trx);
        return readStatusChanges(
          trx,
          request.workspaceId,
          rows.map((r) => r.id),
          new Date(end),
        );
      });
      return { board, timeZone, from, to, start, end, now, tickets };
    } catch (error) {
      await searchRefusal(reply, error, timeoutMs);
      return null;
    }
  }

  // Cumulative flow: tickets per column at the end of each day, up to today.
  app.get('/api/v1/boards/:id/reports/cumulative-flow', async (request, reply) => {
    const q = windowQuery.safeParse(request.query);
    if (!q.success) {
      if (!requireUser(request, reply)) return reply;
      return invalidFields(reply, shapeErrors(q.error));
    }
    const loaded = await load(request, reply, q.data);
    if (!loaded) return reply;
    const { board, timeZone, from, to, now, tickets } = loaded;
    const today = localDate(new Date(now), timeZone);
    const last = to < today ? to : today;
    const flow = cumulativeFlow({
      columns: board.columns,
      tickets,
      dates: from <= last ? datesBetween(from, last) : [],
      timeZone,
      now,
    });
    return { timeZone, from, to, ...flow };
  });

  // Control chart and cycle time report: one point per ticket that moved past the chosen
  // columns in the window, the rolling average and spread, statistics and the distribution.
  app.get('/api/v1/boards/:id/reports/cycle-time', async (request, reply) => {
    const q = cycleQuery.safeParse(request.query);
    if (!q.success) {
      if (!requireUser(request, reply)) return reply;
      return invalidFields(reply, shapeErrors(q.error));
    }
    const loaded = await load(request, reply, q.data);
    if (!loaded) return reply;
    const { board, timeZone, from, to, start, end, tickets } = loaded;
    let chosen = defaultColumns(board);
    if (q.data.columns !== undefined) {
      chosen = [
        ...new Set(
          q.data.columns
            .split(',')
            .map((c) => c.trim())
            .filter((c) => c !== ''),
        ),
      ];
      if (chosen.length === 0) return invalidFields(reply, { columns: 'empty' });
      if (chosen.some((id) => !board.columns.some((c) => c.id === id))) {
        return invalidFields(reply, { columns: 'not_found' });
      }
    }
    const points = cyclePoints({ columns: board.columns, chosen, tickets, from: start, to: end });
    const averaging: Averaging =
      q.data.average === 'tickets'
        ? { method: 'tickets', size: q.data.window ?? defaultTicketWindow(points.length) }
        : { method: 'days', size: q.data.window ?? 7 };
    const rolled = rolling(points, averaging);
    const statistics = cycleStatistics(points);
    const bins = histogram(points);
    const first = Math.max(0, points.length - q.data.limit);
    const shown = points.slice(first);
    const named =
      shown.length === 0
        ? []
        : (
            await sql<{ id: number; key: string; summary: string }>`
              SELECT k.id, t.key || '-' || k.number AS key, k.summary
                FROM ticket k JOIN track t ON t.id = k.track_id
               WHERE k.id = ANY(${shown.map((p) => p.ticketId)}::int[])`.execute(db)
          ).rows;
    const byId = new Map(named.map((t) => [t.id, t]));
    return {
      timeZone,
      from,
      to,
      // The window as instants: the start of `from`, the end of `to` (now when that is later).
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      columns: board.columns.map((c) => ({
        id: c.id,
        name: c.name,
        chosen: chosen.includes(c.id),
      })),
      averaging,
      statistics: {
        count: statistics.count,
        average: seconds(statistics.average),
        median: seconds(statistics.median),
        p85: seconds(statistics.p85),
        p95: seconds(statistics.p95),
        min: seconds(statistics.min),
        max: seconds(statistics.max),
        deviation: seconds(statistics.deviation),
      },
      histogram: { width: seconds(bins.width), counts: bins.counts },
      total: points.length,
      points: shown.map((p, i) => {
        const t = byId.get(p.ticketId);
        const r = rolled[first + i] as { average: number; deviation: number };
        return {
          ticket: { id: p.ticketId, key: t?.key ?? '', summary: t?.summary ?? '' },
          at: new Date(p.at).toISOString(),
          cycle: seconds(p.cycle),
          average: seconds(r.average),
          deviation: seconds(r.deviation),
        };
      }),
    };
  });

  // Time in status: per status, the time the board's tickets spent in it inside the window.
  app.get('/api/v1/boards/:id/reports/time-in-status', async (request, reply) => {
    const q = windowQuery.safeParse(request.query);
    if (!q.success) {
      if (!requireUser(request, reply)) return reply;
      return invalidFields(reply, shapeErrors(q.error));
    }
    const loaded = await load(request, reply, q.data);
    if (!loaded) return reply;
    const { board, timeZone, from, to, start, end, tickets } = loaded;
    const rows = timeInStatus({ tickets, from: start, to: end });
    const statuses =
      rows.length === 0
        ? []
        : await db
            .selectFrom('status')
            .select(['id', 'name', 'sort_order'])
            .where('workspace_id', '=', request.workspaceId)
            .where(
              'id',
              'in',
              rows.map((r) => r.statusId),
            )
            .execute();
    const status = new Map(statuses.map((s) => [s.id, s]));
    const columnOf = new Map<number, number>();
    board.columns.forEach((c, i) => {
      for (const s of c.statusIds) if (!columnOf.has(s)) columnOf.set(s, i);
    });
    const position = (id: number) => columnOf.get(id) ?? board.columns.length;
    const ordered = rows
      .filter((r) => status.has(r.statusId))
      .sort(
        (a, b) =>
          position(a.statusId) - position(b.statusId) ||
          (status.get(a.statusId)?.sort_order ?? 0) - (status.get(b.statusId)?.sort_order ?? 0) ||
          a.statusId - b.statusId,
      );
    return {
      timeZone,
      from,
      to,
      statuses: ordered.map((r) => {
        const col = columnOf.get(r.statusId);
        return {
          status: { id: r.statusId, name: status.get(r.statusId)?.name ?? '' },
          columnId: col === undefined ? null : (board.columns[col]?.id ?? null),
          tickets: r.tickets,
          total: seconds(r.total),
          average: seconds(r.tickets === 0 ? 0 : r.total / r.tickets),
          entries: r.entries,
        };
      }),
    };
  });
}
