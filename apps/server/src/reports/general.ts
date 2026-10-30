import type { Database } from '@taskmoor/db';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import type { Scope } from '../boards/data';

/**
 * General reports over any query (M1-062; RPT-002; ADR-059), counted in SQL so they stay one
 * statement each over large result sets.
 *
 * - **Created vs closed**: per period (day, week from Monday, month) of the viewer's calendar,
 *   the tickets created and the closings, a closing being a close reason set where there was
 *   none (the change history's `closeReason` rows). Closings are events: a ticket closed,
 *   reopened and closed again counts each time, so a past period never changes when a ticket
 *   is reopened later (RPT-003 (1)).
 */
type Db = Kysely<Database> | Transaction<Database>;

export const PERIODS = ['day', 'week', 'month'] as const;
export type Period = (typeof PERIODS)[number];

const DAY = 86_400_000;
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The first local date of the period `date` falls in. */
export function periodStart(date: string, period: Period): string {
  if (period === 'day') return date;
  if (period === 'month') return `${date.slice(0, 7)}-01`;
  // ISO weeks start on Monday.
  const weekday = (new Date(utc(date)).getUTCDay() + 6) % 7;
  return iso(utc(date) - weekday * DAY);
}

/** Every period from the one holding `from` to the one holding `to`, by its first date. */
export function periodsBetween(from: string, to: string, period: Period): string[] {
  const out: string[] = [];
  for (let d = periodStart(from, period); d <= to; ) {
    out.push(d);
    if (period === 'day') d = iso(utc(d) + DAY);
    else if (period === 'week') d = iso(utc(d) + 7 * DAY);
    else {
      const [y, m] = d.split('-').map(Number) as [number, number];
      d = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
    }
  }
  return out;
}

export interface CreatedClosed {
  /** The first local date of each period. */
  periods: string[];
  created: number[];
  closed: number[];
}

/**
 * Created and closed per period for the tickets matching `scope` (a condition on the ticket as
 * `k`), between the instants `start` (inclusive) and `end` (exclusive), on `timeZone`'s days.
 */
export async function createdVsClosed(
  db: Db,
  input: {
    workspaceId: number;
    scope: RawBuilder<boolean>;
    from: string;
    to: string;
    start: Date;
    end: Date;
    timeZone: string;
    period: Period;
  },
): Promise<CreatedClosed> {
  const { workspaceId, scope, start, end, timeZone } = input;
  const created = await sql<{ day: string; n: number }>`
    SELECT to_char((k.created_at AT TIME ZONE ${timeZone})::date, 'YYYY-MM-DD') AS day,
           count(*)::int AS n
      FROM ticket k
     WHERE ${scope} AND k.created_at >= ${start}::timestamptz AND k.created_at < ${end}::timestamptz
     GROUP BY 1`.execute(db);
  const closed = await sql<{ day: string; n: number }>`
    SELECT to_char((c.at AT TIME ZONE ${timeZone})::date, 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM ticket_change c JOIN ticket k ON k.id = c.ticket_id
     WHERE c.workspace_id = ${workspaceId}::int AND c.field = 'closeReason'
       AND c.from_value IS NULL AND c.to_value IS NOT NULL
       AND c.at >= ${start}::timestamptz AND c.at < ${end}::timestamptz AND ${scope}
     GROUP BY 1`.execute(db);
  const periods = periodsBetween(input.from, input.to, input.period);
  const index = new Map(periods.map((p, i) => [p, i]));
  const bucket = (rows: { day: string; n: number }[]) => {
    const out = new Array<number>(periods.length).fill(0);
    for (const r of rows) {
      const i = index.get(periodStart(r.day, input.period));
      if (i !== undefined) out[i] = (out[i] ?? 0) + r.n;
    }
    return out;
  };
  return { periods, created: bucket(created.rows), closed: bucket(closed.rows) };
}

/**
 * - **Two-dimensional statistics** (RPT-005 (2)): the matching tickets counted by the values of
 *   two fields. A field with several values (labels, releases, areas, multiple selects) counts a
 *   ticket once under each; a ticket without a value counts under "none". Row and column totals
 *   count tickets, so a ticket with two labels adds one to its row, not two. An axis with more
 *   than `MAX_AXIS_VALUES` values keeps the most frequent and gathers the rest under "other".
 */
export const SYSTEM_AXES = [
  'track',
  'type',
  'status',
  'priority',
  'assignee',
  'requester',
  'creator',
  'closeReason',
  'labels',
  'targetRelease',
  'foundInRelease',
  'area',
] as const;
export type SystemAxis = (typeof SYSTEM_AXES)[number];

/** How a custom field's values group: by option, person, group, release, area or label. */
export type CustomAxisKind = 'option' | 'user' | 'group' | 'release' | 'area' | 'label';

export type Axis =
  | { kind: 'system'; field: SystemAxis }
  | { kind: 'custom'; fieldId: number; values: CustomAxisKind }
  /** One value for every ticket: counting by one field is counting by it and this. */
  | { kind: 'all' };

/** How each custom field type groups, where it can. */
const CUSTOM_AXES: Readonly<Record<string, CustomAxisKind>> = {
  select: 'option',
  'cascading-select': 'option',
  user: 'user',
  group: 'group',
  release: 'release',
  area: 'area',
  labels: 'label',
};

/** An axis by its query name: a system field or `cf[<id>]` of a field that groups. */
export function parseAxis(name: string, scope: Scope): Axis | 'not_found' | 'not_groupable' {
  if ((SYSTEM_AXES as readonly string[]).includes(name)) {
    return { kind: 'system', field: name as SystemAxis };
  }
  const custom = /^cf\[(\d{1,10})\]$/.exec(name);
  if (!custom) return 'not_found';
  const field = scope.catalog.fields.get(Number(custom[1]));
  if (!field) return 'not_found';
  const values = CUSTOM_AXES[field.type];
  return values ? { kind: 'custom', fieldId: field.id, values } : 'not_groupable';
}

export const MAX_AXIS_VALUES = 50;

/** The ids of an axis' values on the ticket `k`, as text; empty where it has none. */
function axisValues(axis: Axis): RawBuilder<string[]> {
  if (axis.kind === 'all') return sql<string[]>`ARRAY['all']::text[]`;
  if (axis.kind === 'custom') {
    const table =
      axis.values === 'user' ? 'v_user' : axis.values === 'label' ? 'v_text' : 'v_option';
    return sql<string[]>`ARRAY(SELECT v.value::text FROM ${sql.table(table)} v
                                WHERE v.ticket_id = k.id AND v.field_id = ${axis.fieldId}::int)`;
  }
  const one = (column: string) => sql<string[]>`ARRAY[${sql.ref(`k.${column}`)}::text]`;
  switch (axis.field) {
    case 'track':
      return one('track_id');
    case 'type':
      return one('ticket_type_id');
    case 'status':
      return one('status_id');
    case 'priority':
      return one('priority_id');
    case 'assignee':
      return one('assignee_id');
    case 'requester':
      return one('requester_id');
    case 'creator':
      return one('creator_id');
    case 'closeReason':
      return one('close_reason_id');
    case 'labels':
      return sql<string[]>`k.labels`;
    case 'targetRelease':
    case 'foundInRelease':
      return sql<string[]>`ARRAY(SELECT tr.release_id::text FROM ticket_release tr
                                  WHERE tr.ticket_id = k.id
                                    AND tr.role = ${axis.field === 'targetRelease' ? 'target' : 'found'})`;
    case 'area':
      return sql<
        string[]
      >`ARRAY(SELECT ta.area_id::text FROM ticket_area ta WHERE ta.ticket_id = k.id)`;
  }
}

/** One value or none per row: an empty list counts once as none (null). */
const each = (values: RawBuilder<string[]>) =>
  sql`unnest(coalesce(nullif(${values}, '{}'::text[]), ARRAY[NULL::text]))`;

interface Named {
  id: string;
  name: string;
  order: number;
}

/** The names of an axis' values, in the order the axis lists them. */
async function names(
  db: Db,
  workspaceId: number,
  axis: Axis,
  ids: readonly string[],
): Promise<Map<string, Named>> {
  const numeric = ids.filter((id) => /^\d{1,10}$/.test(id)).map(Number);
  const rows = async (
    query: RawBuilder<{ id: string; name: string; order: number }>,
  ): Promise<Map<string, Named>> =>
    new Map((await query.execute(db)).rows.map((r) => [String(r.id), { ...r, id: String(r.id) }]));
  const byName = (table: string) =>
    sql<{ id: string; name: string; order: number }>`
      SELECT id::text AS id, name, row_number() OVER (ORDER BY lower(name), id)::int AS order
        FROM ${sql.table(table)} WHERE workspace_id = ${workspaceId}::int AND id = ANY(${numeric}::int[])`;
  const bySort = (table: string) =>
    sql<{ id: string; name: string; order: number }>`
      SELECT id::text AS id, name, row_number() OVER (ORDER BY sort_order, id)::int AS order
        FROM ${sql.table(table)} WHERE workspace_id = ${workspaceId}::int AND id = ANY(${numeric}::int[])`;
  const releases = () =>
    sql<{ id: string; name: string; order: number }>`
      SELECT id::text AS id, name, row_number() OVER (ORDER BY track_id, sort_order, id)::int AS order
        FROM release WHERE workspace_id = ${workspaceId}::int AND id = ANY(${numeric}::int[])`;
  const labels = () =>
    new Map(
      [...ids]
        .sort((a, b) => a.localeCompare(b))
        .map((id, i): [string, Named] => [id, { id, name: id, order: i }]),
    );
  if (axis.kind === 'all') return new Map([['all', { id: 'all', name: '', order: 0 }]]);
  if (axis.kind === 'custom') {
    switch (axis.values) {
      case 'option':
        return rows(sql<{ id: string; name: string; order: number }>`
          SELECT id::text AS id, value AS name,
                 row_number() OVER (ORDER BY sort_order, id)::int AS order
            FROM field_option WHERE workspace_id = ${workspaceId}::int AND id = ANY(${numeric}::int[])`);
      case 'user':
        return rows(byName('app_user'));
      case 'group':
        return rows(byName('user_group'));
      case 'release':
        return rows(releases());
      case 'area':
        return rows(byName('area'));
      case 'label':
        return labels();
    }
  }
  switch (axis.field) {
    case 'track':
      return rows(sql<{ id: string; name: string; order: number }>`
        SELECT id::text AS id, name, row_number() OVER (ORDER BY key, id)::int AS order
          FROM track WHERE workspace_id = ${workspaceId}::int AND id = ANY(${numeric}::int[])`);
    case 'type':
      return rows(byName('ticket_type'));
    case 'status':
    case 'priority':
    case 'closeReason':
      return rows(bySort(axis.field === 'closeReason' ? 'close_reason' : axis.field));
    case 'assignee':
    case 'requester':
    case 'creator':
      return rows(byName('app_user'));
    case 'labels':
      return labels();
    case 'targetRelease':
    case 'foundInRelease':
      return rows(releases());
    case 'area':
      return rows(byName('area'));
  }
}

export interface AxisValue {
  /** The value's id (a label's text); null for none, `*` for the rest gathered as other. */
  id: string | null;
  name: string | null;
  kind: 'value' | 'none' | 'other';
  /** Tickets with this value. */
  total: number;
}

export interface TwoDimensional {
  x: AxisValue[];
  y: AxisValue[];
  /** Tickets per x value (rows) and y value (columns). */
  cells: number[][];
  /** Tickets matching. */
  total: number;
}

const keyOf = (id: string | null) => id ?? '';

export async function twoDimensional(
  db: Db,
  input: { workspaceId: number; scope: RawBuilder<boolean>; x: Axis; y: Axis },
): Promise<TwoDimensional> {
  const { workspaceId, scope } = input;
  const xs = axisValues(input.x);
  const ys = axisValues(input.y);
  const pairs = await sql<{ x: string | null; y: string | null; n: number }>`
    SELECT x.v AS x, y.v AS y, count(*)::int AS n
      FROM ticket k
     CROSS JOIN LATERAL ${each(xs)} AS x(v)
     CROSS JOIN LATERAL ${each(ys)} AS y(v)
     WHERE ${scope}
     GROUP BY 1, 2`.execute(db);
  const totals = async (values: RawBuilder<string[]>) =>
    (
      await sql<{ v: string | null; n: number }>`
        SELECT a.v, count(*)::int AS n FROM ticket k CROSS JOIN LATERAL ${each(values)} AS a(v)
         WHERE ${scope} GROUP BY 1`.execute(db)
    ).rows;
  const xTotals = await totals(xs);
  const yTotals = await totals(ys);
  const total =
    (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ticket k WHERE ${scope}`.execute(db))
      .rows[0]?.n ?? 0;

  /** The axis' values in order, none last, the least frequent gathered as other past the cap. */
  const axis = async (a: Axis, counted: { v: string | null; n: number }[]) => {
    const named = await names(
      db,
      workspaceId,
      a,
      counted.flatMap((c) => (c.v === null ? [] : [c.v])),
    );
    let values = counted
      .filter((c) => c.v !== null)
      .map((c) => ({ id: c.v as string, n: c.n, named: named.get(c.v as string) }));
    let other = 0;
    if (values.length > MAX_AXIS_VALUES) {
      const kept = new Set(
        [...values]
          .sort((p, q) => q.n - p.n || p.id.localeCompare(q.id))
          .slice(0, MAX_AXIS_VALUES)
          .map((v) => v.id),
      );
      other = values.filter((v) => !kept.has(v.id)).length;
      values = values.filter((v) => kept.has(v.id));
    }
    values.sort(
      (p, q) =>
        (p.named?.order ?? Number.MAX_SAFE_INTEGER) - (q.named?.order ?? Number.MAX_SAFE_INTEGER) ||
        p.id.localeCompare(q.id),
    );
    const out: AxisValue[] = values.map((v) => ({
      id: v.id,
      name: v.named?.name ?? null,
      kind: 'value',
      total: v.n,
    }));
    const kept = new Set(out.map((v) => v.id));
    if (other > 0) out.push({ id: '*', name: null, kind: 'other', total: 0 });
    const none = counted.find((c) => c.v === null);
    if (none) out.push({ id: null, name: null, kind: 'none', total: none.n });
    /** Where a raw value lands on the axis. */
    const slot = (v: string | null) =>
      v === null ? keyOf(null) : kept.has(v) ? v : other > 0 ? '*' : v;
    return { out, slot };
  };
  const ax = await axis(input.x, xTotals);
  const ay = await axis(input.y, yTotals);
  const xIndex = new Map(ax.out.map((v, i) => [keyOf(v.id), i]));
  const yIndex = new Map(ay.out.map((v, i) => [keyOf(v.id), i]));
  const cells = ax.out.map(() => new Array<number>(ay.out.length).fill(0));
  for (const p of pairs.rows) {
    const i = xIndex.get(ax.slot(p.x));
    const j = yIndex.get(ay.slot(p.y));
    if (i === undefined || j === undefined) continue;
    const row = cells[i] as number[];
    row[j] = (row[j] ?? 0) + p.n;
  }
  // "Other" totals count tickets once even when several of their values were gathered.
  const otherTotal = async (a: Axis, kept: AxisValue[]) => {
    const ids = kept.flatMap((v) => (v.kind === 'value' && v.id !== null ? [v.id] : []));
    return (
      (
        await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM ticket k
           WHERE ${scope} AND EXISTS (SELECT 1 FROM unnest(${axisValues(a)}) AS a(v)
                                       WHERE NOT (a.v = ANY(${ids}::text[])))`.execute(db)
      ).rows[0]?.n ?? 0
    );
  };
  for (const [a, values] of [
    [input.x, ax.out],
    [input.y, ay.out],
  ] as const) {
    const other = values.find((v) => v.kind === 'other');
    if (other) other.total = await otherTotal(a, values);
  }
  return { x: ax.out, y: ay.out, cells, total };
}

/** Tickets counted by one field (pie charts, ticket statistics): its values with their totals. */
export async function oneDimensional(
  db: Db,
  input: { workspaceId: number; scope: RawBuilder<boolean>; axis: Axis },
): Promise<{ values: AxisValue[]; total: number }> {
  const table = await twoDimensional(db, { ...input, x: input.axis, y: { kind: 'all' } });
  return { values: table.x, total: table.total };
}

/**
 * - **Average age**: at the end of each period, how long the tickets open then had been open,
 *   on average (open: created by then and without a close reason then, by the history).
 */
export async function averageAge(
  db: Db,
  input: { scope: RawBuilder<boolean>; ends: readonly Date[] },
): Promise<{ age: number; open: number }[]> {
  const { rows } = await sql<{ i: string; n: number; age: number }>`
    SELECT e.i, count(*)::int AS n,
           coalesce(avg(EXTRACT(EPOCH FROM (e.at - k.created_at))), 0)::float AS age
      FROM unnest(${input.ends.map((d) => d.toISOString())}::timestamptz[]) WITH ORDINALITY AS e(at, i)
      JOIN ticket k ON k.created_at <= e.at AND ${input.scope}
     WHERE (SELECT c.to_value FROM ticket_change c
             WHERE c.ticket_id = k.id AND c.field = 'closeReason' AND c.at <= e.at
             ORDER BY c.at DESC, c.id DESC LIMIT 1) IS NULL
     GROUP BY e.i`.execute(db);
  const byIndex = new Map(rows.map((r) => [Number(r.i), r]));
  return input.ends.map((_, i) => {
    const r = byIndex.get(i + 1);
    return { age: Math.round(r?.age ?? 0), open: r?.n ?? 0 };
  });
}

/**
 * - **Time to close**: per period, the closings in it and how long their tickets had taken
 *   from creation, on average.
 */
export async function timeToClose(
  db: Db,
  input: {
    workspaceId: number;
    scope: RawBuilder<boolean>;
    from: string;
    to: string;
    start: Date;
    end: Date;
    timeZone: string;
    period: Period;
  },
): Promise<{ periods: string[]; closed: number[]; average: number[] }> {
  const { rows } = await sql<{ day: string; n: number; total: number }>`
    SELECT to_char((c.at AT TIME ZONE ${input.timeZone})::date, 'YYYY-MM-DD') AS day,
           count(*)::int AS n, sum(EXTRACT(EPOCH FROM (c.at - k.created_at)))::float AS total
      FROM ticket_change c JOIN ticket k ON k.id = c.ticket_id
     WHERE c.workspace_id = ${input.workspaceId}::int AND c.field = 'closeReason'
       AND c.from_value IS NULL AND c.to_value IS NOT NULL
       AND c.at >= ${input.start}::timestamptz AND c.at < ${input.end}::timestamptz
       AND ${input.scope}
     GROUP BY 1`.execute(db);
  const periods = periodsBetween(input.from, input.to, input.period);
  const index = new Map(periods.map((p, i) => [p, i]));
  const closed = new Array<number>(periods.length).fill(0);
  const total = new Array<number>(periods.length).fill(0);
  for (const r of rows) {
    const i = index.get(periodStart(r.day, input.period));
    if (i === undefined) continue;
    closed[i] = (closed[i] ?? 0) + r.n;
    total[i] = (total[i] ?? 0) + r.total;
  }
  return {
    periods,
    closed,
    average: closed.map((n, i) => (n === 0 ? 0 : Math.round((total[i] ?? 0) / n))),
  };
}
