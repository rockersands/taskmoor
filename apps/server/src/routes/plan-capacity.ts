import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import type { z } from 'zod';
import { requireUser } from '../auth';
import { emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import {
  type Capacity,
  capacityOf,
  capacityRows,
  type Elsewhere,
  elsewhereWork,
  estimateSql,
  membersOf,
  periodIndex,
  pointsField,
  round,
  teamCapacity,
} from '../plans/capacity';
import { draftOverlay } from '../plans/drafts';
import { type CapacityEntry, capacityBody, capacityQuery, idParam } from '../plans/model';
import {
  dayNumber,
  isoDay,
  isPeriodStart,
  type Period,
  type PeriodSetting,
  periodsBefore,
  periodsFrom,
  samePeriods,
} from '../plans/periods';
import { planTickets, sourceRows } from '../plans/query';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { viewScenario } from './plan-scenarios';
import { periodOf, planTeams, planVisible } from './plans';
import { searchRefusal } from './search';

/**
 * Teams and capacity in a Multi-track plan (T-089b; PLN-005, PLN-009; ADR-122 stage 3).
 *
 * - `GET /api/v1/plans/:id/capacity?from=&periods=` with the views' filters: for each of the
 *   plan's teams and each of their members, the work due in each period against the capacity set
 *   for it, and the open work without a due date. Work is the plan's tickets as the viewer sees
 *   them, with the filters, counted and summed in the plan's unit (points from the workspace's
 *   Points field, or hours from the original estimate): a ticket counts whole in the period that
 *   holds its due day, for the person it is assigned to and every plan team that person is in.
 *   Every number is the count of a search: the plan's `query`, the row's `clause` and the
 *   period's `clause`, ANDed. A person's other work due in the period (outside the plan, left
 *   out by the filters, or hidden from the viewer) counts against their capacity as one number,
 *   `elsewhere`, never named or linked, and counted by whole weeks: each week, Monday to Sunday,
 *   in the period that holds its Thursday (most of its days). Since anyone may own a plan and
 *   move its periods a day at a time, counting it by day would give away the day each hidden
 *   ticket is due. Unassigned work, and work of people in none of the plan's teams, have rows
 *   of their own, without capacity.
 * - `PUT /api/v1/plans/:id/capacity` sets, changes or removes capacities (a team's or a
 *   member's, for every period or one), for those who may change the plan; one
 *   `plan.capacity_set` event lists every change.
 *
 * With `scenario=<id>` (ADR-122 stage 6) the plan's work counts in the period of its drafted due
 * day; work elsewhere stays live. A cell a draft moves a ticket into or out of says how many
 * (`drafts`) and has no search (`clause: null`), since a search finds live values; every other
 * count still equals its search.
 *
 * A team's capacity in a period is its own (that period's, else every period's); without one,
 * the sum of its members' when any has one. Over capacity: what the row's people have due in the
 * period, here and elsewhere, is more than that.
 */
const DEFAULT_PERIODS = 6;
const UNSCHEDULED = 'stage != closed AND due IS EMPTY';

interface Work {
  count: number;
  amount: number;
  unestimated: number;
}
export interface PlanCapacityOptions {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

const none = (): Work => ({ count: 0, amount: 0, unestimated: 0 });
const add = (a: Work, b: Work): Work => ({
  count: a.count + b.count,
  amount: a.amount + b.amount,
  unestimated: a.unestimated + b.unestimated,
});
const rounded = (w: Work): Work => ({ ...w, amount: round(w.amount) });

/** A value as the query language reads it: a quoted string with its quotes escaped. */
const quoted = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const periodClause = (p: Period) => `due >= ${quoted(p.start)} AND due <= ${quoted(p.end)}`;
const teamClause = (teamId: number) => `assignee IN membersOf(${quoted(`id:${teamId}`)})`;

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

const subjectKey = (e: { teamId?: number | undefined; userId?: number | undefined }) =>
  e.teamId ? `team:${e.teamId}` : `user:${e.userId}`;

export function registerPlanCapacityRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: PlanCapacityOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

  /** The plan with its settings when the person sees it (site administrators see every one). */
  async function visiblePlan(request: FastifyRequest, id: number) {
    const ws = request.workspaceId;
    let q = db
      .selectFrom('plan as p')
      .select([
        'p.id',
        'p.name',
        'p.owner_id',
        'p.capacity_unit',
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

  app.get('/api/v1/plans/:id/capacity', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const q = capacityQuery.safeParse(request.query ?? {});
    if (!q.success)
      return reply.code(400).send({ error: 'invalid_fields', fields: shapeErrors(q.error) });
    const { from, periods: count, scenario: scenarioParam, ...filters } = q.data;
    const ws = request.workspaceId;
    const plan = await visiblePlan(request, p.data.id);
    if (!plan) return reply.code(404).send({ error: 'not_found' });
    try {
      const tickets = await planTickets(
        db,
        options.catalogs,
        request,
        await sourceRows(db, [plan.id]),
        filters,
      );
      const scenario = await viewScenario(db, ws, plan.id, scenarioParam, tickets.unfiltered);
      if (scenario === 'not_found') {
        return reply.code(400).send({ error: 'invalid_fields', fields: { scenario: 'not_found' } });
      }
      const over = draftOverlay(scenario?.id ?? null, tickets.unfiltered);
      const setting: PeriodSetting = periodOf(plan);
      const first = from ?? new Date().toISOString().slice(0, 10);
      const periods = periodsFrom(setting, first, count ?? DEFAULT_PERIODS);
      const windowStart = periods[0]?.start as string;
      const windowEnd = periods.at(-1)?.end as string;
      const periodAt = (due: string) => periodIndex(periods, due);

      const teams = await planTeams(db, plan.id);
      const members = await membersOf(
        db,
        ws,
        teams.map((t) => t.id),
      );
      const people = [...new Set([...members.values()].flat().map((m) => m.id))];
      const field = plan.capacity_unit === 'points' ? await pointsField(db, ws) : null;
      const value = estimateSql(plan.capacity_unit, field?.id ?? null);
      const where = tickets.where;

      const counted = await readOnly(db, timeoutMs, async (trx) => {
        // The plan's tickets as the viewer sees them, due in the window or open without a due day.
        const planned = where
          ? (
              await sql<{
                assignee_id: number | null;
                due: string | null;
                n: number;
                amount: number;
                unestimated: number;
              }>`
                SELECT k.assignee_id, ${over.due}::text AS due, count(*)::int AS n,
                       COALESCE(sum(${value}), 0)::float8 AS amount,
                       count(*) FILTER (WHERE ${value} IS NULL)::int AS unestimated
                  FROM ticket k JOIN status s ON s.id = k.status_id
                  ${over.join}
                 WHERE ${where}
                   AND (${over.due} BETWEEN ${windowStart}::date AND ${windowEnd}::date
                        OR (${over.due} IS NULL AND s.stage <> 'closed'))
                 GROUP BY k.assignee_id, ${over.due}`.execute(trx)
            ).rows
          : [];
        // Tickets a draft moves from one period to another: their cells count what no search finds.
        const moved =
          where && scenario
            ? (
                await sql<{
                  assignee_id: number | null;
                  live: string | null;
                  drafted: string | null;
                  open: boolean;
                }>`
                  SELECT k.assignee_id, k.due_date::text AS live, ${over.due}::text AS drafted,
                         s.stage <> 'closed' AS open
                    FROM ticket k JOIN status s ON s.id = k.status_id
                    ${over.join}
                   WHERE ${where} AND ${over.drafted}
                     AND ${over.due} IS DISTINCT FROM k.due_date`.execute(trx)
              ).rows
            : [];
        // The rest of the members' work due in the weeks in view: outside the plan, filtered out
        // or hidden from the viewer. Counted, never named, by whole weeks.
        const elsewhere = await elsewhereWork(trx, { ws, people, where, value, periods });
        return { planned, elsewhere, moved };
      });

      const capacitySet = await capacityRows(db, plan.id);

      // Per person (null: unassigned): work per period, and open work without a due day.
      const byPerson = new Map<number | null, { cells: Work[]; unscheduled: Work }>();
      const rowOf = (id: number | null) => {
        let row = byPerson.get(id);
        if (!row) {
          row = { cells: periods.map(none), unscheduled: none() };
          byPerson.set(id, row);
        }
        return row;
      };
      for (const r of counted.planned) {
        const work = { count: r.n, amount: Number(r.amount), unestimated: r.unestimated };
        const row = rowOf(r.assignee_id);
        if (r.due === null) {
          row.unscheduled = add(row.unscheduled, work);
          continue;
        }
        const at = periodAt(r.due);
        if (at >= 0) row.cells[at] = add(row.cells[at] as Work, work);
      }
      const away = counted.elsewhere;

      // Per person (null: unassigned), how many drafted tickets move into or out of each cell
      // (index -1: open work without a due day).
      const touched = new Map<number | null, Map<number, number>>();
      const cellAt = (due: string | null, open: boolean): number | null => {
        if (due === null) return open ? -1 : null;
        const at = periodAt(due);
        return at >= 0 ? at : null;
      };
      for (const m of counted.moved) {
        const from = cellAt(m.live, m.open);
        const to = cellAt(m.drafted, m.open);
        if (from === to) continue;
        const cells = touched.get(m.assignee_id) ?? new Map<number, number>();
        for (const at of [from, to]) if (at !== null) cells.set(at, (cells.get(at) ?? 0) + 1);
        touched.set(m.assignee_id, cells);
      }
      /** The drafts that touch a cell of these people, or nothing when none does. */
      const draftsIn = (people: readonly (number | null)[], at: number) => {
        const n = people.reduce<number>((sum, p) => sum + (touched.get(p)?.get(at) ?? 0), 0);
        return n === 0 ? {} : { drafts: n, clause: null };
      };

      const cellsOf = (
        work: Work[],
        elsewhere: Elsewhere[],
        capacity: { amount: number | null }[],
        people: readonly (number | null)[],
      ) =>
        work.map((w, i) => {
          const other = elsewhere[i] ?? { count: 0, amount: 0 };
          const load = round(w.amount + other.amount);
          const limit = capacity[i]?.amount ?? null;
          return {
            ...rounded(w),
            elsewhere: { count: other.count, amount: round(other.amount) },
            load,
            over: limit !== null && load > limit,
            ...draftsIn(people, i),
          };
        });

      const personRow = (m: { id: number; name: string; active: boolean }) => {
        const work = byPerson.get(m.id) ?? { cells: periods.map(none), unscheduled: none() };
        const capacity = capacityOf(capacitySet, periods, { userId: m.id });
        return {
          id: m.id,
          name: m.name,
          active: m.active,
          clause: `assignee = ${m.id}`,
          capacity,
          cells: cellsOf(work.cells, away.get(m.id) ?? [], capacity.periods, [m.id]),
          unscheduled: { ...rounded(work.unscheduled), ...draftsIn([m.id], -1) },
          work,
        };
      };
      const teamRows = teams.map((team) => {
        const people = (members.get(team.id) ?? []).map(personRow);
        // Without its own capacity in a period, a team has its members' when any has one.
        const capacity = teamCapacity(
          capacityOf(capacitySet, periods, { teamId: team.id }),
          people.map((m) => m.capacity),
        );
        const work = periods.map((_, i) =>
          people.reduce((sum, m) => add(sum, m.work.cells[i] as Work), none()),
        );
        const elsewhere = periods.map((_, i) =>
          people.reduce(
            (sum, m) => {
              const e = away.get(m.id)?.[i];
              return e ? { count: sum.count + e.count, amount: sum.amount + e.amount } : sum;
            },
            { count: 0, amount: 0 },
          ),
        );
        return {
          id: team.id,
          name: team.name,
          clause: teamClause(team.id),
          capacity,
          cells: cellsOf(
            work,
            elsewhere,
            capacity.periods,
            people.map((m) => m.id),
          ),
          unscheduled: {
            ...rounded(people.reduce((sum, m) => add(sum, m.work.unscheduled), none())),
            ...draftsIn(
              people.map((m) => m.id),
              -1,
            ),
          },
          members: people.map(({ work: _work, ...m }) => m),
        };
      });

      // Unassigned work, and work of people in none of the plan's teams: no capacity of their own.
      const inTeams = new Set(people);
      const unassigned = byPerson.get(null) ?? { cells: periods.map(none), unscheduled: none() };
      const others = { cells: periods.map(none), unscheduled: none() };
      const outsiders = [...new Set([...byPerson.keys(), ...touched.keys()])].filter(
        (id): id is number => id !== null && !inTeams.has(id),
      );
      for (const [id, row] of byPerson) {
        if (id === null || inTeams.has(id)) continue;
        others.cells = others.cells.map((c, i) => add(c, row.cells[i] as Work));
        others.unscheduled = add(others.unscheduled, row.unscheduled);
      }
      return {
        plan: { id: plan.id, name: plan.name },
        ...(scenario ? { scenario } : {}),
        query: tickets.query,
        editable: plan.editable,
        unit: plan.capacity_unit,
        pointsField: field,
        period: setting,
        periods: periods.map((x) => ({ ...x, clause: periodClause(x) })),
        previous: periodsBefore(setting, windowStart, periods.length),
        next: isoDay(dayNumber(windowEnd) + 1),
        unscheduledClause: UNSCHEDULED,
        teams: teamRows,
        unassigned: {
          clause: 'assignee IS EMPTY',
          cells: unassigned.cells.map((c, i) => ({ ...rounded(c), ...draftsIn([null], i) })),
          unscheduled: { ...rounded(unassigned.unscheduled), ...draftsIn([null], -1) },
        },
        others: {
          clause:
            teams.length === 0
              ? 'assignee IS NOT EMPTY'
              : teams
                  .map((t) => `assignee NOT IN membersOf(${quoted(`id:${t.id}`)})`)
                  .join(' AND '),
          cells: others.cells.map((c, i) => ({ ...rounded(c), ...draftsIn(outsiders, i) })),
          unscheduled: { ...rounded(others.unscheduled), ...draftsIn(outsiders, -1) },
        },
      };
    } catch (error) {
      return searchRefusal(reply as FastifyReply, error, timeoutMs);
    }
  });

  app.put('/api/v1/plans/:id/capacity', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const parsed = capacityBody.safeParse(request.body ?? {});
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_fields', fields: shapeErrors(parsed.error) });
    const ws = request.workspaceId;
    const plan = await visiblePlan(request, p.data.id);
    if (!plan) return reply.code(404).send({ error: 'not_found' });
    if (!plan.editable)
      return reply.code(403).send({ error: 'forbidden', permission: 'edit_plan' });
    const { entries, unit, period } = parsed.data;

    const outcome = await db.transaction().execute(async (trx) => {
      // One writer at a time per plan, so two people's changes never interleave; and the plan's
      // settings, teams and members are read under that lock, so a change of them that commits
      // meanwhile (which clears capacity) is seen here, not undone by rows checked before it.
      const locked = await trx
        .selectFrom('plan')
        .select(['capacity_unit', 'period_kind', 'period_weeks', 'period_anchor'])
        .where('id', '=', plan.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return { missing: true as const };
      const setting = periodOf(locked);
      // Amounts typed for another unit or other periods mean something else now.
      if (
        (unit !== undefined && unit !== locked.capacity_unit) ||
        (period !== undefined && !samePeriods(period, setting))
      ) {
        return { settingsChanged: { unit: locked.capacity_unit, period: setting } };
      }

      // Only the plan's teams and their members; only first days of the plan's periods.
      const teamIds = new Set((await planTeams(trx, plan.id)).map((t) => t.id));
      const memberIds = new Set(
        [...(await membersOf(trx, ws, [...teamIds])).values()].flat().map((m) => m.id),
      );
      const fields: Record<string, string> = {};
      const seen = new Set<string>();
      for (const [i, e] of entries.entries()) {
        if (e.teamId !== undefined && !teamIds.has(e.teamId)) {
          fields[`entries.${i}.teamId`] = 'not_in_plan';
        }
        if (e.userId !== undefined && !memberIds.has(e.userId)) {
          fields[`entries.${i}.userId`] = 'not_in_plan';
        }
        if (e.period !== null && !isPeriodStart(setting, e.period)) {
          fields[`entries.${i}.period`] = 'not_a_period_start';
        }
        const key = `${subjectKey(e)}@${e.period ?? '*'}`;
        if (seen.has(key)) fields.entries = 'duplicate';
        seen.add(key);
      }
      if (Object.keys(fields).length > 0) return { fields };

      const out: {
        subject: string;
        period: string | null;
        from: Capacity | null;
        to: Capacity | null;
      }[] = [];
      for (const e of entries) {
        const match = (q: ReturnType<typeof baseOf>) =>
          e.period === null
            ? q.where('period_start', 'is', null)
            : q.where('period_start', '=', e.period);
        const baseOf = () =>
          trx
            .selectFrom('plan_capacity')
            .where('plan_id', '=', plan.id)
            .where(
              e.teamId !== undefined ? 'team_id' : 'user_id',
              '=',
              (e.teamId ?? e.userId) as number,
            );
        const current = await match(baseOf()).select(['id', 'amount', 'note']).executeTakeFirst();
        const before = current ? { amount: Number(current.amount), note: current.note } : null;
        const after = toCapacity(e, before);
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        if (after === null) {
          await trx
            .deleteFrom('plan_capacity')
            .where('id', '=', current?.id as number)
            .execute();
        } else if (current) {
          await trx
            .updateTable('plan_capacity')
            .set({ amount: after.amount, note: after.note })
            .where('id', '=', current.id)
            .execute();
        } else {
          await trx
            .insertInto('plan_capacity')
            .values({
              workspace_id: ws,
              plan_id: plan.id,
              team_id: e.teamId ?? null,
              user_id: e.userId ?? null,
              period_start: e.period,
              amount: after.amount,
              note: after.note,
            })
            .execute();
        }
        out.push({ subject: subjectKey(e), period: e.period, from: before, to: after });
      }
      if (out.length > 0) {
        await emit(
          trx,
          { workspaceId: ws, actorId: user.id },
          { type: 'plan.capacity_set', subjectId: plan.id, payload: { changes: out } },
        );
      }
      return { changes: out };
    });
    if ('missing' in outcome) return reply.code(404).send({ error: 'not_found' });
    if ('settingsChanged' in outcome) {
      return reply.code(409).send({ error: 'settings_changed', ...outcome.settingsChanged });
    }
    if ('fields' in outcome) return reply.code(400).send({ error: 'invalid_fields', ...outcome });
    return { changed: outcome.changes.length };
  });
}

/** What an entry leaves: none when its amount is null; a note left out keeps the one set. */
function toCapacity(e: CapacityEntry, before: Capacity | null): Capacity | null {
  if (e.amount === null) return null;
  return { amount: round(e.amount), note: e.note ?? before?.note ?? '' };
}
