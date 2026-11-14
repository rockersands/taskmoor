import type { Database, JsonValue, PlanDraftField } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import { requireUser } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import { diff, emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import {
  ALREADY,
  APPLY_CONCURRENCY,
  applyBody,
  applying,
  CHANGED,
  CHANGES_PAGE,
  changesQuery,
  compareQuery,
  createScenarioBody,
  DIFFERING,
  type DraftValue,
  type DraftWrite,
  discardBody,
  draftOverlay,
  draftsBody,
  draftValue,
  LIMITS,
  LIVE_JSON,
  liveValue,
  MAX_DRAFTED_TICKETS,
  MAX_SCENARIOS,
  type Refusal,
  refusalOf,
  renameScenarioBody,
  sameValue,
  scenarioParams,
  scenarioRows,
  teamFieldOf,
  teamKey,
  versionBody,
  versionQuery,
  writeDrafts,
} from '../plans/drafts';
import { idParam, type PlanFilters } from '../plans/model';
import { planTickets, sourceRows } from '../plans/query';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { callRoute, type TicketRoute } from '../tickets/caller';
import { planTeams, planVisible } from './plans';
import { searchRefusal } from './search';
import { ticketRoutes } from './tickets';

/**
 * Scenarios and draft changes of a Multi-track plan (T-089e; PLN-002, PLN-003; ADR-122 stage 6).
 *
 * - `GET /plans/:id/scenarios` lists the plan's scenarios, each with the drafted tickets this
 *   viewer is shown and how many others it holds (`notShown`); `POST` makes one (the first is
 *   main), empty or from another's drafts the maker is shown; `PATCH`, `DELETE` and
 *   `.../promote` rename, remove and make one main.
 * - `GET .../changes` is the change list, a ticket a row; `PUT .../drafts` drafts days and Team
 *   values; `POST .../discard` removes drafts; `POST .../apply` applies the main scenario's drafts,
 *   ticket by ticket, through the ticket's own `PATCH` as the applier.
 * - `GET /plans/:id/compare?a=&b=` compares two sides, each the tickets as they are (`live`) or a
 *   scenario, by the plan's end and each team's end, and lists the tickets that differ.
 * - A plan gives no access: drafts show only on tickets the plan shows the person (`unfiltered`);
 *   the rest are counted, never named. Writes are for the plan's owner and site administrators
 *   (`edit_plan`). A plan the person may not see, and a scenario of another plan, answer 404.
 * - Every write emits one `plan.*` event in its transaction, audited; the apply's comes in its own
 *   transaction after the tickets' changes, each of which emits its own `ticket.updated`.
 */
type Db = Kysely<Database> | Transaction<Database>;

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

export interface PlanScenarioOptions {
  catalogs: FieldCatalogs;
  authorizer: Authorizer;
  timeoutMs?: number;
}

interface ScenarioRow {
  id: number;
  name: string;
  main: boolean;
  created_by: number;
  created_by_name: string;
  applying_since: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** Drafted tickets in each scenario: those shown to the viewer, and the rest counted. */
export async function draftCounts(
  db: Db,
  scenarioIds: readonly number[],
  shown: RawBuilder<boolean> | null,
): Promise<Map<number, { drafts: number; notShown: number }>> {
  const out = new Map<number, { drafts: number; notShown: number }>();
  if (scenarioIds.length === 0) return out;
  const visible = shown ? sql<boolean>`(k.deleted_at IS NULL AND ${shown})` : sql<boolean>`false`;
  const rows = (
    await sql<{ scenario_id: number; shown: number; total: number }>`
      SELECT x.scenario_id, count(*) FILTER (WHERE x.shown)::int AS shown, count(*)::int AS total
        FROM (SELECT DISTINCT d.scenario_id, d.ticket_id, (${visible}) IS TRUE AS shown
                FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id
               WHERE d.scenario_id = ANY(${[...scenarioIds]}::int[])) x
       GROUP BY x.scenario_id`.execute(db)
  ).rows;
  for (const id of scenarioIds) out.set(id, { drafts: 0, notShown: 0 });
  for (const r of rows) out.set(r.scenario_id, { drafts: r.shown, notShown: r.total - r.shown });
  return out;
}

const scenarioView = (s: ScenarioRow, counts: { drafts: number; notShown: number }) => ({
  id: s.id,
  name: s.name,
  main: s.main,
  drafts: counts.drafts,
  notShown: counts.notShown,
  applying: applying(s.applying_since),
  createdBy: { id: s.created_by, name: s.created_by_name },
  createdAt: s.created_at,
  updatedAt: s.updated_at,
  version: s.version,
});

/**
 * The scenario a view reads (`scenario=`), as its answer names it, or `not_found` for one that is
 * missing or of another plan; null without one.
 */
export async function viewScenario(
  db: Db,
  ws: number,
  planId: number,
  scenario: string | undefined,
  shown: RawBuilder<boolean> | null,
): Promise<
  null | 'not_found' | { id: number; name: string; main: boolean; drafts: number; notShown: number }
> {
  if (scenario === undefined) return null;
  const row = await db
    .selectFrom('plan_scenario')
    .select(['id', 'name', 'main'])
    .where('workspace_id', '=', ws)
    .where('plan_id', '=', planId)
    .where('id', '=', Number(scenario))
    .executeTakeFirst();
  if (!row) return 'not_found';
  const counts = (await draftCounts(db, [row.id], shown)).get(row.id) ?? {
    drafts: 0,
    notShown: 0,
  };
  return { ...row, ...counts };
}

/** What a field of a change says: its value when drafted, now, and drafted. */
interface FieldEntry {
  field: string;
  teamFieldId: number | null;
  was: DraftValue;
  now: DraftValue;
  draft: DraftValue;
  state: 'ready' | 'changed' | 'already';
}

type ChangeState = 'ready' | 'changed' | 'already' | 'refused';

export function registerPlanScenarioRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: PlanScenarioOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const handlers = ticketRoutes(db, options.authorizer, options.catalogs);
  const updateTicket = handlers.find(
    (r) => r.method === 'PATCH' && r.url === '/api/v1/tickets/:id',
  ) as TicketRoute;
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  /** The plan when the person sees it (site administrators see every one), and whether they edit it. */
  async function visiblePlan(request: FastifyRequest, id: number) {
    const ws = request.workspaceId;
    let q = db
      .selectFrom('plan as p')
      .select(['p.id', 'p.name', 'p.owner_id'])
      .where('p.workspace_id', '=', ws)
      .where('p.id', '=', id);
    const admin = await request.authz.isSiteAdmin();
    if (!admin) q = q.where(planVisible(ws, request.user?.id as number));
    const plan = await q.executeTakeFirst();
    if (!plan) return null;
    return { ...plan, editable: admin || plan.owner_id === request.user?.id };
  }

  /** The plan's tickets for this person without the filters: where their drafts show. */
  async function shownTo(request: FastifyRequest, planId: number, filters: PlanFilters = {}) {
    const tickets = await planTickets(
      db,
      options.catalogs,
      request,
      await sourceRows(db, [planId]),
      filters,
    );
    return tickets;
  }

  async function scenarioOf(q: Db, ws: number, planId: number, sid: number) {
    return (await scenarioRows(q, ws, planId).where('s.id', '=', sid).executeTakeFirst()) as
      | ScenarioRow
      | undefined;
  }

  /**
   * Opens a plan and maybe one of its scenarios: 401, 404 (a plan not seen, a scenario missing or
   * of another plan), or 403 `edit_plan` for a write by someone who may not change the plan.
   */
  async function opened(
    request: FastifyRequest,
    reply: FastifyReply,
    write: boolean,
    withScenario: boolean,
  ) {
    const user = requireUser(request, reply);
    if (!user) return null;
    const p = withScenario
      ? scenarioParams.safeParse(request.params)
      : idParam.extend({ sid: idParam.shape.id.optional() }).safeParse(request.params);
    if (!p.success) {
      await notFound(reply);
      return null;
    }
    const plan = await visiblePlan(request, p.data.id);
    if (!plan) {
      await notFound(reply);
      return null;
    }
    let scenario: ScenarioRow | undefined;
    if (withScenario) {
      scenario = await scenarioOf(db, request.workspaceId, plan.id, p.data.sid as number);
      if (!scenario) {
        await notFound(reply);
        return null;
      }
    }
    if (write && !plan.editable) {
      await reply.code(403).send({ error: 'forbidden', permission: 'edit_plan' });
      return null;
    }
    return { user, plan, scenario: scenario as ScenarioRow };
  }

  /** How many drafted tickets a scenario holds in all. */
  async function draftedTickets(q: Db, scenarioId: number) {
    const row = await sql<{ n: number }>`
      SELECT count(DISTINCT ticket_id)::int AS n FROM plan_draft
       WHERE scenario_id = ${scenarioId}::int`.execute(q);
    return row.rows[0]?.n ?? 0;
  }

  /**
   * The change list for a person: their shown tickets with drafts in the scenario, a ticket a row,
   * from `cursor` (a ticket id) in id order, of one state when `only` is given, or exactly the
   * tickets named. With the counts of shown tickets per state and of those not shown.
   */
  async function changeList(
    request: FastifyRequest,
    scenarioId: number,
    shown: RawBuilder<boolean> | null,
    page: { cursor?: number; only?: 'ready' | 'refused' | 'changed'; ids?: readonly number[] },
  ) {
    const ws = request.workspaceId;
    const visible = shown ? sql<boolean>`(k.deleted_at IS NULL AND ${shown})` : sql<boolean>`false`;
    return readOnly(db, timeoutMs, async (trx) => {
      const states = sql`
        WITH d AS (
          SELECT d.ticket_id, ${ALREADY} AS already, ${CHANGED} AS changed,
                 d.refusal IS NOT NULL AS refused
            FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id
           WHERE d.scenario_id = ${scenarioId}::int AND ${visible}
        ), t AS (
          SELECT ticket_id, bool_or(changed) AS changed, bool_or(refused) AS refused,
                 bool_and(already) AS already
            FROM d GROUP BY ticket_id
        )
        SELECT ticket_id,
               CASE WHEN changed THEN 'changed' WHEN refused THEN 'refused'
                    WHEN already THEN 'already' ELSE 'ready' END AS state
          FROM t`;
      const counts = (
        await sql<{ state: ChangeState; n: number }>`
          SELECT state, count(*)::int AS n FROM (${states}) s GROUP BY state`.execute(trx)
      ).rows;
      const notShown =
        (
          await sql<{ n: number }>`
            SELECT count(DISTINCT d.ticket_id)::int AS n
              FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id
             WHERE d.scenario_id = ${scenarioId}::int AND (${visible}) IS NOT TRUE`.execute(trx)
        ).rows[0]?.n ?? 0;
      const wanted =
        page.only === 'ready'
          ? sql`AND s.state IN ('ready', 'already')`
          : page.only
            ? sql`AND s.state = ${page.only}`
            : sql``;
      const picked = (
        await sql<{ ticket_id: number; state: ChangeState }>`
          SELECT s.ticket_id, s.state FROM (${states}) s
           WHERE s.ticket_id > ${page.cursor ?? 0}::int ${wanted}
             ${page.ids ? sql`AND s.ticket_id = ANY(${[...page.ids]}::int[])` : sql``}
           ORDER BY s.ticket_id
           LIMIT ${page.ids ? page.ids.length : CHANGES_PAGE + 1}`.execute(trx)
      ).rows;
      const more = !page.ids && picked.length > CHANGES_PAGE;
      const listed = picked.slice(0, page.ids ? picked.length : CHANGES_PAGE);
      const ids = listed.map((r) => r.ticket_id);
      const rows =
        ids.length === 0
          ? []
          : (
              await sql<{
                ticket_id: number;
                field: string;
                team_field_id: number | null;
                old_value: JsonValue | null;
                new_value: JsonValue | null;
                live: JsonValue;
                already: boolean;
                changed: boolean;
                origin: 'person' | 'scheduler';
                updated_by: number;
                updated_by_name: string;
                updated_at: Date;
                refusal: JsonValue | null;
                refused_at: Date | null;
                key: string;
                summary: string;
                track_id: number;
                version: number;
                requester_id: number | null;
                assignee_id: number | null;
                visibility_level_id: number | null;
                fields: Record<string, unknown>;
              }>`
                SELECT d.ticket_id, d.field, d.team_field_id, d.old_value, d.new_value,
                       ${LIVE_JSON} AS live, ${ALREADY} AS already, ${CHANGED} AS changed,
                       d.origin, d.updated_by, u.name AS updated_by_name, d.updated_at,
                       d.refusal, d.refused_at, t.key || '-' || k.number AS key, k.summary,
                       k.track_id, k.version, k.requester_id, k.assignee_id,
                       k.visibility_level_id, k.fields
                  FROM plan_draft d
                  JOIN ticket k ON k.id = d.ticket_id
                  JOIN track t ON t.id = k.track_id
                  JOIN app_user u ON u.id = d.updated_by
                 WHERE d.scenario_id = ${scenarioId}::int AND d.ticket_id = ANY(${ids}::int[])
                 ORDER BY d.ticket_id, d.field`.execute(trx)
            ).rows;
      const teamIds = new Set<number>();
      const fieldIds = new Set<number>();
      for (const r of rows) {
        if (r.team_field_id === null) continue;
        fieldIds.add(r.team_field_id);
        for (const v of [r.old_value, r.new_value, r.live]) {
          if (typeof v === 'number') teamIds.add(v);
        }
      }
      const teams =
        teamIds.size === 0
          ? []
          : await trx
              .selectFrom('team')
              .select(['id', 'name'])
              .where('workspace_id', '=', ws)
              .where('id', 'in', [...teamIds])
              .orderBy('id')
              .execute();
      const teamFields =
        fieldIds.size === 0
          ? []
          : await trx
              .selectFrom('field')
              .select(['id', 'name'])
              .where('workspace_id', '=', ws)
              .where('id', 'in', [...fieldIds])
              .orderBy('id')
              .execute();
      return { counts, notShown, listed, rows, teams, teamFields, more };
    }).then(async (read) => {
      const stateOf = new Map(read.listed.map((r) => [r.ticket_id, r.state]));
      const byTicket = new Map<number, (typeof read.rows)[number][]>();
      for (const r of read.rows) {
        const list = byTicket.get(r.ticket_id) ?? [];
        list.push(r);
        byTicket.set(r.ticket_id, list);
      }
      const changes = [];
      for (const r of read.listed) {
        const drafts = byTicket.get(r.ticket_id) ?? [];
        const first = drafts[0];
        if (!first) continue;
        // What the person may apply: days need "Schedule tickets", a Team value "Edit tickets".
        const held = await request.authz.ticket({
          id: first.ticket_id,
          track_id: first.track_id,
          requester_id: first.requester_id,
          assignee_id: first.assignee_id,
          visibility_level_id: first.visibility_level_id,
          fields: first.fields ?? {},
        });
        const needs = drafts.some((d) => d.team_field_id === null && !d.already)
          ? !held.has('schedule_tickets')
            ? 'schedule_tickets'
            : null
          : null;
        const needsEdit =
          needs === null &&
          drafts.some((d) => d.team_field_id !== null && !d.already) &&
          !held.has('edit_tickets')
            ? 'edit_tickets'
            : null;
        const last = drafts.reduce((a, b) => (b.updated_at > a.updated_at ? b : a), first);
        const refused = drafts.find((d) => d.refusal !== null);
        changes.push({
          ticketId: first.ticket_id,
          key: first.key,
          summary: first.summary,
          trackId: first.track_id,
          version: first.version,
          state: stateOf.get(r.ticket_id) as ChangeState,
          fields: drafts.map(
            (d): FieldEntry => ({
              field: d.field,
              teamFieldId: d.team_field_id,
              was: draftValue(d.old_value),
              now: draftValue(d.live),
              draft: draftValue(d.new_value),
              state: d.already ? 'already' : d.changed ? 'changed' : 'ready',
            }),
          ),
          mayApply: (needs ?? needsEdit) === null,
          needs: needs ?? needsEdit,
          refusal: (refused?.refusal ?? null) as Refusal | null,
          refusedAt: refused?.refused_at ?? null,
          origin: drafts.some((d) => d.origin === 'scheduler') ? 'scheduler' : 'person',
          updatedBy: { id: last.updated_by, name: last.updated_by_name },
          updatedAt: last.updated_at,
        });
      }
      const count = (s: ChangeState) => read.counts.find((c) => c.state === s)?.n ?? 0;
      return {
        changes,
        counts: {
          ready: count('ready'),
          already: count('already'),
          changed: count('changed'),
          refused: count('refused'),
        },
        drafts: read.counts.reduce((a, c) => a + c.n, 0),
        notShown: read.notShown,
        teams: read.teams,
        teamFields: read.teamFields,
        next: read.more ? (read.listed.at(-1)?.ticket_id ?? null) : null,
      };
    });
  }

  app.get('/api/v1/plans/:id/scenarios', async (request, reply) => {
    const o = await opened(request, reply, false, false);
    if (!o) return reply;
    try {
      const tickets = await shownTo(request, o.plan.id);
      const rows = (await scenarioRows(db, request.workspaceId, o.plan.id)
        .orderBy('s.main', 'desc')
        .orderBy(sql`lower(s.name)`)
        .orderBy('s.id')
        .execute()) as ScenarioRow[];
      const counts = await readOnly(db, timeoutMs, (trx) =>
        draftCounts(
          trx,
          rows.map((r) => r.id),
          tickets.unfiltered,
        ),
      );
      return {
        plan: { id: o.plan.id, name: o.plan.name },
        editable: o.plan.editable,
        scenarios: rows.map((r) => scenarioView(r, counts.get(r.id) ?? { drafts: 0, notShown: 0 })),
        limits: LIMITS,
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.post('/api/v1/plans/:id/scenarios', async (request, reply) => {
    const o = await opened(request, reply, true, false);
    if (!o) return reply;
    const parsed = createScenarioBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const { name, from } = parsed.data;
    const ws = request.workspaceId;
    try {
      const tickets = from === undefined ? null : await shownTo(request, o.plan.id);
      const shown = tickets?.unfiltered ?? null;
      const outcome = await db.transaction().execute(async (trx) => {
        // The plan's row orders scenario writes, so two makers never pass the limit together.
        await trx
          .selectFrom('plan')
          .select('id')
          .where('id', '=', o.plan.id)
          .forUpdate()
          .executeTakeFirst();
        const existing = await trx
          .selectFrom('plan_scenario')
          .select(['id'])
          .where('plan_id', '=', o.plan.id)
          .execute();
        if (existing.length >= MAX_SCENARIOS) return { refused: 'too_many_scenarios' as const };
        if (from !== undefined && !existing.some((s) => s.id === from)) {
          return { fields: { from: 'not_found' } };
        }
        const made = await trx
          .insertInto('plan_scenario')
          .values({
            workspace_id: ws,
            plan_id: o.plan.id,
            name,
            main: existing.length === 0,
            created_by: o.user.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        let copied = 0;
        let notShown = 0;
        if (from !== undefined) {
          const visible = shown
            ? sql<boolean>`(k.deleted_at IS NULL AND ${shown})`
            : sql<boolean>`false`;
          const inserted = await sql<{ ticket_id: number }>`
            INSERT INTO plan_draft (workspace_id, plan_id, scenario_id, ticket_id, field,
                                    team_field_id, old_value, new_value, origin, updated_by)
            SELECT d.workspace_id, d.plan_id, ${made.id}::int, d.ticket_id, d.field,
                   d.team_field_id, d.old_value, d.new_value, d.origin, ${o.user.id}::int
              FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id
             WHERE d.scenario_id = ${from}::int AND ${visible}
            RETURNING ticket_id`.execute(trx);
          copied = new Set(inserted.rows.map((r) => r.ticket_id)).size;
          notShown =
            (
              await sql<{ n: number }>`
                SELECT count(DISTINCT d.ticket_id)::int AS n
                  FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id
                 WHERE d.scenario_id = ${from}::int AND (${visible}) IS NOT TRUE`.execute(trx)
            ).rows[0]?.n ?? 0;
        }
        await emit(trx, by(request), {
          type: 'plan.scenario_created',
          subjectId: o.plan.id,
          payload: { scenarioId: made.id, name, from: from ?? null, drafts: copied, notShown },
        });
        return { id: made.id, copied, notShown };
      });
      if ('refused' in outcome) {
        return reply.code(409).send({ error: outcome.refused, limit: MAX_SCENARIOS });
      }
      if ('fields' in outcome)
        return invalidFields(reply, outcome.fields as Record<string, string>);
      const row = (await scenarioOf(db, ws, o.plan.id, outcome.id)) as ScenarioRow;
      return reply.code(201).send({
        scenario: scenarioView(row, { drafts: outcome.copied, notShown: 0 }),
        left: { notShown: outcome.notShown },
      });
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.patch('/api/v1/plans/:id/scenarios/:sid', async (request, reply) => {
    const o = await opened(request, reply, true, true);
    if (!o) return reply;
    const parsed = renameScenarioBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const ws = request.workspaceId;
    const outcome = await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('plan_scenario')
        .select(['name', 'version'])
        .where('id', '=', o.scenario.id)
        .where('plan_id', '=', o.plan.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return { missing: true as const };
      if (locked.version !== parsed.data.version) return { conflict: locked.version };
      const changes = diff({ name: locked.name }, { name: parsed.data.name });
      if (Object.keys(changes).length === 0) return { unchanged: true as const };
      await trx
        .updateTable('plan_scenario')
        .set({ name: parsed.data.name, version: locked.version + 1, updated_at: new Date() })
        .where('id', '=', o.scenario.id)
        .execute();
      await emit(trx, by(request), {
        type: 'plan.scenario_updated',
        subjectId: o.plan.id,
        payload: { scenarioId: o.scenario.id, changes },
      });
      return { updated: true as const };
    });
    if ('missing' in outcome) return notFound(reply);
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: 'version_conflict', version: outcome.conflict });
    }
    try {
      const tickets = await shownTo(request, o.plan.id);
      const row = (await scenarioOf(db, ws, o.plan.id, o.scenario.id)) as ScenarioRow;
      const counts = (await draftCounts(db, [row.id], tickets.unfiltered)).get(row.id);
      return { scenario: scenarioView(row, counts ?? { drafts: 0, notShown: 0 }) };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.delete('/api/v1/plans/:id/scenarios/:sid', async (request, reply) => {
    const o = await opened(request, reply, true, true);
    if (!o) return reply;
    const q = versionQuery.safeParse(request.query ?? {});
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const outcome = await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('plan_scenario')
        .select(['name', 'main', 'version', 'applying_since'])
        .where('id', '=', o.scenario.id)
        .where('plan_id', '=', o.plan.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return { missing: true as const };
      if (locked.version !== q.data.version) return { conflict: locked.version };
      if (applying(locked.applying_since)) return { refused: 'apply_in_progress' as const };
      if (locked.main) {
        const others = await trx
          .selectFrom('plan_scenario')
          .select('id')
          .where('plan_id', '=', o.plan.id)
          .where('id', '<>', o.scenario.id)
          .executeTakeFirst();
        if (others) return { refused: 'main_scenario' as const };
      }
      // Every draft goes with it, those on tickets hidden from the deleter too, as the dialog says.
      const drafts = await draftedTickets(trx, o.scenario.id);
      await trx.deleteFrom('plan_scenario').where('id', '=', o.scenario.id).execute();
      await emit(trx, by(request), {
        type: 'plan.scenario_deleted',
        subjectId: o.plan.id,
        payload: { scenarioId: o.scenario.id, name: locked.name, drafts },
      });
      return { deleted: true as const };
    });
    if ('missing' in outcome) return notFound(reply);
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: 'version_conflict', version: outcome.conflict });
    }
    if ('refused' in outcome) return reply.code(409).send({ error: outcome.refused });
    return reply.code(204).send();
  });

  app.post('/api/v1/plans/:id/scenarios/:sid/promote', async (request, reply) => {
    const o = await opened(request, reply, true, true);
    if (!o) return reply;
    const parsed = versionBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const ws = request.workspaceId;
    const outcome = await db.transaction().execute(async (trx) => {
      // The main scenario's lock first, then the chosen one's, as every apply takes them.
      const main = await trx
        .selectFrom('plan_scenario')
        .select(['id', 'version', 'applying_since'])
        .where('plan_id', '=', o.plan.id)
        .where('main', '=', true)
        .forUpdate()
        .executeTakeFirst();
      const chosen = await trx
        .selectFrom('plan_scenario')
        .select(['id', 'main', 'version'])
        .where('id', '=', o.scenario.id)
        .where('plan_id', '=', o.plan.id)
        .forUpdate()
        .executeTakeFirst();
      if (!chosen) return { missing: true as const };
      if (chosen.version !== parsed.data.version) return { conflict: chosen.version };
      if (chosen.main) return { unchanged: true as const };
      if (main && applying(main.applying_since)) return { refused: 'apply_in_progress' as const };
      const now = new Date();
      if (main) {
        await trx
          .updateTable('plan_scenario')
          .set({ main: false, version: main.version + 1, updated_at: now })
          .where('id', '=', main.id)
          .execute();
      }
      await trx
        .updateTable('plan_scenario')
        .set({ main: true, version: chosen.version + 1, updated_at: now })
        .where('id', '=', chosen.id)
        .execute();
      await emit(trx, by(request), {
        type: 'plan.scenario_promoted',
        subjectId: o.plan.id,
        payload: { scenarioId: chosen.id, formerMain: main?.id ?? null },
      });
      return { promoted: true as const };
    });
    if ('missing' in outcome) return notFound(reply);
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: 'version_conflict', version: outcome.conflict });
    }
    if ('refused' in outcome) return reply.code(409).send({ error: outcome.refused });
    try {
      const tickets = await shownTo(request, o.plan.id);
      const rows = (await scenarioRows(db, ws, o.plan.id)
        .orderBy('s.main', 'desc')
        .orderBy(sql`lower(s.name)`)
        .orderBy('s.id')
        .execute()) as ScenarioRow[];
      const counts = await draftCounts(
        db,
        rows.map((r) => r.id),
        tickets.unfiltered,
      );
      return {
        scenarios: rows.map((r) => scenarioView(r, counts.get(r.id) ?? { drafts: 0, notShown: 0 })),
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.get('/api/v1/plans/:id/scenarios/:sid/changes', async (request, reply) => {
    const o = await opened(request, reply, false, true);
    if (!o) return reply;
    const q = changesQuery.safeParse(request.query ?? {});
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    try {
      const tickets = await shownTo(request, o.plan.id);
      const list = await changeList(request, o.scenario.id, tickets.unfiltered, {
        ...(q.data.cursor !== undefined ? { cursor: q.data.cursor } : {}),
        ...(q.data.only !== undefined ? { only: q.data.only } : {}),
      });
      return {
        scenario: { id: o.scenario.id, name: o.scenario.name, main: o.scenario.main },
        editable: o.plan.editable,
        applying: applying(o.scenario.applying_since),
        ...list,
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.put('/api/v1/plans/:id/scenarios/:sid/drafts', async (request, reply) => {
    const o = await opened(request, reply, true, true);
    if (!o) return reply;
    const parsed = draftsBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const changes = parsed.data.changes;
    const ws = request.workspaceId;
    try {
      const tickets = await shownTo(request, o.plan.id);
      const shown = tickets.unfiltered;
      const ids = changes.map((c) => c.ticketId);
      // The tickets of the plan for the editor, outside the trash; any other answers as missing.
      const live = new Map(
        shown === null
          ? []
          : (
              await readOnly(db, timeoutMs, (trx) =>
                sql<{
                  id: number;
                  start_date: string | null;
                  due_date: string | null;
                  fields: Record<string, unknown>;
                }>`
                  SELECT k.id, k.start_date::text AS start_date, k.due_date::text AS due_date,
                         k.fields
                    FROM ticket k
                   WHERE k.id = ANY(${ids}::int[]) AND k.deleted_at IS NULL
                     AND ${shown}`.execute(trx),
              )
            ).rows.map((r) => [r.id, r]),
      );
      const fields: Record<string, string> = {};
      changes.forEach((c, i) => {
        if (!live.has(c.ticketId)) fields[`changes.${i}.ticketId`] = 'not_found';
      });
      // Team fields: shared, single-value fields of type `team`; teams of this site.
      const fieldIds = [
        ...new Set(changes.flatMap((c) => Object.keys(c.fields ?? {}).map(Number))),
      ];
      const teamFieldIds = new Set(
        fieldIds.length === 0
          ? []
          : (
              await db
                .selectFrom('field')
                .select('id')
                .where('workspace_id', '=', ws)
                .where('id', 'in', fieldIds)
                .where('track_id', 'is', null)
                .where('type', '=', 'team')
                .where('multiple', '=', false)
                .execute()
            ).map((f) => f.id),
      );
      const teamIds = [
        ...new Set(
          changes.flatMap((c) =>
            Object.values(c.fields ?? {}).flatMap((v) => (v === null ? [] : [v])),
          ),
        ),
      ];
      const teamsThere = new Set(
        teamIds.length === 0
          ? []
          : (
              await db
                .selectFrom('team')
                .select('id')
                .where('workspace_id', '=', ws)
                .where('id', 'in', teamIds)
                .execute()
            ).map((t) => t.id),
      );
      changes.forEach((c, i) => {
        for (const [key, value] of Object.entries(c.fields ?? {})) {
          if (!teamFieldIds.has(Number(key))) {
            fields[`changes.${i}.fields.${key}`] = 'not_a_team_field';
          } else if (value !== null && !teamsThere.has(value)) {
            fields[`changes.${i}.fields.${key}`] = 'not_found';
          }
        }
      });
      if (Object.keys(fields).length > 0) return invalidFields(reply, fields);
      const outcome = await db.transaction().execute(async (trx) => {
        // The scenario's lock orders drafts written to it and the limit on them.
        const locked = await trx
          .selectFrom('plan_scenario')
          .select('id')
          .where('id', '=', o.scenario.id)
          .where('plan_id', '=', o.plan.id)
          .forUpdate()
          .executeTakeFirst();
        if (!locked) return { missing: true as const };
        // Days are checked against what the ticket would have: this request's drafts, else the
        // scenario's, else the live value.
        const drafted = new Map(
          (
            await trx
              .selectFrom('plan_draft')
              .select(['ticket_id', 'field', 'new_value'])
              .where('scenario_id', '=', o.scenario.id)
              .where('ticket_id', 'in', ids)
              .where('field', 'in', ['startDate', 'dueDate'])
              .execute()
          ).map((r) => [`${r.ticket_id}/${r.field}`, draftValue(r.new_value)]),
        );
        const order: Record<string, string> = {};
        const writes: DraftWrite[] = [];
        changes.forEach((c, i) => {
          const ticket = live.get(c.ticketId);
          if (!ticket) return;
          const dayOf = (field: 'startDate' | 'dueDate', asked: string | null | undefined) => {
            if (asked !== undefined) return asked;
            const key = `${c.ticketId}/${field}`;
            return drafted.has(key) ? (drafted.get(key) as DraftValue) : liveValue(ticket, field);
          };
          const start = dayOf('startDate', c.startDate);
          const due = dayOf('dueDate', c.dueDate);
          if (start !== null && due !== null && String(start) > String(due)) {
            order[`changes.${i}.startDate`] = 'start_after_due';
            return;
          }
          const add = (field: PlanDraftField, value: DraftValue) =>
            writes.push({ ticketId: c.ticketId, field, value, live: liveValue(ticket, field) });
          if (c.startDate !== undefined) add('startDate', c.startDate);
          if (c.dueDate !== undefined) add('dueDate', c.dueDate);
          for (const [key, value] of Object.entries(c.fields ?? {}))
            add(teamKey(Number(key)), value);
        });
        if (Object.keys(order).length > 0) return { fields: order };
        const written = await writeDrafts(trx, {
          workspaceId: ws,
          planId: o.plan.id,
          scenarioId: o.scenario.id,
          updatedBy: o.user.id,
          origin: 'person',
          changes: writes,
        });
        if ((await draftedTickets(trx, o.scenario.id)) > MAX_DRAFTED_TICKETS) {
          throw new TooManyDrafts();
        }
        if (written.set.length + written.removed.length > 0) {
          await emit(trx, by(request), {
            type: 'plan.drafts_set',
            subjectId: o.plan.id,
            payload: {
              scenarioId: o.scenario.id,
              changes: written.set,
              removed: written.removed,
              origin: 'person',
            },
          });
        }
        return { written };
      });
      if ('missing' in outcome) return notFound(reply);
      if ('fields' in outcome)
        return invalidFields(reply, outcome.fields as Record<string, string>);
      const list = await changeList(request, o.scenario.id, shown, { ids });
      return list;
    } catch (error) {
      if (error instanceof TooManyDrafts) {
        return reply.code(409).send({ error: 'too_many_drafts', limit: MAX_DRAFTED_TICKETS });
      }
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.post('/api/v1/plans/:id/scenarios/:sid/discard', async (request, reply) => {
    const o = await opened(request, reply, true, true);
    if (!o) return reply;
    const parsed = discardBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    try {
      const tickets = await shownTo(request, o.plan.id);
      const shown = tickets.unfiltered;
      const visible = shown
        ? sql<boolean>`(k.deleted_at IS NULL AND ${shown})`
        : sql<boolean>`false`;
      const outcome = await db.transaction().execute(async (trx) => {
        // Only drafts on tickets the person is shown go; the rest stay, counted.
        const gone = await sql<{ ticket_id: number }>`
          DELETE FROM plan_draft d USING ticket k
           WHERE k.id = d.ticket_id AND d.scenario_id = ${o.scenario.id}::int AND ${visible}
             ${body.tickets ? sql`AND d.ticket_id = ANY(${body.tickets}::int[])` : sql``}
          RETURNING d.ticket_id`.execute(trx);
        const ids = [...new Set(gone.rows.map((r) => r.ticket_id))].sort((a, b) => a - b);
        const notShown =
          (
            await sql<{ n: number }>`
              SELECT count(DISTINCT d.ticket_id)::int AS n
                FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id
               WHERE d.scenario_id = ${o.scenario.id}::int AND (${visible}) IS NOT TRUE`.execute(
              trx,
            )
          ).rows[0]?.n ?? 0;
        if (ids.length > 0) {
          await emit(trx, by(request), {
            type: 'plan.drafts_discarded',
            subjectId: o.plan.id,
            payload: { scenarioId: o.scenario.id, ticketIds: ids, count: ids.length },
          });
        }
        return { discarded: ids.length, notShown };
      });
      return outcome;
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.post('/api/v1/plans/:id/scenarios/:sid/apply', async (request, reply) => {
    const o = await opened(request, reply, true, true);
    if (!o) return reply;
    const parsed = applyBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    if (!o.scenario.main) return reply.code(409).send({ error: 'not_main' });
    // 1. Hold the scenario: one apply at a time per plan; a hold older than ten minutes is stale.
    const held = await sql<{ id: number }>`
      UPDATE plan_scenario SET applying_since = now()
       WHERE id = ${o.scenario.id}::int AND plan_id = ${o.plan.id}::int AND main
         AND (applying_since IS NULL OR applying_since < now() - interval '10 minutes')
      RETURNING id`.execute(db);
    if (held.rows.length === 0) {
      const now = await scenarioOf(db, request.workspaceId, o.plan.id, o.scenario.id);
      if (!now) return notFound(reply);
      return reply.code(409).send({ error: now.main ? 'apply_in_progress' : 'not_main' });
    }
    const release = () =>
      db
        .updateTable('plan_scenario')
        .set({ applying_since: null })
        .where('id', '=', o.scenario.id)
        .execute();
    try {
      const result = await applyDrafts(request, o.plan.id, o.scenario.id, body);
      return result;
    } catch (error) {
      await release();
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  /** Steps 2 to 6 of an apply (ADR-122 stage 6), the scenario held by the caller. */
  async function applyDrafts(
    request: FastifyRequest,
    planId: number,
    scenarioId: number,
    body: z.infer<typeof applyBody>,
  ) {
    const tickets = await shownTo(request, planId);
    const shown = tickets.unfiltered;
    const visible = shown ? sql<boolean>`(k.deleted_at IS NULL AND ${shown})` : sql<boolean>`false`;
    // 2. The chosen tickets' drafts and live tickets as the applier, in one statement.
    const read = await readOnly(db, timeoutMs, async (trx) => {
      let chosen: number[];
      let next: number | null = null;
      if (body.tickets) {
        chosen = [...new Set(body.tickets)].sort((a, b) => a - b);
      } else {
        const page = (
          await sql<{ ticket_id: number }>`
            SELECT DISTINCT d.ticket_id FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id
             WHERE d.scenario_id = ${scenarioId}::int AND d.ticket_id > ${body.after ?? 0}::int
               AND ${visible}
             ORDER BY d.ticket_id LIMIT ${LIMITS.perApply + 1}`.execute(trx)
        ).rows.map((r) => r.ticket_id);
        chosen = page.slice(0, LIMITS.perApply);
        next = page.length > LIMITS.perApply ? (chosen.at(-1) ?? null) : null;
      }
      const rows =
        chosen.length === 0
          ? []
          : (
              await sql<{
                ticket_id: number;
                field: string;
                old_value: JsonValue | null;
                new_value: JsonValue | null;
                key: string;
                version: number;
                start_date: string | null;
                due_date: string | null;
                fields: Record<string, unknown>;
              }>`
                SELECT d.ticket_id, d.field, d.old_value, d.new_value,
                       t.key || '-' || k.number AS key, k.version,
                       k.start_date::text AS start_date, k.due_date::text AS due_date, k.fields
                  FROM plan_draft d
                  JOIN ticket k ON k.id = d.ticket_id
                  JOIN track t ON t.id = k.track_id
                 WHERE d.scenario_id = ${scenarioId}::int AND d.ticket_id = ANY(${chosen}::int[])
                   AND ${visible}
                 ORDER BY d.ticket_id, d.field`.execute(trx)
            ).rows;
      return { chosen, next, rows };
    });
    const byTicket = new Map<number, (typeof read.rows)[number][]>();
    for (const r of read.rows) {
      const list = byTicket.get(r.ticket_id) ?? [];
      list.push(r);
      byTicket.set(r.ticket_id, list);
    }
    const applied: { ticketId: number; key: string }[] = [];
    const refused: ({ ticketId: number; key: string | null } & Refusal)[] = [];
    /** The values applied (or already so), by ticket, to remove the drafts still holding them. */
    const landed = new Map<number, { field: string; value: DraftValue }[]>();
    const sends: { ticketId: number; key: string; body: Record<string, unknown> }[] = [];
    // 3. Compare each drafted field with its live value.
    for (const ticketId of read.chosen) {
      const drafts = byTicket.get(ticketId);
      if (!drafts || drafts.length === 0) {
        // Deleted, hidden, out of the plan or never drafted: the same answer, without a key.
        refused.push({ ticketId, key: null, reason: 'gone' });
        continue;
      }
      const first = drafts[0] as (typeof drafts)[number];
      const now: Record<string, DraftValue> = {};
      const send: {
        startDate?: DraftValue;
        dueDate?: DraftValue;
        fields?: Record<string, DraftValue>;
      } = {};
      let changed = false;
      for (const d of drafts) {
        const value = draftValue(d.new_value);
        const was = draftValue(d.old_value);
        const current = liveValue(first, d.field);
        now[d.field] = current;
        if (sameValue(current, value)) continue;
        if (!sameValue(current, was)) {
          changed = true;
          continue;
        }
        const teamField = teamFieldOf(d.field);
        if (teamField === null) send[d.field as 'startDate' | 'dueDate'] = value;
        else send.fields = { ...(send.fields ?? {}), [String(teamField)]: value };
      }
      if (changed) {
        refused.push({ ticketId, key: first.key, reason: 'changed_meanwhile', now });
        continue;
      }
      landed.set(
        ticketId,
        drafts.map((d) => ({ field: d.field, value: draftValue(d.new_value) })),
      );
      if (Object.keys(send).length === 0) {
        applied.push({ ticketId, key: first.key });
        continue;
      }
      sends.push({ ticketId, key: first.key, body: { ...send, version: first.version } });
    }
    // 4. The ticket's own change, as the applier, a few at a time in ticket id order.
    let at = 0;
    const lanes = Array.from({ length: Math.min(APPLY_CONCURRENCY, sends.length) }, async () => {
      while (at < sends.length) {
        const item = sends[at++] as (typeof sends)[number];
        let answer: { statusCode: number; payload: unknown };
        try {
          answer = await callRoute(updateTicket, {
            workspaceId: request.workspaceId,
            user: request.user,
            authz: request.authz,
            apiToken: request.apiToken,
            params: { id: String(item.ticketId) },
            query: {},
            body: item.body,
          });
        } catch (error) {
          request.log.warn({ err: error, ticketId: item.ticketId }, 'plan apply: ticket failed');
          answer = { statusCode: 500, payload: null };
        }
        if (answer.statusCode >= 200 && answer.statusCode < 300) {
          applied.push({ ticketId: item.ticketId, key: item.key });
        } else {
          landed.delete(item.ticketId);
          const why = refusalOf(answer.statusCode, answer.payload);
          refused.push({
            ticketId: item.ticketId,
            key: why.reason === 'gone' ? null : item.key,
            ...why,
          });
        }
      }
    });
    await Promise.all(lanes);
    applied.sort((a, b) => a.ticketId - b.ticketId);
    refused.sort((a, b) => a.ticketId - b.ticketId);
    // A ticket changed by someone else during the apply: its values now, as the applier sees them.
    const raced = refused.filter((r) => r.reason === 'changed_meanwhile' && r.now === undefined);
    if (raced.length > 0) {
      const ids = raced.map((r) => r.ticketId);
      const fresh = await readOnly(db, timeoutMs, (trx) =>
        sql<{
          ticket_id: number;
          field: string;
          start_date: string | null;
          due_date: string | null;
          fields: Record<string, unknown>;
        }>`
          SELECT d.ticket_id, d.field, k.start_date::text AS start_date,
                 k.due_date::text AS due_date, k.fields
            FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id
           WHERE d.scenario_id = ${scenarioId}::int AND d.ticket_id = ANY(${ids}::int[])
             AND ${visible}`.execute(trx),
      );
      for (const r of raced) {
        r.now = Object.fromEntries(
          fresh.rows
            .filter((f) => f.ticket_id === r.ticketId)
            .map((f) => [f.field, liveValue(f, f.field)]),
        );
      }
    }
    // 5. Finish in one transaction: drafts still holding the value applied go; refusals are kept.
    const notShown = await db.transaction().execute(async (trx) => {
      const gone = [...landed].flatMap(([ticketId, list]) =>
        list.map((l) => ({ ticketId, field: l.field, value: l.value })),
      );
      if (gone.length > 0) {
        await sql`
          DELETE FROM plan_draft d
           USING unnest(${gone.map((g) => g.ticketId)}::int[], ${gone.map((g) => g.field)}::text[],
                        ${gone.map((g) => (g.value === null ? 'null' : JSON.stringify(g.value)))}::jsonb[])
                 AS x(ticket_id, field, value)
           WHERE d.scenario_id = ${scenarioId}::int AND d.ticket_id = x.ticket_id
             AND d.field = x.field AND COALESCE(d.new_value, 'null'::jsonb) = x.value`.execute(trx);
      }
      const kept = refused.filter((r) => r.reason !== 'gone');
      if (kept.length > 0) {
        const now = new Date();
        await sql`
          UPDATE plan_draft d SET refusal = x.refusal, refused_at = ${now}
            FROM unnest(${kept.map((r) => r.ticketId)}::int[],
                        ${kept.map((r) => JSON.stringify(refusalStored(r)))}::jsonb[])
                 AS x(ticket_id, refusal)
           WHERE d.scenario_id = ${scenarioId}::int AND d.ticket_id = x.ticket_id`.execute(trx);
      }
      await trx
        .updateTable('plan_scenario')
        .set({ applying_since: null })
        .where('id', '=', scenarioId)
        .execute();
      const hidden =
        (
          await sql<{ n: number }>`
            SELECT count(DISTINCT d.ticket_id)::int AS n
              FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id
             WHERE d.scenario_id = ${scenarioId}::int AND (${visible}) IS NOT TRUE`.execute(trx)
        ).rows[0]?.n ?? 0;
      await emit(trx, by(request), {
        type: 'plan.drafts_committed',
        subjectId: planId,
        payload: {
          scenarioId,
          applied,
          refused: refused.map((r) => ({ ticketId: r.ticketId, reason: r.reason })),
          notShown: hidden,
        },
      });
      return hidden;
    });
    // 6. The answer.
    return { applied, refused, next: read.next, notShown };
  }

  app.get('/api/v1/plans/:id/compare', async (request, reply) => {
    const o = await opened(request, reply, false, false);
    if (!o) return reply;
    const q = compareQuery.safeParse(request.query ?? {});
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const { a, b, teamField: askedField, ...filters } = q.data;
    const ws = request.workspaceId;
    try {
      const tickets = await shownTo(request, o.plan.id, filters);
      const sideOf = async (s: string) =>
        s === 'live'
          ? { live: true as const }
          : await viewScenario(db, ws, o.plan.id, s, tickets.unfiltered);
      const sideA = await sideOf(a);
      const sideB = await sideOf(b);
      const bad: Record<string, string> = {};
      if (sideA === 'not_found') bad.a = 'not_found';
      if (sideB === 'not_found') bad.b = 'not_found';
      // The Team field: the one asked for, or the site's oldest shared one, as a new board takes it.
      const fields = await db
        .selectFrom('field')
        .select(['id', 'name'])
        .where('workspace_id', '=', ws)
        .where('track_id', 'is', null)
        .where('type', '=', 'team')
        .where('multiple', '=', false)
        .orderBy('id')
        .execute();
      const field =
        askedField === undefined
          ? (fields[0] ?? null)
          : (fields.find((f) => f.id === askedField) ?? null);
      if (askedField !== undefined && !field) bad.teamField = 'not_found';
      if (Object.keys(bad).length > 0) return invalidFields(reply, bad);
      const scenarioA = sideA !== null && sideA !== 'not_found' && 'id' in sideA ? sideA : null;
      const scenarioB = sideB !== null && sideB !== 'not_found' && 'id' in sideB ? sideB : null;
      const teams = await planTeams(db, o.plan.id);
      const teamIds = teams.map((t) => t.id);
      const fieldId = field?.id ?? null;
      const where = tickets.where;
      const shown = tickets.unfiltered;
      const overA = draftOverlay(scenarioA?.id ?? null, shown, 'da');
      const overB = draftOverlay(scenarioB?.id ?? null, shown, 'db');
      const read = !where
        ? null
        : await readOnly(db, timeoutMs, async (trx) => {
            // One statement over the viewer's tickets with both overlays.
            const row = (
              await sql<{
                ends:
                  | {
                      side: 'a' | 'b';
                      whole: number;
                      team: number | null;
                      due: string | null;
                      ticket: number | null;
                      undated: number;
                    }[]
                  | null;
                differing:
                  | {
                      id: number;
                      key: string;
                      summary: string;
                      a_start: string | null;
                      a_due: string | null;
                      a_team: number | null;
                      b_start: string | null;
                      b_due: string | null;
                      b_team: number | null;
                    }[]
                  | null;
                differ: number;
                later: number;
                earlier: number;
              }>`
                WITH x AS (
                  SELECT k.id, t.key || '-' || k.number AS key, k.summary,
                         s.stage <> 'closed' AS open,
                         ${overA.start} AS a_start, ${overA.due} AS a_due,
                         ${overA.team(fieldId)} AS a_team,
                         ${overB.start} AS b_start, ${overB.due} AS b_due,
                         ${overB.team(fieldId)} AS b_team
                    FROM ticket k
                    JOIN track t ON t.id = k.track_id
                    JOIN status s ON s.id = k.status_id
                    ${overA.join}
                    ${overB.join}
                   WHERE ${where}
                ), u AS (
                  SELECT 'a' AS side, a_team AS team, a_due AS due, id FROM x WHERE open
                  UNION ALL
                  SELECT 'b', b_team, b_due, id FROM x WHERE open
                ), e AS (
                  SELECT side, GROUPING(team_k)::int AS whole, team_k AS team,
                         max(due)::text AS due,
                         (array_agg(id ORDER BY due DESC, id) FILTER (WHERE due IS NOT NULL))[1]
                           AS ticket,
                         count(*) FILTER (WHERE due IS NULL)::int AS undated
                    FROM (SELECT side, id, due,
                                 CASE WHEN team = ANY(${teamIds}::bigint[]) THEN team::int END
                                   AS team_k
                            FROM u) v
                   GROUP BY GROUPING SETS ((side), (side, team_k))
                ), dx AS (
                  SELECT id, key, summary, a_start::text, a_due::text, a_team::int,
                         b_start::text, b_due::text, b_team::int
                    FROM x
                   WHERE (a_start, a_due, a_team) IS DISTINCT FROM (b_start, b_due, b_team)
                )
                SELECT (SELECT json_agg(e) FROM e) AS ends,
                       (SELECT json_agg(d ORDER BY d.id)
                          FROM (SELECT * FROM dx ORDER BY id LIMIT ${DIFFERING}) d) AS differing,
                       (SELECT count(*)::int FROM dx) AS differ,
                       (SELECT count(*)::int FROM x WHERE b_due > a_due) AS later,
                       (SELECT count(*)::int FROM x WHERE b_due < a_due) AS earlier`.execute(trx)
            ).rows[0];
            const endIds = (row?.ends ?? []).flatMap((e) => (e.ticket === null ? [] : [e.ticket]));
            const keys = new Map(
              (endIds.length === 0
                ? []
                : (
                    await sql<{ id: number; key: string; summary: string }>`
                      SELECT k.id, t.key || '-' || k.number AS key, k.summary
                        FROM ticket k JOIN track t ON t.id = k.track_id
                       WHERE k.id = ANY(${endIds}::int[])`.execute(trx)
                  ).rows
              ).map((r) => [r.id, r]),
            );
            return { row, keys };
          });
      const sideView = (key: 'a' | 'b', s: typeof scenarioA) => {
        const ends = (read?.row?.ends ?? []).filter((e) => e.side === key);
        const endOf = (e: (typeof ends)[number] | undefined) => ({
          due: e?.due ?? null,
          ticket:
            e?.ticket == null
              ? null
              : {
                  id: e.ticket,
                  key: read?.keys.get(e.ticket)?.key ?? '',
                  summary: read?.keys.get(e.ticket)?.summary ?? '',
                },
          undated: e?.undated ?? 0,
        });
        return {
          side: s === null ? ('live' as const) : String(s.id),
          scenario: s,
          end: endOf(ends.find((e) => e.whole === 1)),
          teams: [
            ...teams.map((t) => ({
              team: t,
              ...endOf(ends.find((e) => e.whole === 0 && e.team === t.id)),
            })),
            { team: null, ...endOf(ends.find((e) => e.whole === 0 && e.team === null)) },
          ],
        };
      };
      return {
        plan: { id: o.plan.id, name: o.plan.name },
        query: tickets.query,
        teamField: field,
        teamFields: fields,
        a: sideView('a', scenarioA),
        b: sideView('b', scenarioB),
        later: read?.row?.later ?? 0,
        earlier: read?.row?.earlier ?? 0,
        differing: {
          count: read?.row?.differ ?? 0,
          tickets: (read?.row?.differing ?? []).map((d) => ({
            id: d.id,
            key: d.key,
            summary: d.summary,
            a: { start: d.a_start, due: d.a_due, team: d.a_team },
            b: { start: d.b_start, due: d.b_due, team: d.b_team },
          })),
        },
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });
}

class TooManyDrafts extends Error {}

/** A refusal as stored on its drafts: the reason and what the page says with it. */
function refusalStored(r: Refusal): Refusal {
  return {
    reason: r.reason,
    ...(r.permission ? { permission: r.permission } : {}),
    ...(r.locks ? { locks: r.locks } : {}),
    ...(r.fields ? { fields: r.fields } : {}),
    ...(r.now ? { now: r.now } : {}),
  };
}
