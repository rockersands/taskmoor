import type { Database, PlanCapacityUnit } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import type { z } from 'zod';
import { requireUser } from '../auth';
import { emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import { type CapacityEntry, capacityBody, capacityQuery, idParam } from '../plans/model';
import {
  dayNumber,
  isoDay,
  isPeriodStart,
  type Period,
  type PeriodSetting,
  periodsBefore,
  periodsFrom,
} from '../plans/periods';
import { planTickets, sourceRows } from '../plans/query';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
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
 *   `elsewhere`, never named or linked. Unassigned work, and work of people in none of the
 *   plan's teams, have rows of their own, without capacity.
 * - `PUT /api/v1/plans/:id/capacity` sets, changes or removes capacities (a team's or a
 *   member's, for every period or one), for those who may change the plan; one
 *   `plan.capacity_set` event lists every change.
 *
 * A team's capacity in a period is its own (that period's, else every period's); without one,
 * the sum of its members' when any has one. Over capacity: what the row's people have due in the
 * period, here and elsewhere, is more than that.
 */
const DEFAULT_PERIODS = 6;
/** Names a number field goes by when it holds a ticket's points (as boards read them). */
const POINTS_NAMES = ['points', 'story points', 'puntos'];
const UNSCHEDULED = 'stage != closed AND due IS EMPTY';

interface Work {
  count: number;
  amount: number;
  unestimated: number;
}
interface Elsewhere {
  count: number;
  amount: number;
}
interface Capacity {
  amount: number;
  note: string;
}
type CapacityFrom = 'period' | 'default' | 'members' | null;

export interface PlanCapacityOptions {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

const round = (n: number) => Math.round(n * 100) / 100;
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

  /** The members of each team, in name order; everyone `membersOf("id:<team>")` returns. */
  async function membersOf(ws: number, teamIds: readonly number[]) {
    if (teamIds.length === 0)
      return new Map<number, { id: number; name: string; active: boolean }[]>();
    const rows = await db
      .selectFrom('team_member as m')
      .innerJoin('app_user as u', 'u.id', 'm.user_id')
      .select(['m.team_id', 'u.id', 'u.name', 'u.deactivated_at'])
      .where('m.workspace_id', '=', ws)
      .where('m.team_id', 'in', [...teamIds])
      .orderBy(sql`lower(u.name)`)
      .orderBy('u.id')
      .execute();
    const out = new Map<number, { id: number; name: string; active: boolean }[]>();
    for (const r of rows) {
      const list = out.get(r.team_id) ?? [];
      list.push({ id: r.id, name: r.name, active: r.deactivated_at === null });
      out.set(r.team_id, list);
    }
    return out;
  }

  /** The workspace's own Points field: the oldest shared number field of that name. */
  async function pointsField(ws: number) {
    return (
      (await db
        .selectFrom('field')
        .select(['id', 'name'])
        .where('workspace_id', '=', ws)
        .where('track_id', 'is', null)
        .where('type', '=', 'number')
        .where(sql<boolean>`lower(trim(name)) = ANY(${POINTS_NAMES}::text[])`)
        .orderBy('id')
        .executeTakeFirst()) ?? null
    );
  }

  /** A ticket's estimate in the plan's unit, null for none. */
  function estimate(unit: PlanCapacityUnit, fieldId: number | null): RawBuilder<number | null> {
    if (unit === 'hours') return sql`(k.original_estimate / 3600.0)`;
    if (fieldId === null) return sql`NULL::numeric`;
    const key = String(fieldId);
    return sql`(CASE WHEN jsonb_typeof(k.fields -> ${key}::text) = 'number'
                     THEN (k.fields ->> ${key}::text)::numeric END)`;
  }

  app.get('/api/v1/plans/:id/capacity', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const q = capacityQuery.safeParse(request.query ?? {});
    if (!q.success)
      return reply.code(400).send({ error: 'invalid_fields', fields: shapeErrors(q.error) });
    const { from, periods: count, ...filters } = q.data;
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
      const setting: PeriodSetting = periodOf(plan);
      const first = from ?? new Date().toISOString().slice(0, 10);
      const periods = periodsFrom(setting, first, count ?? DEFAULT_PERIODS);
      const windowStart = periods[0]?.start as string;
      const windowEnd = periods.at(-1)?.end as string;
      const periodAt = (due: string) => {
        const n = dayNumber(due);
        return periods.findIndex((x) => n >= dayNumber(x.start) && n <= dayNumber(x.end));
      };

      const teams = await planTeams(db, plan.id);
      const members = await membersOf(
        ws,
        teams.map((t) => t.id),
      );
      const people = [...new Set([...members.values()].flat().map((m) => m.id))];
      const field = plan.capacity_unit === 'points' ? await pointsField(ws) : null;
      const value = estimate(plan.capacity_unit, field?.id ?? null);
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
                SELECT k.assignee_id, k.due_date::text AS due, count(*)::int AS n,
                       COALESCE(sum(${value}), 0)::float8 AS amount,
                       count(*) FILTER (WHERE ${value} IS NULL)::int AS unestimated
                  FROM ticket k JOIN status s ON s.id = k.status_id
                 WHERE ${where}
                   AND (k.due_date BETWEEN ${windowStart}::date AND ${windowEnd}::date
                        OR (k.due_date IS NULL AND s.stage <> 'closed'))
                 GROUP BY k.assignee_id, k.due_date`.execute(trx)
            ).rows
          : [];
        // The rest of the members' work due in the window: outside the plan, filtered out or
        // hidden from the viewer. Counted, never named. The trash and archived tracks hold none.
        const elsewhere =
          people.length === 0
            ? []
            : (
                await sql<{ assignee_id: number; due: string; n: number; amount: number }>`
                  SELECT k.assignee_id, k.due_date::text AS due, count(*)::int AS n,
                         COALESCE(sum(${value}), 0)::float8 AS amount
                    FROM ticket k JOIN track t ON t.id = k.track_id
                   WHERE k.workspace_id = ${ws}::int AND k.assignee_id = ANY(${people}::int[])
                     AND k.due_date BETWEEN ${windowStart}::date AND ${windowEnd}::date
                     AND k.deleted_at IS NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL
                     ${where ? sql`AND (${where}) IS NOT TRUE` : sql``}
                   GROUP BY k.assignee_id, k.due_date`.execute(trx)
              ).rows;
        return { planned, elsewhere };
      });

      const capacityRows = await db
        .selectFrom('plan_capacity')
        .select(['team_id', 'user_id', 'period_start', 'amount', 'note'])
        .where('plan_id', '=', plan.id)
        .execute();

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
      const away = new Map<number, Elsewhere[]>();
      for (const r of counted.elsewhere) {
        const list = away.get(r.assignee_id) ?? periods.map(() => ({ count: 0, amount: 0 }));
        const at = periodAt(r.due);
        const cell = list[at];
        if (cell) {
          cell.count += r.n;
          cell.amount += Number(r.amount);
        }
        away.set(r.assignee_id, list);
      }

      /** The capacity set for a subject: every period's, and each period's own. */
      const capacityOf = (subject: { teamId?: number; userId?: number }) => {
        const rows = capacityRows.filter((c) =>
          subject.teamId ? c.team_id === subject.teamId : c.user_id === subject.userId,
        );
        const of = (row: (typeof rows)[number] | undefined): Capacity | null =>
          row ? { amount: Number(row.amount), note: row.note } : null;
        const fallback = of(rows.find((c) => c.period_start === null));
        return {
          default: fallback,
          periods: periods.map((x) => {
            const own = of(rows.find((c) => c.period_start === x.start));
            const set = own ?? fallback;
            return {
              amount: set?.amount ?? null,
              note: set?.note ?? '',
              from: (own ? 'period' : fallback ? 'default' : null) as CapacityFrom,
            };
          }),
        };
      };
      const cellsOf = (
        work: Work[],
        elsewhere: Elsewhere[],
        capacity: { amount: number | null }[],
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
          };
        });

      const personRow = (m: { id: number; name: string; active: boolean }) => {
        const work = byPerson.get(m.id) ?? { cells: periods.map(none), unscheduled: none() };
        const capacity = capacityOf({ userId: m.id });
        return {
          id: m.id,
          name: m.name,
          active: m.active,
          clause: `assignee = ${m.id}`,
          capacity,
          cells: cellsOf(work.cells, away.get(m.id) ?? [], capacity.periods),
          unscheduled: rounded(work.unscheduled),
          work,
        };
      };
      const teamRows = teams.map((team) => {
        const people = (members.get(team.id) ?? []).map(personRow);
        const own = capacityOf({ teamId: team.id });
        // Without its own capacity in a period, a team has its members' when any has one.
        const capacity = {
          default: own.default,
          periods: own.periods.map((c, i) => {
            if (c.amount !== null) return c;
            const set = people.flatMap((m) => {
              const x = m.capacity.periods[i]?.amount;
              return x === null || x === undefined ? [] : [x];
            });
            return set.length === 0
              ? c
              : {
                  amount: round(set.reduce((a, b) => a + b, 0)),
                  note: '',
                  from: 'members' as const,
                };
          }),
        };
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
          cells: cellsOf(work, elsewhere, capacity.periods),
          unscheduled: rounded(people.reduce((sum, m) => add(sum, m.work.unscheduled), none())),
          members: people.map(({ work: _work, ...m }) => m),
        };
      });

      // Unassigned work, and work of people in none of the plan's teams: no capacity of their own.
      const inTeams = new Set(people);
      const unassigned = byPerson.get(null) ?? { cells: periods.map(none), unscheduled: none() };
      const others = { cells: periods.map(none), unscheduled: none() };
      for (const [id, row] of byPerson) {
        if (id === null || inTeams.has(id)) continue;
        others.cells = others.cells.map((c, i) => add(c, row.cells[i] as Work));
        others.unscheduled = add(others.unscheduled, row.unscheduled);
      }
      return {
        plan: { id: plan.id, name: plan.name },
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
          cells: unassigned.cells.map(rounded),
          unscheduled: rounded(unassigned.unscheduled),
        },
        others: {
          clause:
            teams.length === 0
              ? 'assignee IS NOT EMPTY'
              : teams
                  .map((t) => `assignee NOT IN membersOf(${quoted(`id:${t.id}`)})`)
                  .join(' AND '),
          cells: others.cells.map(rounded),
          unscheduled: rounded(others.unscheduled),
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
    const setting = periodOf(plan);
    const entries = parsed.data.entries;

    // Only the plan's teams and their members; only first days of the plan's periods.
    const teamIds = new Set((await planTeams(db, plan.id)).map((t) => t.id));
    const memberIds = new Set(
      [...(await membersOf(ws, [...teamIds])).values()].flat().map((m) => m.id),
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
    if (Object.keys(fields).length > 0) {
      return reply.code(400).send({ error: 'invalid_fields', fields });
    }

    const changes = await db.transaction().execute(async (trx) => {
      // One writer at a time per plan, so two people's changes never interleave.
      await trx.selectFrom('plan').select('id').where('id', '=', plan.id).forUpdate().execute();
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
      return out;
    });
    return { changed: changes.length };
  });
}

/** What an entry leaves: none when its amount is null; a note left out keeps the one set. */
function toCapacity(e: CapacityEntry, before: Capacity | null): Capacity | null {
  if (e.amount === null) return null;
  return { amount: round(e.amount), note: e.note ?? before?.note ?? '' };
}
