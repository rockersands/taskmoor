import type { Database, PlanCapacityUnit } from '@taskmoor/db';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { dayNumber, isoDay, type Period, weekThursday } from './periods';

/**
 * How a Multi-track plan counts capacity and load (ADR-122 stages 3 and 7): the estimate in the
 * plan's unit, the members of its teams, the capacity set for a person or team in each period,
 * and a person's work elsewhere by whole weeks. The Capacity tab (`routes/plan-capacity.ts`) and
 * the auto-scheduler read them through here, so a run counts exactly as Capacity does.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** Names a number field goes by when it holds a ticket's points (as boards read them). */
const POINTS_NAMES = ['points', 'story points', 'puntos'];

/** An amount rounded to hundredths, as Capacity shows and compares it. */
export const round = (n: number) => Math.round(n * 100) / 100;

/** The index of the period that holds `day`, or -1 when none does. */
export function periodIndex(periods: readonly Period[], day: string): number {
  const n = dayNumber(day);
  return periods.findIndex((x) => n >= dayNumber(x.start) && n <= dayNumber(x.end));
}

/** The workspace's own Points field: the oldest shared number field of that name. */
export async function pointsField(db: Db, ws: number) {
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

/** A ticket's estimate in the plan's unit, null for none. The ticket is `k`. */
export function estimateSql(
  unit: PlanCapacityUnit,
  fieldId: number | null,
): RawBuilder<number | null> {
  if (unit === 'hours') return sql`(k.original_estimate / 3600.0)`;
  if (fieldId === null) return sql`NULL::numeric`;
  const key = String(fieldId);
  return sql`(CASE WHEN jsonb_typeof(k.fields -> ${key}::text) = 'number'
                   THEN (k.fields ->> ${key}::text)::numeric END)`;
}

export interface Member {
  id: number;
  name: string;
  active: boolean;
}

/** The members of each team, in name order; everyone `membersOf("id:<team>")` returns. */
export async function membersOf(
  q: Db,
  ws: number,
  teamIds: readonly number[],
): Promise<Map<number, Member[]>> {
  if (teamIds.length === 0) return new Map<number, Member[]>();
  const rows = await q
    .selectFrom('team_member as m')
    .innerJoin('app_user as u', 'u.id', 'm.user_id')
    .select(['m.team_id', 'u.id', 'u.name', 'u.deactivated_at'])
    .where('m.workspace_id', '=', ws)
    .where('m.team_id', 'in', [...teamIds])
    .orderBy(sql`lower(u.name)`)
    .orderBy('u.id')
    .execute();
  const out = new Map<number, Member[]>();
  for (const r of rows) {
    const list = out.get(r.team_id) ?? [];
    list.push({ id: r.id, name: r.name, active: r.deactivated_at === null });
    out.set(r.team_id, list);
  }
  return out;
}

/** Every capacity set in a plan: a team's or a person's, for every period (null) or one. */
export async function capacityRows(db: Db, planId: number) {
  return db
    .selectFrom('plan_capacity')
    .select(['team_id', 'user_id', 'period_start', 'amount', 'note'])
    .where('plan_id', '=', planId)
    .execute();
}
export type CapacityRow = Awaited<ReturnType<typeof capacityRows>>[number];

export interface Capacity {
  amount: number;
  note: string;
}
export type CapacityFrom = 'period' | 'default' | 'members' | null;
export interface PeriodCapacity {
  amount: number | null;
  note: string;
  from: CapacityFrom;
}
export interface SubjectCapacity {
  default: Capacity | null;
  periods: PeriodCapacity[];
}

/**
 * The capacity set for a person or team: every period's, and each period's own, which wins
 * where there is one.
 */
export function capacityOf(
  rows: readonly CapacityRow[],
  periods: readonly Period[],
  subject: { teamId?: number; userId?: number },
): SubjectCapacity {
  const mine = rows.filter((c) =>
    subject.teamId ? c.team_id === subject.teamId : c.user_id === subject.userId,
  );
  const of = (row: CapacityRow | undefined): Capacity | null =>
    row ? { amount: Number(row.amount), note: row.note } : null;
  const fallback = of(mine.find((c) => c.period_start === null));
  return {
    default: fallback,
    periods: periods.map((x) => {
      const own = of(mine.find((c) => c.period_start === x.start));
      const set = own ?? fallback;
      return {
        amount: set?.amount ?? null,
        note: set?.note ?? '',
        from: (own ? 'period' : fallback ? 'default' : null) as CapacityFrom,
      };
    }),
  };
}

/**
 * A team's capacity: its own in each period where it has one; else the sum of its members' when
 * any of them has one there (`from: 'members'`); else none.
 */
export function teamCapacity(
  own: SubjectCapacity,
  members: readonly { periods: readonly { amount: number | null }[] }[],
): SubjectCapacity {
  return {
    default: own.default,
    periods: own.periods.map((c, i) => {
      if (c.amount !== null) return c;
      const set = members.flatMap((m) => {
        const x = m.periods[i]?.amount;
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
}

export interface Elsewhere {
  count: number;
  amount: number;
}

/**
 * Each person's other work due in the periods: tickets assigned to them that `where` does not
 * hold (outside the plan, filtered out or hidden from the viewer), counted and summed, never
 * named. The trash and archived tracks hold none. Counted by whole weeks, Monday to Sunday, in
 * the period that holds each week's Thursday, so no setting of the periods narrows hidden work
 * below a week. A person with none has no entry; amounts are not rounded.
 */
export async function elsewhereWork(
  trx: Db,
  options: {
    ws: number;
    people: readonly number[];
    where: RawBuilder<boolean> | null;
    value: RawBuilder<number | null>;
    periods: readonly Period[];
  },
): Promise<Map<number, Elsewhere[]>> {
  const { ws, people, where, value, periods } = options;
  const away = new Map<number, Elsewhere[]>();
  if (people.length === 0 || periods.length === 0) return away;
  // The weeks whose Thursday is in view, Monday to Sunday.
  const weeksStart = isoDay(dayNumber(periods[0]?.start as string) - 3);
  const weeksEnd = isoDay(dayNumber(periods.at(-1)?.end as string) + 3);
  const rows = (
    await sql<{ assignee_id: number; due: string; n: number; amount: number }>`
      SELECT k.assignee_id, k.due_date::text AS due, count(*)::int AS n,
             COALESCE(sum(${value}), 0)::float8 AS amount
        FROM ticket k JOIN track t ON t.id = k.track_id
       WHERE k.workspace_id = ${ws}::int AND k.assignee_id = ANY(${[...people]}::int[])
         AND k.due_date BETWEEN ${weeksStart}::date AND ${weeksEnd}::date
         AND k.deleted_at IS NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL
         ${where ? sql`AND (${where}) IS NOT TRUE` : sql``}
       GROUP BY k.assignee_id, k.due_date`.execute(trx)
  ).rows;
  for (const r of rows) {
    const list = away.get(r.assignee_id) ?? periods.map(() => ({ count: 0, amount: 0 }));
    const cell = list[periodIndex(periods, weekThursday(r.due))];
    if (cell) {
      cell.count += r.n;
      cell.amount += Number(r.amount);
    }
    away.set(r.assignee_id, list);
  }
  return away;
}
