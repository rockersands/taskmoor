import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import { compileCondition, compileQuery } from '../boards/data';
import type { FieldCatalogs } from '../fields/catalog';
import {
  calendarQuery,
  filterQuery,
  idParam,
  LISTED,
  MAX_CALENDAR_DAYS,
  type PlanFilters,
} from '../plans/model';
import { browsedTracks, type PlanTickets, planTickets, sourceRows } from '../plans/query';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { planVisible } from './plans';
import { searchRefusal } from './search';

/**
 * The views of a Multi-track plan (T-088; PLN-012; ADR-122), each as the viewer, with the
 * filters (`plans/model.ts`), over the plan's tickets as `plans/query.ts` composes them for that
 * viewer. Each lists at most the first 10,000 tickets and says so (`truncated`).
 *
 * - `GET /api/v1/plans/:id/summary`: counts of the plan's tickets (all, open, overdue, due
 *   within 7 days, open without dates, closed in the last 7 days), by stage, by track and the ten
 *   people with most open tickets. One statement with GROUPING SETS counts them all; every
 *   condition is compiled from the same text as the search its `query` names, so each number
 *   equals that search's count.
 * - `GET /api/v1/plans/:id/timeline`: the track timeline's answer (ADR-064) over the plan. The
 *   first 10,000 in rank order are chosen first and only they are read further. Roll-ups cover
 *   every descendant the viewer may see, in the plan or not; a parent they may not see reads as
 *   none. Markers: dated sprints of the Scrum boards and dated releases of the tracks listed.
 * - `GET /api/v1/plans/:id/calendar?from=&to=`: the tickets with a start or due day in the
 *   range (at most 100 days, at most 10,000 tickets by due day), with the sprints and releases of
 *   their tracks that overlap it.
 *
 * Rescheduling is the ticket's own change (`PATCH /tickets/:key`), with its permission
 * ("Schedule tickets"), history and events.
 */
const MARKERS = 1000;
/** How many people the summary names; the rest stay in the open count. */
const PEOPLE = 10;

interface ItemRow {
  id: number;
  key: string;
  summary: string;
  type: string;
  level_rank: number;
  level_kind: string;
  parent_id: number | null;
  status: string;
  stage: 'new' | 'active' | 'closed';
  start_date: string | null;
  due_date: string | null;
  sprint_start: string | null;
  sprint_end: string | null;
  track_id: number;
  assignee_id: number | null;
  assignee_name: string | null;
  priority: string | null;
}

export interface PlanCount {
  id: string;
  /** What the number counts: a stage, a track's key or a person's name; null for none. */
  name: string | null;
  query: string;
  count: number;
}

export interface PlanViewOptions {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

/** The sprint a ticket is dated by: an open one it is in, else the latest it was in. */
const SPRINT_OF = (column: 'start_at' | 'end_at') => sql`(
  SELECT (s.${sql.ref(column)} AT TIME ZONE 'UTC')::date FROM sprint_ticket st
    JOIN sprint s ON s.id = st.sprint_id JOIN board b ON b.id = s.board_id AND b.kind = 'scrum'
   WHERE st.ticket_id = k.id AND s.deleted_at IS NULL
   ORDER BY st.open DESC, s.sequence DESC LIMIT 1)`;

/** A value as the query language reads it: a quoted string with its quotes escaped. */
const quoted = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The plan's tracks the viewer may search: their markers show even with no ticket listed. */
const sourceTracks = (tickets: PlanTickets) =>
  tickets.sources.flatMap((s) => (s.kind === 'track' && s.state === 'visible' ? [s.id] : []));

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

export function registerPlanViewRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: PlanViewOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

  /**
   * The plan and its tickets as the person sees them, or the answer already sent: 401 without a
   * session, 404 for a plan they may not see, 400 for filters that do not read.
   */
  async function open(
    request: FastifyRequest,
    reply: FastifyReply,
    filters: PlanFilters,
  ): Promise<{ plan: { id: number; name: string }; tickets: PlanTickets } | null> {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: 'unauthenticated' });
      return null;
    }
    const p = idParam.safeParse(request.params);
    if (!p.success) {
      await reply.code(404).send({ error: 'not_found' });
      return null;
    }
    const ws = request.workspaceId;
    let q = db
      .selectFrom('plan as p')
      .select(['p.id', 'p.name'])
      .where('p.workspace_id', '=', ws)
      .where('p.id', '=', p.data.id);
    if (!(await request.authz.isSiteAdmin())) q = q.where(planVisible(ws, user.id));
    const plan = await q.executeTakeFirst();
    if (!plan) {
      await reply.code(404).send({ error: 'not_found' });
      return null;
    }
    const tickets = await planTickets(
      db,
      options.catalogs,
      request,
      await sourceRows(db, [plan.id]),
      filters,
    );
    return { plan, tickets };
  }

  /** Dated sprints of Scrum boards and dated releases of these tracks, within the range. */
  async function markers(
    trx: Kysely<Database> | Transaction<Database>,
    ws: number,
    trackIds: readonly number[],
    range?: { from: string; to: string },
  ) {
    if (trackIds.length === 0) return { sprints: [], releases: [] };
    const ids = [...trackIds];
    const sprintRange = range
      ? sql`AND (s.start_at AT TIME ZONE 'UTC')::date <= ${range.to}::date
            AND (s.end_at AT TIME ZONE 'UTC')::date >= ${range.from}::date`
      : sql``;
    const releaseRange = range
      ? sql`AND r.release_date BETWEEN ${range.from}::date AND ${range.to}::date`
      : sql``;
    const sprints = (
      await sql<{
        id: number;
        name: string;
        state: string;
        start: string;
        end: string;
        trackId: number;
      }>`
        SELECT s.id, s.name, s.state, (s.start_at AT TIME ZONE 'UTC')::date::text AS start,
               (s.end_at AT TIME ZONE 'UTC')::date::text AS end, b.location_track_id AS "trackId"
          FROM sprint s JOIN board b ON b.id = s.board_id AND b.kind = 'scrum'
         WHERE s.workspace_id = ${ws}::int AND b.location_track_id = ANY(${ids}::int[])
           AND s.deleted_at IS NULL AND s.start_at IS NOT NULL AND s.end_at IS NOT NULL
           ${sprintRange}
         ORDER BY s.start_at, s.id
         LIMIT ${MARKERS}`.execute(trx)
    ).rows;
    const releases = (
      await sql<{ id: number; name: string; date: string; shipped: boolean; trackId: number }>`
        SELECT r.id, r.name, r.release_date::text AS date, r.shipped_at IS NOT NULL AS shipped,
               r.track_id AS "trackId"
          FROM release r
         WHERE r.track_id = ANY(${ids}::int[]) AND r.archived_at IS NULL
           AND r.release_date IS NOT NULL ${releaseRange}
         ORDER BY r.release_date, r.sort_order, r.id
         LIMIT ${MARKERS}`.execute(trx)
    ).rows;
    return { sprints, releases };
  }

  /**
   * The tracks named in an answer, by id: the name only of a track the person browses; a track
   * known only from a ticket they may see (a ticket-level grant) by its key, which the ticket's own
   * key already shows.
   */
  async function tracksOf(
    trx: Kysely<Database> | Transaction<Database>,
    trackIds: readonly number[],
    browses: (trackId: number) => boolean,
  ) {
    if (trackIds.length === 0) return [];
    const rows = await trx
      .selectFrom('track')
      .select(['id', 'key', 'name'])
      .where('id', 'in', [...trackIds])
      .orderBy('key')
      .execute();
    return rows.map((t) => ({ id: t.id, key: t.key, name: browses(t.id) ? t.name : null }));
  }

  app.get('/api/v1/plans/:id/summary', async (request, reply) => {
    const f = filterQuery.safeParse(request.query ?? {});
    if (!f.success)
      return reply.code(400).send({ error: 'invalid_fields', fields: shapeErrors(f.error) });
    try {
      const opened = await open(request, reply, f.data);
      if (!opened) return reply;
      const { plan, tickets } = opened;
      const { query, where, scope } = tickets;
      const empty = {
        plan,
        query,
        total: { id: 'total', name: null, query: query ?? '', count: 0 },
        overview: [] as PlanCount[],
        stages: [] as PlanCount[],
        tracks: [] as PlanCount[],
        assignees: [] as PlanCount[],
      };
      if (!where || query === null) return empty;
      const now = new Date();
      // Each condition as its link searches it, ANDed to the plan's query.
      const CONDITIONS = {
        open: 'stage != closed',
        overdue: 'stage != closed AND due < startOfDay()',
        dueSoon: 'stage != closed AND due >= startOfDay() AND due <= 7d',
        unscheduled: 'stage != closed AND start IS EMPTY AND due IS EMPTY',
        closedRecently: 'closed >= -7d',
      } as const;
      const compiled: Record<keyof typeof CONDITIONS, RawBuilder<boolean>> = {
        open: await compileCondition(db, scope, CONDITIONS.open, now),
        overdue: await compileCondition(db, scope, CONDITIONS.overdue, now),
        dueSoon: await compileCondition(db, scope, CONDITIONS.dueSoon, now),
        unscheduled: await compileCondition(db, scope, CONDITIONS.unscheduled, now),
        closedRecently: await compileCondition(db, scope, CONDITIONS.closedRecently, now),
      };
      const linked = (clause: string) => `(${query}) AND ${clause}`;
      const browses = await browsedTracks(request);
      const counted = await readOnly(db, timeoutMs, async (trx) => {
        const { rows } = await sql<{
          by_track: number;
          by_stage: number;
          by_assignee: number;
          track_id: number | null;
          stage: 'new' | 'active' | 'closed' | null;
          assignee_id: number | null;
          n: number;
          open: number;
          overdue: number;
          due_soon: number;
          unscheduled: number;
          closed_recently: number;
        }>`
          SELECT GROUPING(k.track_id)::int AS by_track, GROUPING(s.stage)::int AS by_stage,
                 GROUPING(k.assignee_id)::int AS by_assignee,
                 k.track_id, s.stage, k.assignee_id, count(*)::int AS n,
                 count(*) FILTER (WHERE ${compiled.open})::int AS open,
                 count(*) FILTER (WHERE ${compiled.overdue})::int AS overdue,
                 count(*) FILTER (WHERE ${compiled.dueSoon})::int AS due_soon,
                 count(*) FILTER (WHERE ${compiled.unscheduled})::int AS unscheduled,
                 count(*) FILTER (WHERE ${compiled.closedRecently})::int AS closed_recently
            FROM ticket k JOIN status s ON s.id = k.status_id
           WHERE ${where}
           GROUP BY GROUPING SETS ((), (k.track_id), (s.stage), (k.assignee_id))`.execute(trx);
        const all = rows.find((r) => r.by_track + r.by_stage + r.by_assignee === 3);
        const byTrack = rows.filter((r) => r.by_track === 0);
        const byPerson = rows
          .filter((r) => r.by_assignee === 0 && r.open > 0)
          .sort((a, b) => b.open - a.open || (a.assignee_id ?? 0) - (b.assignee_id ?? 0))
          .slice(0, PEOPLE);
        const people = byPerson.flatMap((r) => (r.assignee_id === null ? [] : [r.assignee_id]));
        const names = new Map(
          (people.length === 0
            ? []
            : await trx
                .selectFrom('app_user')
                .select(['id', 'name'])
                .where('id', 'in', people)
                .execute()
          ).map((u) => [u.id, u.name]),
        );
        const tracks = await tracksOf(
          trx,
          byTrack.map((r) => r.track_id as number),
          browses,
        );
        return { all, rows, byTrack, byPerson, names, tracks };
      });
      const all = counted.all;
      const item = (id: string, name: string | null, clause: string | null, count: number) => ({
        id,
        name,
        query: clause === null ? query : linked(clause),
        count,
      });
      const trackCount = new Map(counted.byTrack.map((r) => [r.track_id, r.n]));
      const stageCount = new Map(
        counted.rows.filter((r) => r.by_stage === 0).map((r) => [r.stage, r.n]),
      );
      return {
        plan,
        query,
        total: item('total', null, null, all?.n ?? 0),
        overview: [
          item('open', null, CONDITIONS.open, all?.open ?? 0),
          item('overdue', null, CONDITIONS.overdue, all?.overdue ?? 0),
          item('dueSoon', null, CONDITIONS.dueSoon, all?.due_soon ?? 0),
          item('unscheduled', null, CONDITIONS.unscheduled, all?.unscheduled ?? 0),
          item('closedRecently', null, CONDITIONS.closedRecently, all?.closed_recently ?? 0),
        ],
        stages: (['new', 'active', 'closed'] as const).map((stage) =>
          item(stage, stage, `stage = ${stage}`, stageCount.get(stage) ?? 0),
        ),
        tracks: counted.tracks.map((t) =>
          item(String(t.id), t.key, `track = ${quoted(t.key)}`, trackCount.get(t.id) ?? 0),
        ),
        assignees: counted.byPerson.map((r) =>
          r.assignee_id === null
            ? item('unassigned', null, `${CONDITIONS.open} AND assignee IS EMPTY`, r.open)
            : item(
                String(r.assignee_id),
                counted.names.get(r.assignee_id) ?? '',
                `${CONDITIONS.open} AND assignee = ${r.assignee_id}`,
                r.open,
              ),
        ),
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.get('/api/v1/plans/:id/timeline', async (request, reply) => {
    const f = filterQuery.safeParse(request.query ?? {});
    if (!f.success)
      return reply.code(400).send({ error: 'invalid_fields', fields: shapeErrors(f.error) });
    try {
      const opened = await open(request, reply, f.data);
      if (!opened) return reply;
      const { plan, tickets } = opened;
      const ws = request.workspaceId;
      const none = {
        plan,
        query: tickets.query,
        items: [],
        links: [],
        tracks: [],
        markers: { sprints: [], releases: [] },
        truncated: false,
      };
      const where = tickets.where;
      if (!where) return none;
      // The viewer's tickets of any track, for roll-ups beyond the plan.
      const seen = await compileQuery(db, tickets.scope, '', new Date());
      const answer = await readOnly(db, timeoutMs, async (trx) => {
        const chosen = (
          await sql<{ id: number }>`
            SELECT k.id FROM ticket k WHERE ${where} ORDER BY k.rank, k.id
             LIMIT ${LISTED + 1}`.execute(trx)
        ).rows.map((r) => r.id);
        const ids = chosen.slice(0, LISTED);
        if (ids.length === 0) return { rows: [], rollups: [], links: [], ids, more: false };
        const rows = (
          await sql<ItemRow>`
            SELECT k.id, t.key || '-' || k.number AS key, k.summary, y.name AS type,
                   h.rank AS level_rank, h.kind AS level_kind, k.parent_id, s.name AS status,
                   s.stage, k.start_date::text, k.due_date::text,
                   ${SPRINT_OF('start_at')}::text AS sprint_start,
                   ${SPRINT_OF('end_at')}::text AS sprint_end,
                   k.track_id, k.assignee_id, u.name AS assignee_name, pr.name AS priority
              FROM ticket k
              JOIN track t ON t.id = k.track_id
              JOIN status s ON s.id = k.status_id
              JOIN ticket_type y ON y.id = k.ticket_type_id
              JOIN hierarchy_level h ON h.id = y.level_id
              LEFT JOIN app_user u ON u.id = k.assignee_id
              LEFT JOIN priority pr ON pr.id = k.priority_id
             WHERE k.id = ANY(${ids}::int[])
             ORDER BY k.rank, k.id`.execute(trx)
        ).rows;
        // Roll-ups over every descendant the viewer sees, from the listed tickets down.
        const rollups = (
          await sql<{
            id: number;
            start: string | null;
            due: string | null;
            total: number;
            closed: number;
          }>`
            WITH RECURSIVE tree AS (
              SELECT r.id AS root, r.id, 0 AS depth FROM ticket r WHERE r.id = ANY(${ids}::int[])
              UNION ALL
              SELECT tree.root, k.id, tree.depth + 1
                FROM tree JOIN ticket k ON k.parent_id = tree.id
               WHERE tree.depth < 10 AND ${seen}
            )
            SELECT tree.root AS id,
                   min(COALESCE(k.start_date, ${SPRINT_OF('start_at')}))::text AS start,
                   max(COALESCE(k.due_date, ${SPRINT_OF('end_at')}))::text AS due,
                   count(*)::int AS total,
                   count(*) FILTER (WHERE k.closed_at IS NOT NULL)::int AS closed
              FROM tree JOIN ticket k ON k.id = tree.id
             WHERE tree.depth > 0
             GROUP BY tree.root`.execute(trx)
        ).rows;
        const links = (
          await sql<{ from: number; to: number }>`
            SELECT l.source_id AS from, l.target_id AS to
              FROM ticket_link l JOIN link_type lt ON lt.id = l.link_type_id
             WHERE l.workspace_id = ${ws}::int AND lower(lt.outward) = 'blocks'
               AND l.source_id = ANY(${ids}::int[]) AND l.target_id = ANY(${ids}::int[])
             ORDER BY l.source_id, l.target_id`.execute(trx)
        ).rows;
        return { rows, rollups, links, ids, more: chosen.length > LISTED };
      });
      if (answer.rows.length === 0) return none;
      const parents = [
        ...new Set(answer.rows.flatMap((r) => (r.parent_id === null ? [] : [r.parent_id]))),
      ];
      // A parent the viewer may not see reads as none, never as its id.
      const shownParents = await request.authz.visibleTickets(parents);
      const trackIds = [
        ...new Set([...answer.rows.map((r) => r.track_id), ...sourceTracks(tickets)]),
      ];
      // Sprints and releases only of tracks the person browses, never through a ticket-level grant.
      const browses = await browsedTracks(request);
      const extra = await readOnly(db, timeoutMs, async (trx) => ({
        markers: await markers(trx, ws, trackIds.filter(browses)),
        tracks: await tracksOf(trx, trackIds, browses),
      }));
      const rollupOf = new Map(answer.rollups.map((r) => [r.id, r]));
      return {
        plan,
        query: tickets.query,
        items: answer.rows.map((i) => {
          const own = i.start_date !== null || i.due_date !== null;
          const bySprint = !own && i.sprint_start !== null;
          const rollup = rollupOf.get(i.id);
          return {
            id: i.id,
            key: i.key,
            summary: i.summary,
            type: i.type,
            level: { rank: i.level_rank, kind: i.level_kind },
            parentId: i.parent_id !== null && shownParents.has(i.parent_id) ? i.parent_id : null,
            status: { name: i.status, stage: i.stage },
            start: own ? i.start_date : bySprint ? i.sprint_start : null,
            due: own ? i.due_date : bySprint ? i.sprint_end : null,
            dated: own ? 'own' : bySprint ? 'sprint' : null,
            rollup: rollup
              ? { start: rollup.start, due: rollup.due, total: rollup.total, closed: rollup.closed }
              : null,
            trackId: i.track_id,
            assignee:
              i.assignee_id === null ? null : { id: i.assignee_id, name: i.assignee_name ?? '' },
            priority: i.priority,
          };
        }),
        links: answer.links,
        tracks: extra.tracks,
        markers: extra.markers,
        truncated: answer.more,
      };
    } catch (error) {
      return searchRefusal(reply as FastifyReply, error, timeoutMs);
    }
  });

  app.get('/api/v1/plans/:id/calendar', async (request, reply) => {
    const q = calendarQuery.safeParse(request.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
    const { from, to, ...filters } = q.data;
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (span < 0 || span > MAX_CALENDAR_DAYS) {
      return reply.code(400).send({ error: 'invalid_request', detail: 'range' });
    }
    try {
      const opened = await open(request, reply, filters);
      if (!opened) return reply;
      const { plan, tickets } = opened;
      const none = {
        plan,
        query: tickets.query,
        tickets: [],
        tracks: [],
        sprints: [],
        releases: [],
        truncated: false,
      };
      const where = tickets.where;
      if (!where) return none;
      const ws = request.workspaceId;
      const browses = await browsedTracks(request);
      const answer = await readOnly(db, timeoutMs, async (trx) => {
        const rows = (
          await sql<{
            id: number;
            key: string;
            summary: string;
            type: string;
            stage: 'new' | 'active' | 'closed';
            start: string | null;
            due: string | null;
            trackId: number;
          }>`
            SELECT k.id, t.key || '-' || k.number AS key, k.summary, y.name AS type, s.stage,
                   k.start_date::text AS start, k.due_date::text AS due, k.track_id AS "trackId"
              FROM ticket k
              JOIN track t ON t.id = k.track_id
              JOIN status s ON s.id = k.status_id
              JOIN ticket_type y ON y.id = k.ticket_type_id
             WHERE ${where}
               AND (k.due_date BETWEEN ${from}::date AND ${to}::date
                    OR k.start_date BETWEEN ${from}::date AND ${to}::date)
             ORDER BY COALESCE(k.due_date, k.start_date), k.rank, k.id
             LIMIT ${LISTED + 1}`.execute(trx)
        ).rows;
        const listed = rows.slice(0, LISTED);
        const trackIds = [...new Set([...listed.map((r) => r.trackId), ...sourceTracks(tickets)])];
        return {
          tickets: listed,
          tracks: await tracksOf(trx, trackIds, browses),
          ...(await markers(trx, ws, trackIds.filter(browses), { from, to })),
          truncated: rows.length > LISTED,
        };
      });
      return { plan, query: tickets.query, ...answer };
    } catch (error) {
      return searchRefusal(reply as FastifyReply, error, timeoutMs);
    }
  });
}
