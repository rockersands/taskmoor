import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { diff, emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import { dependencyOptions, linkTypesNamed, readDependencies } from '../plans/dependencies';
import { draftMarks, draftOverlay } from '../plans/drafts';
import { filterShape, idParam, scenarioShape } from '../plans/model';
import { type Period, periodsFrom } from '../plans/periods';
import { planTickets, sourceRows } from '../plans/query';
import { viewerDay } from '../reports/zone';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { isCalendarDay } from '../tickets/model';
import { viewScenario } from './plan-scenarios';
import { periodOf, planTeams, planVisible } from './plans';
import { searchRefusal } from './search';

/**
 * Program boards of a Multi-track plan (T-089d; PLN-008; ADR-122 stage 5).
 *
 * - A board lays the plan's level-1 and level-0 tickets out by team and period: a row per team the
 *   plan plans with (each ticket's value in the board's Team field), then one for other or no team;
 *   a column per period, `periods` of the plan's own from the one holding `from`, after one for
 *   open work with no due day. A ticket sits in the period holding its own due day, as Capacity
 *   counts it. Each cell lists its first 20 cards, outcomes first then by rank, with its count;
 *   every count equals a search: the plan's `query`, the board's `clause`, the row's and the
 *   column's, ANDed.
 * - It gives no access: its tickets are the plan's as the viewer sees them, with the views'
 *   filters, so a hidden ticket is never a card, counted in a cell or named. Cells carry no count
 *   of hidden work, since the plan's owner moves its periods a day at a time. A card's blockers
 *   the board does not show are only counted, as on the Timeline (PLN-006, PLN-013).
 * - Its plan's owner and site administrators make, change, archive and delete boards (`edit_plan`).
 *   Moving a card is the ticket's own change (`PATCH /tickets/:key`, with the version read), so the
 *   mover's permissions, the ticket's history and its events apply; others see it through the
 *   change log and the realtime socket (ADR-013), which the board page follows.
 * - A plan or board the person may not see answers 404, as does a board under another plan.
 * - With `scenario=<id>` (ADR-122 stage 6) each card stands in the cell of its drafted Team value
 *   and due day, for tickets the viewer is shown; a cell a draft moves a card into or out of says
 *   how many (`drafts`) and has no search (`clause: null`). Live, every count equals its search.
 */
type Db = Kysely<Database> | Transaction<Database>;

const MAX_INT = 2_147_483_647;
const idNum = z.number().int().positive().max(MAX_INT);
const day = z.string().refine(isCalendarDay, 'a calendar day as YYYY-MM-DD');
const name = z.string().trim().min(1).max(255);

/** How many periods a board shows at most, and by default. */
export const MAX_BOARD_PERIODS = 12;
const DEFAULT_BOARD_PERIODS = 6;
/** How many cards a cell lists; its count says how many more its search finds. */
export const CELL_CARDS = 20;
/** The levels a board shows: outcomes (1) and the work under them (0). */
const LEVELS_CLAUSE = 'hierarchyLevel IN (0, 1)';
const UNSCHEDULED = 'stage != closed AND due IS EMPTY';

const boardParams = z
  .object({
    id: z.coerce.number().int().positive().max(MAX_INT),
    boardId: z.coerce.number().int().positive().max(MAX_INT),
  })
  .strict();
const createBoard = z
  .object({
    name,
    teamFieldId: idNum.optional(),
    from: day.optional(),
    periods: z.number().int().min(1).max(MAX_BOARD_PERIODS).optional(),
  })
  .strict();
const updateBoard = z
  .object({
    name: name.optional(),
    teamFieldId: idNum.optional(),
    from: day.optional(),
    periods: z.number().int().min(1).max(MAX_BOARD_PERIODS).optional(),
    archived: z.boolean().optional(),
    // The version read: required, so a change made meanwhile is never overwritten unseen.
    version: idNum,
  })
  .strict();
const boardQuery = z.object({ ...filterShape, ...scenarioShape }).strict();

/** A value as the query language reads it: a quoted string with its quotes escaped. */
const quoted = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const periodClause = (p: Period) => `due >= ${quoted(p.start)} AND due <= ${quoted(p.end)}`;

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });

interface BoardRow {
  id: number;
  name: string;
  team_field_id: number | null;
  team_field_name: string | null;
  from_day: string;
  periods: number;
  archived_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const boardView = (b: BoardRow) => ({
  id: b.id,
  name: b.name,
  teamField:
    b.team_field_id === null ? null : { id: b.team_field_id, name: b.team_field_name ?? '' },
  from: b.from_day,
  periods: b.periods,
  archived: b.archived_at !== null,
  version: b.version,
  createdAt: b.created_at,
  updatedAt: b.updated_at,
});

export interface ProgramBoardOptions {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

export function registerProgramBoardRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: ProgramBoardOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  /** The plan with its periods when the person sees it (site administrators see every one). */
  async function visiblePlan(request: FastifyRequest, id: number) {
    const ws = request.workspaceId;
    let q = db
      .selectFrom('plan as p')
      .select([
        'p.id',
        'p.name',
        'p.owner_id',
        'p.period_kind',
        'p.period_weeks',
        'p.period_anchor',
      ])
      .where('p.workspace_id', '=', ws)
      .where('p.id', '=', id);
    const admin = await request.authz.isSiteAdmin();
    if (!admin) q = q.where(planVisible(ws, request.user?.id as number));
    const plan = await q.executeTakeFirst();
    if (!plan) return null;
    return { ...plan, editable: admin || plan.owner_id === request.user?.id };
  }

  const boards = (q: Db, ws: number) =>
    q
      .selectFrom('program_board as b')
      .leftJoin('field as f', 'f.id', 'b.team_field_id')
      .select([
        'b.id',
        'b.name',
        'b.team_field_id',
        'f.name as team_field_name',
        'b.from_day',
        'b.periods',
        'b.archived_at',
        'b.version',
        'b.created_at',
        'b.updated_at',
      ])
      .where('b.workspace_id', '=', ws);

  /** The board of this plan, or none: a board under another plan's id is not found. */
  async function boardOf(q: Db, ws: number, planId: number, boardId: number) {
    return (await boards(q, ws)
      .where('b.plan_id', '=', planId)
      .where('b.id', '=', boardId)
      .executeTakeFirst()) as BoardRow | undefined;
  }

  /** The site's Team fields a board may place cards by: shared, one value each, oldest first. */
  async function teamFields(ws: number) {
    return db
      .selectFrom('field')
      .select(['id', 'name'])
      .where('workspace_id', '=', ws)
      .where('track_id', 'is', null)
      .where('type', '=', 'team')
      .where('multiple', '=', false)
      .orderBy('id')
      .execute();
  }

  /** The Team field asked for, or the oldest; field errors when there is none or it is not one. */
  async function chooseField(
    ws: number,
    asked: number | undefined,
  ): Promise<{ id: number } | { fields: Record<string, string> }> {
    const fields = await teamFields(ws);
    if (asked === undefined) {
      const first = fields[0];
      return first ? { id: first.id } : { fields: { teamFieldId: 'no_team_field' } };
    }
    return fields.some((f) => f.id === asked)
      ? { id: asked }
      : { fields: { teamFieldId: 'not_found' } };
  }

  /** Opens the plan for a write: 401, 404, or 403 for someone who may not change it. */
  async function editablePlan(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request, reply);
    if (!user) return null;
    const p = boardParams.partial({ boardId: true }).safeParse(request.params);
    if (!p.success) {
      await notFound(reply);
      return null;
    }
    const plan = await visiblePlan(request, p.data.id);
    if (!plan) {
      await notFound(reply);
      return null;
    }
    if (!plan.editable) {
      await reply.code(403).send({ error: 'forbidden', permission: 'edit_plan' });
      return null;
    }
    return { user, plan, boardId: p.data.boardId };
  }

  app.get('/api/v1/plans/:id/program-boards', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const ws = request.workspaceId;
    const plan = await visiblePlan(request, p.data.id);
    if (!plan) return notFound(reply);
    const rows = (await boards(db, ws)
      .where('b.plan_id', '=', plan.id)
      .orderBy(sql`b.archived_at IS NOT NULL`)
      .orderBy(sql`lower(b.name)`)
      .orderBy('b.id')
      .execute()) as BoardRow[];
    return {
      plan: { id: plan.id, name: plan.name },
      editable: plan.editable,
      boards: rows.map(boardView),
      teamFields: await teamFields(ws),
    };
  });

  app.post('/api/v1/plans/:id/program-boards', async (request, reply) => {
    const opened = await editablePlan(request, reply);
    if (!opened) return reply;
    const parsed = createBoard.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const ws = request.workspaceId;
    const field = await chooseField(ws, parsed.data.teamFieldId);
    if ('fields' in field) return invalidFields(reply, field.fields);
    // With no first day given, the board starts from the person's own today (T-280).
    const from = parsed.data.from ?? viewerDay(request);
    const periods = parsed.data.periods ?? DEFAULT_BOARD_PERIODS;
    const made = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('program_board')
        .values({
          workspace_id: ws,
          plan_id: opened.plan.id,
          name: parsed.data.name,
          team_field_id: field.id,
          from_day: from,
          periods,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await emit(trx, by(request), {
        type: 'plan.program_board_created',
        subjectId: opened.plan.id,
        payload: { boardId: row.id, name: parsed.data.name, teamFieldId: field.id, from, periods },
      });
      return row.id;
    });
    const board = (await boardOf(db, ws, opened.plan.id, made)) as BoardRow;
    return reply.code(201).send({ board: boardView(board) });
  });

  app.patch('/api/v1/plans/:id/program-boards/:boardId', async (request, reply) => {
    const opened = await editablePlan(request, reply);
    if (!opened || opened.boardId === undefined) return opened ? notFound(reply) : reply;
    const boardId = opened.boardId;
    const parsed = updateBoard.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    if (!(await boardOf(db, ws, opened.plan.id, boardId))) return notFound(reply);
    if (body.teamFieldId !== undefined) {
      const field = await chooseField(ws, body.teamFieldId);
      if ('fields' in field) return invalidFields(reply, field.fields);
    }
    const outcome = await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('program_board')
        .select(['name', 'team_field_id', 'from_day', 'periods', 'archived_at', 'version'])
        .where('id', '=', boardId)
        .where('plan_id', '=', opened.plan.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return { missing: true as const };
      if (body.version !== locked.version) return { conflict: locked.version };
      const before = {
        name: locked.name,
        teamFieldId: locked.team_field_id,
        from: locked.from_day,
        periods: locked.periods,
        archived: locked.archived_at !== null,
      };
      const after = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.teamFieldId !== undefined ? { teamFieldId: body.teamFieldId } : {}),
        ...(body.from !== undefined ? { from: body.from } : {}),
        ...(body.periods !== undefined ? { periods: body.periods } : {}),
        ...(body.archived !== undefined ? { archived: body.archived } : {}),
      };
      const changes = diff(before as Record<string, unknown>, after as Record<string, unknown>);
      if (Object.keys(changes).length === 0) return { unchanged: true as const };
      await trx
        .updateTable('program_board')
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.teamFieldId !== undefined ? { team_field_id: body.teamFieldId } : {}),
          ...(body.from !== undefined ? { from_day: body.from } : {}),
          ...(body.periods !== undefined ? { periods: body.periods } : {}),
          ...(changes.archived ? { archived_at: body.archived ? new Date() : null } : {}),
          version: locked.version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', boardId)
        .execute();
      await emit(trx, by(request), {
        type: 'plan.program_board_updated',
        subjectId: opened.plan.id,
        payload: { boardId, changes },
      });
      return { updated: true as const };
    });
    if ('missing' in outcome) return notFound(reply);
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: 'version_conflict', version: outcome.conflict });
    }
    const board = (await boardOf(db, ws, opened.plan.id, boardId)) as BoardRow;
    return { board: boardView(board) };
  });

  app.delete('/api/v1/plans/:id/program-boards/:boardId', async (request, reply) => {
    const opened = await editablePlan(request, reply);
    if (!opened || opened.boardId === undefined) return opened ? notFound(reply) : reply;
    const boardId = opened.boardId;
    const ws = request.workspaceId;
    const gone = await db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('program_board')
        .where('id', '=', boardId)
        .where('plan_id', '=', opened.plan.id)
        .where('workspace_id', '=', ws)
        .returning('name')
        .executeTakeFirst();
      if (!row) return false;
      await emit(trx, by(request), {
        type: 'plan.program_board_deleted',
        subjectId: opened.plan.id,
        payload: { boardId, name: row.name },
      });
      return true;
    });
    if (!gone) return notFound(reply);
    return reply.code(204).send();
  });

  app.get('/api/v1/plans/:id/program-boards/:boardId', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = boardParams.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const q = boardQuery.safeParse(request.query ?? {});
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const ws = request.workspaceId;
    const plan = await visiblePlan(request, p.data.id);
    if (!plan) return notFound(reply);
    const board = await boardOf(db, ws, plan.id, p.data.boardId);
    if (!board) return notFound(reply);
    const { scenario: scenarioParam, ...filters } = q.data;
    try {
      const tickets = await planTickets(
        db,
        options.catalogs,
        request,
        await sourceRows(db, [plan.id]),
        filters,
      );
      const scenario = await viewScenario(db, ws, plan.id, scenarioParam, tickets.unfiltered);
      if (scenario === 'not_found') return invalidFields(reply, { scenario: 'not_found' });
      const over = draftOverlay(scenario?.id ?? null, tickets.unfiltered);
      const periods = periodsFrom(periodOf(plan), board.from_day, board.periods);
      const teams = await planTeams(db, plan.id);
      const teamIds = teams.map((t) => t.id);
      const fieldId = board.team_field_id;
      const field = fieldId === null ? null : `cf[${fieldId}]`;
      const rows = [
        ...(field === null
          ? []
          : teams.map((t) => ({ team: t as { id: number; name: string } | null, key: t.id }))),
        { team: null, key: null as number | null },
      ].map((r) => ({
        ...r,
        clause:
          field === null || (r.key === null && teamIds.length === 0)
            ? null
            : r.key !== null
              ? `${field} = ${r.key}`
              : `(${field} IS EMPTY OR ${field} NOT IN (${teamIds.join(', ')}))`,
      }));
      const options_ = await dependencyOptions(db, plan.id);
      const where = tickets.where;
      const unfiltered = tickets.unfiltered;
      const teamOf = over.team(fieldId);
      const liveTeam = draftOverlay(null, null).team(fieldId);
      const starts = periods.map((x) => x.start);
      const ends = periods.map((x) => x.end);
      const windowStart = starts[0] as string;
      const windowEnd = ends.at(-1) as string;

      const read = await readOnly(db, timeoutMs, async (trx) => {
        if (!where || !unfiltered) return null;
        // Every card's place, numbered within its cell, with the cell's count: one statement.
        const placed = (
          await sql<{ id: number; team: number | null; col: number; total: number }>`
            WITH c AS (
              SELECT k.id, ${teamOf} AS team_value, h.rank AS level, k.rank AS krank,
                     CASE WHEN ${over.due} IS NULL THEN 0 ELSE (
                       SELECT p.i::int FROM unnest(${starts}::date[], ${ends}::date[])
                         WITH ORDINALITY AS p(s, e, i)
                        WHERE ${over.due} BETWEEN p.s AND p.e) END AS col
                FROM ticket k
                JOIN status s ON s.id = k.status_id
                JOIN ticket_type y ON y.id = k.ticket_type_id
                JOIN hierarchy_level h ON h.id = y.level_id
                ${over.join}
               WHERE ${where} AND h.rank IN (0, 1)
                 AND (${over.due} BETWEEN ${windowStart}::date AND ${windowEnd}::date
                      OR (${over.due} IS NULL AND s.stage <> 'closed'))
            ), numbered AS (
              SELECT c.id, c.col,
                     CASE WHEN c.team_value = ANY(${teamIds}::bigint[]) THEN c.team_value::int END
                       AS team,
                     row_number() OVER w AS n, count(*) OVER w AS total
                FROM c
              WINDOW w AS (
                PARTITION BY CASE WHEN c.team_value = ANY(${teamIds}::bigint[])
                                  THEN c.team_value END, c.col
                ORDER BY c.level DESC, c.krank, c.id
                ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
            )
            SELECT id, team, col, total::int AS total FROM numbered
             WHERE n <= ${CELL_CARDS}
             ORDER BY col, n`.execute(trx)
        ).rows;
        // Cards a draft moves between cells: where they stand live and drafted, both read here.
        const moved =
          scenario === null
            ? []
            : (
                await sql<{
                  live_team: number | null;
                  live_due: string | null;
                  team: number | null;
                  due: string | null;
                  open: boolean;
                }>`
                  SELECT ${liveTeam}::int AS live_team, k.due_date::text AS live_due,
                         ${teamOf}::int AS team, ${over.due}::text AS due,
                         s.stage <> 'closed' AS open
                    FROM ticket k
                    JOIN status s ON s.id = k.status_id
                    JOIN ticket_type y ON y.id = k.ticket_type_id
                    JOIN hierarchy_level h ON h.id = y.level_id
                    ${over.join}
                   WHERE ${where} AND h.rank IN (0, 1) AND ${over.drafted}`.execute(trx)
              ).rows;
        const ids = placed.map((r) => r.id);
        if (ids.length === 0) return { placed, cards: [], deps: null, moved, marks: new Map() };
        const cards = (
          await sql<{
            id: number;
            key: string;
            summary: string;
            type: string;
            level_rank: number;
            level_kind: string;
            status: string;
            stage: 'new' | 'active' | 'closed';
            start: string | null;
            due: string | null;
            track_id: number;
            version: number;
            assignee_id: number | null;
            assignee_name: string | null;
            team_id: number | null;
            team_name: string | null;
          }>`
            SELECT k.id, t.key || '-' || k.number AS key, k.summary, y.name AS type,
                   h.rank AS level_rank, h.kind AS level_kind, s.name AS status, s.stage,
                   ${over.start}::text AS start, ${over.due}::text AS due, k.track_id, k.version,
                   k.assignee_id, u.name AS assignee_name, tm.id AS team_id, tm.name AS team_name
              FROM ticket k
              JOIN track t ON t.id = k.track_id
              JOIN status s ON s.id = k.status_id
              JOIN ticket_type y ON y.id = k.ticket_type_id
              JOIN hierarchy_level h ON h.id = y.level_id
              LEFT JOIN app_user u ON u.id = k.assignee_id
              ${over.join}
              LEFT JOIN team tm ON tm.workspace_id = k.workspace_id AND tm.id = ${teamOf}
             WHERE k.id = ANY(${ids}::int[])`.execute(trx)
        ).rows;
        const deps = await readDependencies(trx, ws, ids, options_, {
          unfiltered,
          checkPlan: true,
        });
        const marks = await draftMarks(trx, scenario?.id ?? null, ids);
        return { placed, cards, deps, moved, marks };
      });

      const empty = () => ({ count: 0, cards: [] as number[] });
      const cellsOf = () => ({ unscheduled: empty(), cells: periods.map(empty) });
      const grid = new Map<number | null, ReturnType<typeof cellsOf>>(
        rows.map((r) => [r.key, cellsOf()]),
      );
      for (const r of read?.placed ?? []) {
        const row = grid.get(fieldId === null ? null : r.team) ?? grid.get(null);
        if (!row) continue;
        const cell = r.col === 0 ? row.unscheduled : row.cells[r.col - 1];
        if (!cell) continue;
        cell.count = r.total;
        cell.cards.push(r.id);
      }
      // Cells a draft moves a card into or out of: their count is no search's.
      const rowKey = (team: number | null) =>
        fieldId !== null && team !== null && teamIds.includes(team) ? team : null;
      const colOf = (due: string | null, open: boolean): number | null => {
        if (due === null) return open ? 0 : null;
        const at = periods.findIndex((x) => due >= x.start && due <= x.end);
        return at < 0 ? null : at + 1;
      };
      const touched = new Map<string, number>();
      for (const m of read?.moved ?? []) {
        const from = colOf(m.live_due, m.open);
        const to = colOf(m.due, m.open);
        const a = from === null ? null : `${rowKey(m.live_team)}/${from}`;
        const b = to === null ? null : `${rowKey(m.team)}/${to}`;
        if (a === b) continue;
        for (const k of [a, b]) if (k !== null) touched.set(k, (touched.get(k) ?? 0) + 1);
      }
      const marked = (
        team: number | null,
        col: number,
        cell: { count: number; cards: number[] },
      ) => {
        const n = touched.get(`${team}/${col}`) ?? 0;
        return n === 0 ? cell : { ...cell, drafts: n, clause: null };
      };
      const marks = read?.marks ?? new Map();
      const byId = new Map((read?.cards ?? []).map((c) => [c.id, c]));
      const order = (read?.placed ?? []).map((r) => r.id);
      return {
        board: boardView(board),
        plan: { id: plan.id, name: plan.name },
        ...(scenario ? { scenario } : {}),
        editable: plan.editable,
        query: tickets.query,
        clause: LEVELS_CLAUSE,
        periods: periods.map((x) => ({ ...x, clause: periodClause(x) })),
        unscheduledClause: UNSCHEDULED,
        rows: rows.map((r) => {
          const cells = grid.get(r.key) as ReturnType<typeof cellsOf>;
          return {
            team: r.team,
            clause: r.clause,
            unscheduled: marked(r.key, 0, cells.unscheduled),
            cells: cells.cells.map((c, i) => marked(r.key, i + 1, c)),
          };
        }),
        cards: order.flatMap((id) => {
          const c = byId.get(id);
          if (!c) return [];
          return [
            {
              id: c.id,
              key: c.key,
              summary: c.summary,
              type: c.type,
              level: { rank: c.level_rank, kind: c.level_kind },
              status: { name: c.status, stage: c.stage },
              start: c.start,
              due: c.due,
              trackId: c.track_id,
              version: c.version,
              assignee:
                c.assignee_id === null ? null : { id: c.assignee_id, name: c.assignee_name ?? '' },
              team: c.team_id === null ? null : { id: c.team_id, name: c.team_name ?? '' },
              ...(marks.has(c.id) ? { draft: marks.get(c.id) } : {}),
            },
          ];
        }),
        links: read?.deps?.links ?? [],
        linkTypes: await linkTypesNamed(db, ws, read?.deps?.linkTypeIds ?? []),
        sameSprint: options_.sameSprint,
        blockersElsewhere: read?.deps?.elsewhere ?? [],
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });
}
