import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { diff, emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import { planEditable } from '../plans/access';
import { draftOverlay, lockPlan, versionQuery } from '../plans/drafts';
import { filterShape, type PlanFilters, scenarioShape } from '../plans/model';
import { planTickets, sourceRows } from '../plans/query';
import { sprintDay } from '../plans/sprints';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { viewScenario } from './plan-scenarios';
import { planVisible } from './plans';
import { searchRefusal } from './search';

/**
 * Baselines of a Multi-track plan (T-089a; PLN-011; ADR-122 stage 9).
 *
 * - A baseline is a named, frozen copy of the days of the plan's tickets its capturer is shown, at
 *   one moment: each ticket's own start and due days, or else its sprint's, which of the two, and
 *   whether it was closed; never a key, a summary or a roll-up. It is taken from the tickets as
 *   they are (Live) or from a scenario's drafts.
 * - `GET /plans/:id/baselines` lists them, newest first, for anyone who sees the plan; `POST`
 *   captures one, `PATCH` renames and `DELETE` removes one, for the plan's editors.
 * - `GET .../baselines/:bid/compare` sets the days now (Live, or `scenario=`) against the
 *   baseline's over the reader's plan with the page's filters: counts, the plan's end then and
 *   now, and a page of tickets by delay, largest first. Delay is a ticket's end now less its end
 *   then, in calendar days; a ticket's end is its due day, else its start day, else its sprint's.
 * - A plan gives no access: every read joins the baseline's rows to the reader's plan, never the
 *   reverse, so its days show only on tickets the plan shows the reader now. The rest are one
 *   number, `notShown`, never keyed or dated.
 * - Each write emits one `plan.baseline_*` event in its transaction, audited; ids and counts only.
 */
type Db = Kysely<Database>;

const MAX_INT = 2_147_483_647;
const idNum = z.number().int().positive().max(MAX_INT);

/** Baselines a plan holds. */
export const MAX_BASELINES = 10;
/** Tickets a capture holds: a plan of PLN-001's size. */
export const MAX_CAPTURED = 50_000;
/** Tickets a page of a comparison lists. */
export const COMPARE_PAGE = 200;

export const BASELINE_LIMITS = {
  baselines: MAX_BASELINES,
  tickets: MAX_CAPTURED,
  page: COMPARE_PAGE,
} as const;

const baselineName = z.string().trim().min(1).max(100);
const createBody = z.object({ name: baselineName, scenarioId: idNum.optional() }).strict();
const renameBody = z.object({ name: baselineName, version: idNum }).strict();
const baselineParams = z
  .object({
    id: z.coerce.number().int().positive().max(MAX_INT),
    bid: z.coerce.number().int().positive().max(MAX_INT).optional(),
  })
  .strict();
const SHOW = ['slipped', 'earlier', 'added', 'all'] as const;
type Show = (typeof SHOW)[number];
const compareQuery = z
  .object({
    ...filterShape,
    ...scenarioShape,
    show: z.enum(SHOW).optional(),
    after: z.string().max(2000).optional(),
  })
  .strict();

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

/** The sort key of a ticket without a delay: after every ticket with one. */
const NO_DELAY = -MAX_INT;

/** Where a page of a comparison goes on: the last ticket's delay (or none), rank and id. */
interface Cursor {
  d: number;
  r: string;
  i: number;
}

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(text: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (
      !Number.isInteger(c.d) ||
      typeof c.r !== 'string' ||
      !Number.isInteger(c.i) ||
      (c.i as number) < 0 ||
      (c.i as number) > MAX_INT ||
      Math.abs(c.d as number) > MAX_INT
    ) {
      return null;
    }
    return { d: c.d as number, r: c.r, i: c.i as number };
  } catch {
    return null;
  }
}

export interface PlanBaselineOptions {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

interface BaselineRow {
  id: number;
  name: string;
  source: 'live' | 'scenario';
  scenario_name: string | null;
  tickets: number;
  created_by: number;
  created_by_name: string;
  created_at: Date;
  version: number;
}

const baselineView = (b: BaselineRow) => ({
  id: b.id,
  name: b.name,
  source: b.source,
  scenarioName: b.scenario_name,
  tickets: b.tickets,
  createdAt: b.created_at,
  createdBy: { id: b.created_by, name: b.created_by_name },
  version: b.version,
});

/** One side's days of a ticket: its own, else its sprint's, and which. */
interface SideDays {
  start: string | null;
  due: string | null;
  dated: 'own' | 'sprint' | null;
}

/**
 * A ticket's days now over ticket `k` with the overlay `over` joined (`o`) and its sprint's days
 * read only for a ticket without days of its own (`sp`): the joins, then the three columns.
 */
function daysNow(over: ReturnType<typeof draftOverlay>) {
  return {
    join: sql`${over.join}
      CROSS JOIN LATERAL (SELECT (${over.start})::date AS start, (${over.due})::date AS due) o
      LEFT JOIN LATERAL (
        SELECT ${sprintDay('start_at')}::date AS start, ${sprintDay('end_at')}::date AS due
         WHERE o.start IS NULL AND o.due IS NULL) sp ON true`,
    start: sql`(CASE WHEN o.start IS NOT NULL OR o.due IS NOT NULL THEN o.start ELSE sp.start END)`,
    due: sql`(CASE WHEN o.start IS NOT NULL OR o.due IS NOT NULL THEN o.due ELSE sp.due END)`,
    dated: sql`(CASE WHEN o.start IS NOT NULL OR o.due IS NOT NULL THEN 'own'
                     WHEN sp.start IS NOT NULL OR sp.due IS NOT NULL THEN 'sprint' END)`,
  };
}

export function registerPlanBaselineRoutes(
  app: FastifyInstance,
  db: Db,
  options: PlanBaselineOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  const baselineRows = (ws: number, planId: number) =>
    db
      .selectFrom('plan_baseline as b')
      .innerJoin('app_user as u', 'u.id', 'b.created_by')
      .select([
        'b.id',
        'b.name',
        'b.source',
        'b.scenario_name',
        'b.tickets',
        'b.created_by',
        'u.name as created_by_name',
        'b.created_at',
        'b.version',
      ])
      .where('b.workspace_id', '=', ws)
      .where('b.plan_id', '=', planId);

  const baselineOf = async (ws: number, planId: number, bid: number) =>
    (await baselineRows(ws, planId).where('b.id', '=', bid).executeTakeFirst()) as
      | BaselineRow
      | undefined;

  /**
   * Opens a plan and maybe one of its baselines: 401, 404 (a plan not seen, a baseline missing or
   * of another plan, word for word as a missing id), or 403 `edit_plan` for a write by someone who
   * may not change the plan.
   */
  async function opened(
    request: FastifyRequest,
    reply: FastifyReply,
    write: boolean,
    withBaseline: boolean,
  ) {
    const user = requireUser(request, reply);
    if (!user) return null;
    const p = baselineParams.safeParse(request.params);
    if (!p.success || (withBaseline && p.data.bid === undefined)) {
      await notFound(reply);
      return null;
    }
    const ws = request.workspaceId;
    let q = db
      .selectFrom('plan as p')
      .select(['p.id', 'p.name', 'p.owner_id'])
      .where('p.workspace_id', '=', ws)
      .where('p.id', '=', p.data.id);
    if (!(await request.authz.isSiteAdmin())) q = q.where(planVisible(ws, user.id));
    const found = await q.executeTakeFirst();
    if (!found) {
      await notFound(reply);
      return null;
    }
    const plan = { ...found, editable: await planEditable(request, found.owner_id) };
    let baseline: BaselineRow | undefined;
    if (withBaseline) {
      baseline = await baselineOf(ws, plan.id, p.data.bid as number);
      if (!baseline) {
        await notFound(reply);
        return null;
      }
    }
    if (write && !plan.editable) {
      await reply.code(403).send({ error: 'forbidden', permission: 'edit_plan' });
      return null;
    }
    return { user, plan, baseline: baseline as BaselineRow };
  }

  /** The plan's tickets for this person, with the page's filters in `where` and without in `unfiltered`. */
  async function shownTo(request: FastifyRequest, planId: number, filters: PlanFilters = {}) {
    return planTickets(db, options.catalogs, request, await sourceRows(db, [planId]), filters);
  }

  app.get('/api/v1/plans/:id/baselines', async (request, reply) => {
    const o = await opened(request, reply, false, false);
    if (!o) return reply;
    const rows = (await baselineRows(request.workspaceId, o.plan.id)
      .orderBy('b.created_at', 'desc')
      .orderBy('b.id', 'desc')
      .execute()) as BaselineRow[];
    return {
      plan: { id: o.plan.id, name: o.plan.name },
      editable: o.plan.editable,
      baselines: rows.map(baselineView),
      limits: BASELINE_LIMITS,
    };
  });

  app.post('/api/v1/plans/:id/baselines', async (request, reply) => {
    const o = await opened(request, reply, true, false);
    if (!o) return reply;
    const parsed = createBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const { name, scenarioId } = parsed.data;
    const ws = request.workspaceId;
    try {
      const tickets = await shownTo(request, o.plan.id);
      const shown = tickets.unfiltered;
      const outcome = await db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('statement_timeout', ${String(Math.max(1, Math.round(timeoutMs)))}, true)`.execute(
          trx,
        );
        // The plan's row orders captures, so two never pass the limit together.
        await lockPlan(trx, o.plan.id);
        let scenario: { id: number; name: string } | null = null;
        if (scenarioId !== undefined) {
          scenario =
            (await trx
              .selectFrom('plan_scenario')
              .select(['id', 'name'])
              .where('workspace_id', '=', ws)
              .where('plan_id', '=', o.plan.id)
              .where('id', '=', scenarioId)
              .executeTakeFirst()) ?? null;
          if (!scenario) return { fields: { scenarioId: 'not_found' } };
        }
        const held = await trx
          .selectFrom('plan_baseline')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('plan_id', '=', o.plan.id)
          .executeTakeFirstOrThrow();
        if (Number(held.n) >= MAX_BASELINES) {
          return { refused: 'too_many_baselines' as const, limit: MAX_BASELINES };
        }
        const visible = shown
          ? sql<boolean>`(k.deleted_at IS NULL AND ${shown})`
          : sql<boolean>`false`;
        // The whole plan as the capturer is shown it, counted first, as far as one past the limit.
        const counted =
          (
            await sql<{ n: number }>`
              SELECT count(*)::int AS n
                FROM (SELECT 1 FROM ticket k WHERE ${visible} LIMIT ${MAX_CAPTURED + 1}) x`.execute(
              trx,
            )
          ).rows[0]?.n ?? 0;
        if (counted > MAX_CAPTURED) {
          return { refused: 'plan_too_large' as const, limit: MAX_CAPTURED };
        }
        const made = await trx
          .insertInto('plan_baseline')
          .values({
            workspace_id: ws,
            plan_id: o.plan.id,
            name,
            source: scenario ? 'scenario' : 'live',
            scenario_name: scenario?.name ?? null,
            created_by: o.user.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        // One statement, so no limit on bound values applies however many tickets it holds.
        const now = daysNow(draftOverlay(scenario?.id ?? null, shown));
        const written = await sql`
          INSERT INTO plan_baseline_day
            (workspace_id, plan_id, baseline_id, ticket_id, start_date, due_date, dated, closed)
          SELECT ${ws}::int, ${o.plan.id}::int, ${made.id}::int, k.id, ${now.start}, ${now.due},
                 ${now.dated}, s.stage = 'closed'
            FROM ticket k
            JOIN status s ON s.id = k.status_id
            ${now.join}
           WHERE ${visible}`.execute(trx);
        const count = Number(written.numAffectedRows ?? 0);
        await trx
          .updateTable('plan_baseline')
          .set({ tickets: count })
          .where('id', '=', made.id)
          .execute();
        await emit(trx, by(request), {
          type: 'plan.baseline_captured',
          subjectId: o.plan.id,
          payload: {
            baselineId: made.id,
            source: scenario ? 'scenario' : 'live',
            tickets: count,
          },
        });
        return { id: made.id };
      });
      if ('fields' in outcome) return invalidFields(reply, outcome.fields);
      if ('refused' in outcome) {
        return reply.code(409).send({ error: outcome.refused, limit: outcome.limit });
      }
      const row = (await baselineOf(ws, o.plan.id, outcome.id)) as BaselineRow;
      return reply.code(201).send({ baseline: baselineView(row) });
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.patch('/api/v1/plans/:id/baselines/:bid', async (request, reply) => {
    const o = await opened(request, reply, true, true);
    if (!o) return reply;
    const parsed = renameBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const outcome = await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('plan_baseline')
        .select(['name', 'version'])
        .where('id', '=', o.baseline.id)
        .where('plan_id', '=', o.plan.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return { missing: true as const };
      if (locked.version !== parsed.data.version) return { conflict: locked.version };
      if (Object.keys(diff({ name: locked.name }, { name: parsed.data.name })).length === 0) {
        return { unchanged: true as const };
      }
      await trx
        .updateTable('plan_baseline')
        .set({ name: parsed.data.name, version: locked.version + 1, updated_at: new Date() })
        .where('id', '=', o.baseline.id)
        .execute();
      await emit(trx, by(request), {
        type: 'plan.baseline_renamed',
        subjectId: o.plan.id,
        payload: { baselineId: o.baseline.id },
      });
      return { renamed: true as const };
    });
    if ('missing' in outcome) return notFound(reply);
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: 'version_conflict', version: outcome.conflict });
    }
    const row = (await baselineOf(request.workspaceId, o.plan.id, o.baseline.id)) as BaselineRow;
    return { baseline: baselineView(row) };
  });

  app.delete('/api/v1/plans/:id/baselines/:bid', async (request, reply) => {
    const o = await opened(request, reply, true, true);
    if (!o) return reply;
    const q = versionQuery.safeParse(request.query ?? {});
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const outcome = await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('plan_baseline')
        .select(['version'])
        .where('id', '=', o.baseline.id)
        .where('plan_id', '=', o.plan.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return { missing: true as const };
      if (locked.version !== q.data.version) return { conflict: locked.version };
      // Its rows go with it, those on tickets hidden from the deleter too.
      await trx.deleteFrom('plan_baseline').where('id', '=', o.baseline.id).execute();
      await emit(trx, by(request), {
        type: 'plan.baseline_deleted',
        subjectId: o.plan.id,
        payload: { baselineId: o.baseline.id },
      });
      return { deleted: true as const };
    });
    if ('missing' in outcome) return notFound(reply);
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: 'version_conflict', version: outcome.conflict });
    }
    return reply.code(204).send();
  });

  app.get('/api/v1/plans/:id/baselines/:bid/compare', async (request, reply) => {
    const o = await opened(request, reply, false, true);
    if (!o) return reply;
    const q = compareQuery.safeParse(request.query ?? {});
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const { scenario: scenarioParam, show: asked, after, ...filters } = q.data;
    const show: Show = asked ?? 'slipped';
    const cursor = after === undefined ? null : decodeCursor(after);
    if (after !== undefined && !cursor) return invalidFields(reply, { after: 'invalid' });
    const ws = request.workspaceId;
    const b = o.baseline;
    try {
      const tickets = await shownTo(request, o.plan.id, filters);
      const scenario = await viewScenario(db, ws, o.plan.id, scenarioParam, tickets.unfiltered);
      if (scenario === 'not_found') return invalidFields(reply, { scenario: 'not_found' });
      const shown = tickets.unfiltered;
      const where = tickets.where;
      const visible = shown
        ? sql<boolean>`(k.deleted_at IS NULL AND ${shown})`
        : sql<boolean>`false`;
      const read = await readOnly(db, timeoutMs, async (trx) => {
        // Rows of the baseline whose ticket the reader is not shown in the plan now: one number.
        const notShown =
          (
            await sql<{ n: number }>`
              SELECT count(*)::int AS n
                FROM plan_baseline_day b JOIN ticket k ON k.id = b.ticket_id
               WHERE b.baseline_id = ${b.id}::int AND (${visible}) IS NOT TRUE`.execute(trx)
          ).rows[0]?.n ?? 0;
        if (!where) {
          return { notShown, counts: null, page: [] as PageRow[], names: new Map<number, Named>() };
        }
        const now = daysNow(draftOverlay(scenario?.id ?? null, shown));
        // The reader's plan with the page's filters, each ticket joined to its row, if any.
        const z = sql`
          SELECT x.*, (x.n_end - x.t_end) AS delay,
                 (COALESCE(x.n_start, x.n_due) - COALESCE(x.t_start, x.t_due)) AS start_shift,
                 COALESCE(x.n_end - x.t_end, ${NO_DELAY}::int) AS sort_key
            FROM (
              SELECT k.id, k.rank, s.stage = 'closed' AS closed,
                     bd.ticket_id IS NOT NULL AS in_base,
                     bd.start_date AS t_start, bd.due_date AS t_due, bd.dated AS t_dated,
                     GREATEST(bd.start_date, bd.due_date) AS t_end,
                     ${now.start} AS n_start, ${now.due} AS n_due, ${now.dated} AS n_dated,
                     GREATEST(${now.start}, ${now.due}) AS n_end
                FROM ticket k
                JOIN status s ON s.id = k.status_id
                ${now.join}
                LEFT JOIN plan_baseline_day bd
                  ON bd.baseline_id = ${b.id}::int AND bd.ticket_id = k.id
               WHERE k.deleted_at IS NULL AND ${where}) x`;
        const wanted: Record<Show, RawBuilder<boolean>> = {
          slipped: sql<boolean>`z.delay > 0`,
          earlier: sql<boolean>`z.delay < 0`,
          added: sql<boolean>`NOT z.in_base`,
          all: sql<boolean>`true`,
        };
        const from = cursor
          ? sql<boolean>`(z.sort_key < ${cursor.d}::int
              OR (z.sort_key = ${cursor.d}::int
                  AND (z.rank > ${cursor.r}::text OR (z.rank = ${cursor.r}::text AND z.id > ${cursor.i}::int))))`
          : sql<boolean>`true`;
        const row = (
          await sql<{ counts: Counts; page: PageRow[] | null }>`
            WITH z AS MATERIALIZED (${z})
            SELECT (SELECT row_to_json(c) FROM (
                      SELECT count(*) FILTER (WHERE delay IS NOT NULL)::int AS compared,
                             count(*) FILTER (WHERE delay > 0)::int AS slipped,
                             count(*) FILTER (WHERE delay < 0)::int AS earlier,
                             count(*) FILTER (WHERE delay = 0)::int AS same,
                             count(*) FILTER (WHERE NOT in_base)::int AS added_since,
                             count(*) FILTER (WHERE in_base AND t_end IS NULL)::int AS undated_then,
                             count(*) FILTER (WHERE t_end IS NOT NULL AND n_end IS NULL)::int
                               AS undated_now,
                             max(delay)::int AS most,
                             (max(t_end) FILTER (WHERE delay IS NOT NULL))::text AS then_end,
                             (max(n_end) FILTER (WHERE delay IS NOT NULL))::text AS now_end
                        FROM z) c) AS counts,
                   (SELECT json_agg(p ORDER BY p.sort_key DESC, p.rank, p.id) FROM (
                      SELECT z.id, z.rank, z.closed, z.in_base, z.t_start::text, z.t_due::text,
                             z.t_dated, z.n_start::text, z.n_due::text, z.n_dated, z.delay,
                             z.start_shift, z.sort_key
                        FROM z
                       WHERE ${wanted[show]} AND ${from}
                       ORDER BY z.sort_key DESC, z.rank, z.id
                       LIMIT ${COMPARE_PAGE + 1}) p) AS page`.execute(trx)
        ).rows[0];
        const page = row?.page ?? [];
        const ids = page.slice(0, COMPARE_PAGE).map((p) => p.id);
        const names = new Map<number, Named>(
          (ids.length === 0
            ? []
            : (
                await sql<Named>`
                  SELECT k.id, t.key || '-' || k.number AS key, k.summary,
                         h.rank AS level_rank, h.kind AS level_kind
                    FROM ticket k
                    JOIN track t ON t.id = k.track_id
                    JOIN ticket_type y ON y.id = k.ticket_type_id
                    JOIN hierarchy_level h ON h.id = y.level_id
                   WHERE k.id = ANY(${ids}::int[])`.execute(trx)
              ).rows
          ).map((r) => [r.id, r]),
        );
        return { notShown, counts: row?.counts ?? null, page, names };
      });
      const c = read.counts;
      const listed = read.page.slice(0, COMPARE_PAGE);
      const last = listed.at(-1);
      const more = read.page.length > COMPARE_PAGE && last !== undefined;
      const days = (start: string | null, due: string | null, dated: SideDays['dated']) => ({
        start,
        due,
        dated,
      });
      return {
        baseline: {
          id: b.id,
          name: b.name,
          source: b.source,
          scenarioName: b.scenario_name,
          createdAt: b.created_at,
        },
        against: scenario ? { scenario: { id: scenario.id, name: scenario.name } } : 'live',
        query: tickets.query,
        counts: {
          compared: c?.compared ?? 0,
          slipped: c?.slipped ?? 0,
          earlier: c?.earlier ?? 0,
          same: c?.same ?? 0,
          addedSince: c?.added_since ?? 0,
          undatedThen: c?.undated_then ?? 0,
          undatedNow: c?.undated_now ?? 0,
          notShown: read.notShown,
        },
        // The most a compared ticket ends later or earlier, in days; null when none is compared.
        mostLater: c?.most ?? null,
        planEnd: {
          was: c?.then_end ?? null,
          now: c?.now_end ?? null,
          delay:
            c?.then_end && c?.now_end
              ? Math.round(
                  (Date.parse(`${c.now_end}T00:00:00Z`) - Date.parse(`${c.then_end}T00:00:00Z`)) /
                    86_400_000,
                )
              : null,
        },
        show,
        tickets: listed.map((p) => {
          const n = read.names.get(p.id);
          return {
            id: p.id,
            key: n?.key ?? '',
            summary: n?.summary ?? '',
            level: { rank: n?.level_rank ?? 0, kind: n?.level_kind ?? '' },
            closed: p.closed,
            was: p.in_base ? days(p.t_start, p.t_due, p.t_dated) : null,
            now: days(p.n_start, p.n_due, p.n_dated),
            delay: p.delay,
            startShift: p.start_shift,
          };
        }),
        next: more ? encodeCursor({ d: last.sort_key, r: last.rank, i: last.id }) : null,
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });
}

interface Counts {
  compared: number;
  slipped: number;
  earlier: number;
  same: number;
  added_since: number;
  undated_then: number;
  undated_now: number;
  most: number | null;
  then_end: string | null;
  now_end: string | null;
}

interface Named {
  id: number;
  key: string;
  summary: string;
  level_rank: number;
  level_kind: string;
}

interface PageRow {
  id: number;
  rank: string;
  closed: boolean;
  in_base: boolean;
  t_start: string | null;
  t_due: string | null;
  t_dated: SideDays['dated'];
  n_start: string | null;
  n_due: string | null;
  n_dated: SideDays['dated'];
  delay: number | null;
  start_shift: number | null;
  sort_key: number;
}
