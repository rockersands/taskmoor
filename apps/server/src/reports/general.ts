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

/** How a custom field's values group: by option, person, group, release, area, team or label. */
export type CustomAxisKind = 'option' | 'user' | 'group' | 'release' | 'area' | 'team' | 'label';

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
  team: 'team',
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
export function axisValues(axis: Axis): RawBuilder<string[]> {
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
export async function names(
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
      case 'team':
        return rows(byName('team'));
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

/**
 * An axis' values in order from their ticket counts: named values first, none last, and past
 * `MAX_AXIS_VALUES` the least frequent gathered as other. `slot` says where a raw value lands.
 */
async function orderAxis(
  db: Db,
  workspaceId: number,
  a: Axis,
  counted: { v: string | null; n: number }[],
): Promise<{ out: AxisValue[]; slot: (v: string | null) => string }> {
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
  const slot = (v: string | null) =>
    v === null ? keyOf(null) : kept.has(v) ? v : other > 0 ? '*' : v;
  return { out, slot };
}

/** The tickets with a value of `a` other than the kept ones, each once. */
const otherThan = (a: Axis, kept: readonly AxisValue[]) => {
  const ids = kept.flatMap((v) => (v.kind === 'value' && v.id !== null ? [v.id] : []));
  return sql<boolean>`EXISTS (SELECT 1 FROM unnest(${axisValues(a)}) AS a(v)
                               WHERE NOT (a.v = ANY(${ids}::text[])))`;
};

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

  const ax = await orderAxis(db, workspaceId, input.x, xTotals);
  const ay = await orderAxis(db, workspaceId, input.y, yTotals);
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
  const otherTotal = async (a: Axis, kept: AxisValue[]) =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM ticket k
         WHERE ${scope} AND ${otherThan(a, kept)}`.execute(db)
    ).rows[0]?.n ?? 0;
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
 *   on average (open: created by then and without a close reason then, by the history). Each
 *   close reason the history sets closes the ticket until its next change of close reason, so
 *   a ticket is open at an instant outside all of those spans: one anti-join, not a look into
 *   the history per ticket and period.
 */
export async function averageAge(
  db: Db,
  input: { scope: RawBuilder<boolean>; ends: readonly Date[] },
): Promise<{ age: number; open: number }[]> {
  const ends = input.ends.map((d) => d.toISOString());
  const last = ends.reduce((a, b) => (b > a ? b : a), ends[0] ?? new Date(0).toISOString());
  const { rows } = await sql<{ i: string; n: number; age: number }>`
    WITH k AS (SELECT k.id, k.created_at FROM ticket k WHERE ${input.scope}),
         changes AS (
           SELECT c.ticket_id, c.at, c.to_value,
                  lead(c.at) OVER (PARTITION BY c.ticket_id ORDER BY c.at, c.id) AS until
             FROM ticket_change c JOIN k ON k.id = c.ticket_id
            WHERE c.field = 'closeReason' AND c.at <= ${last}::timestamptz),
         closed AS (SELECT ticket_id, at, coalesce(until, 'infinity') AS until
                      FROM changes WHERE to_value IS NOT NULL)
    SELECT e.i, count(*)::int AS n,
           coalesce(avg(EXTRACT(EPOCH FROM (e.at - k.created_at))), 0)::float AS age
      FROM unnest(${ends}::timestamptz[]) WITH ORDINALITY AS e(at, i)
      JOIN k ON k.created_at <= e.at
     WHERE NOT EXISTS (SELECT 1 FROM closed s
                        WHERE s.ticket_id = k.id AND s.at <= e.at AND e.at < s.until)
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

/** The date fields a time-since report counts by: an instant, or a day as written. */
export const DATE_FIELDS = {
  created: { column: 'created_at', instant: true },
  updated: { column: 'updated_at', instant: true },
  closed: { column: 'closed_at', instant: true },
  due: { column: 'due_date', instant: false },
  start: { column: 'start_date', instant: false },
} as const;
export type DateField = keyof typeof DATE_FIELDS;

/**
 * - **Time since** (RPT-002): per period, the tickets whose date field falls in it as it stands
 *   now, an instant on `timeZone`'s days (created, updated, closed) or a day as written (due,
 *   start). Each ticket counts once, so a period equals the search `field >= first AND field <
 *   next`.
 */
export async function timeSince(
  db: Db,
  input: {
    scope: RawBuilder<boolean>;
    field: DateField;
    from: string;
    to: string;
    start: Date;
    end: Date;
    timeZone: string;
    period: Period;
  },
): Promise<{ periods: string[]; counts: number[] }> {
  const { column, instant } = DATE_FIELDS[input.field];
  const col = sql.ref(`k.${column}`);
  const { rows } = instant
    ? await sql<{ day: string; n: number }>`
        SELECT to_char((${col} AT TIME ZONE ${input.timeZone})::date, 'YYYY-MM-DD') AS day,
               count(*)::int AS n
          FROM ticket k
         WHERE ${input.scope} AND ${col} >= ${input.start}::timestamptz
           AND ${col} < ${input.end}::timestamptz
         GROUP BY 1`.execute(db)
    : await sql<{ day: string; n: number }>`
        SELECT to_char(${col}, 'YYYY-MM-DD') AS day, count(*)::int AS n
          FROM ticket k
         WHERE ${input.scope} AND ${col} >= ${input.from}::date AND ${col} <= ${input.to}::date
         GROUP BY 1`.execute(db);
  const periods = periodsBetween(input.from, input.to, input.period);
  const index = new Map(periods.map((p, i) => [p, i]));
  const counts = new Array<number>(periods.length).fill(0);
  for (const r of rows) {
    const i = index.get(periodStart(r.day, input.period));
    if (i !== undefined) counts[i] = (counts[i] ?? 0) + r.n;
  }
  return { periods, counts };
}

/** A ticket as the grouped and time reports list it. */
export interface ListedTicket {
  id: number;
  key: string;
  summary: string;
  status: string;
  /** In a status of the closed stage: the one definition of done (ADR-120). */
  closed: boolean;
  assignee: string | null;
}

export interface GroupValue extends AxisValue {
  /** Of `total`, those in a status of the closed stage. */
  closed: number;
  /** The first of them, most recently updated first; none for "other". */
  tickets: ListedTicket[];
}

/**
 * - **Single level group by** (RPT-002): the matching tickets grouped by one field like ticket
 *   statistics, each value with how many of its tickets are done (a status of the closed stage,
 *   as progress counts everywhere) and its first `limit` tickets, most recently updated first.
 */
export async function groupBy(
  db: Db,
  input: { workspaceId: number; scope: RawBuilder<boolean>; axis: Axis; limit: number },
): Promise<{ values: GroupValue[]; total: number; closed: number }> {
  const { workspaceId, scope, axis } = input;
  const values = axisValues(axis);
  const counted = (
    await sql<{ v: string | null; n: number; c: number }>`
      SELECT a.v, count(*)::int AS n, count(*) FILTER (WHERE st.stage = 'closed')::int AS c
        FROM ticket k JOIN status st ON st.id = k.status_id
       CROSS JOIN LATERAL ${each(values)} AS a(v)
       WHERE ${scope}
       GROUP BY 1`.execute(db)
  ).rows;
  const { out, slot } = await orderAxis(db, workspaceId, axis, counted);
  const closed = new Map<string, number>();
  for (const c of counted) closed.set(slot(c.v), (closed.get(slot(c.v)) ?? 0) + c.c);
  const totals = (
    await sql<{ n: number; c: number }>`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE st.stage = 'closed')::int AS c
        FROM ticket k JOIN status st ON st.id = k.status_id
       WHERE ${scope}`.execute(db)
  ).rows[0] ?? { n: 0, c: 0 };
  const other = out.find((v) => v.kind === 'other');
  if (other) {
    const gathered = (
      await sql<{ n: number; c: number }>`
        SELECT count(*)::int AS n, count(*) FILTER (WHERE st.stage = 'closed')::int AS c
          FROM ticket k JOIN status st ON st.id = k.status_id
         WHERE ${scope} AND ${otherThan(axis, out)}`.execute(db)
    ).rows[0] ?? { n: 0, c: 0 };
    other.total = gathered.n;
    closed.set('*', gathered.c);
  }
  const listed = out.flatMap((v) => (v.kind === 'value' && v.id !== null ? [v.id] : []));
  const rows = (
    await sql<ListedTicket & { v: string | null }>`
      SELECT x.v, k.id, t.key || '-' || k.number AS key, k.summary, s.name AS status,
             s.stage = 'closed' AS closed, u.name AS assignee
        FROM (SELECT a.v, k.id,
                     row_number() OVER (PARTITION BY a.v ORDER BY k.updated_at DESC, k.id DESC) AS rn
                FROM ticket k CROSS JOIN LATERAL ${each(values)} AS a(v)
               WHERE ${scope} AND (a.v IS NULL OR a.v = ANY(${listed}::text[]))) x
        JOIN ticket k ON k.id = x.id
        JOIN track t ON t.id = k.track_id
        JOIN status s ON s.id = k.status_id
        LEFT JOIN app_user u ON u.id = k.assignee_id
       WHERE x.rn <= ${input.limit}::int
       ORDER BY x.rn`.execute(db)
  ).rows;
  const tickets = new Map<string, ListedTicket[]>();
  for (const { v, ...ticket } of rows) {
    const list = tickets.get(keyOf(v)) ?? [];
    list.push(ticket);
    tickets.set(keyOf(v), list);
  }
  return {
    values: out.map((v) => ({
      ...v,
      closed: closed.get(keyOf(v.id)) ?? 0,
      tickets: v.kind === 'other' ? [] : (tickets.get(keyOf(v.id)) ?? []),
    })),
    total: totals.n,
    closed: totals.c,
  };
}

/** The time figures a workload can add up, and their ticket columns (seconds). */
export const WORK_STATISTICS = {
  remainingEstimate: 'remaining_estimate',
  originalEstimate: 'original_estimate',
  timeSpent: 'time_spent',
} as const;
export type WorkStatistic = keyof typeof WORK_STATISTICS;

export interface WorkValue extends AxisValue {
  /** The statistic added up over this value's tickets. */
  seconds: number;
  /** Of `total`, those with no value for the statistic. */
  unestimated: number;
}

/**
 * - **Workload** (RPT-002: user workload, release workload, workload pie chart): the matching
 *   tickets grouped by one field, with a time statistic (remaining or original estimate, time
 *   spent) added up per value. Grouped like ticket statistics: a ticket with several values adds
 *   to each, totals count it once, and "other" gathers the least frequent past the cap.
 */
export async function workload(
  db: Db,
  input: {
    workspaceId: number;
    scope: RawBuilder<boolean>;
    axis: Axis;
    statistic: WorkStatistic;
  },
): Promise<{ values: WorkValue[]; total: number; seconds: number; unestimated: number }> {
  const { workspaceId, scope, axis } = input;
  const col = sql.ref(`k.${WORK_STATISTICS[input.statistic]}`);
  const sums = sql`count(*)::int AS n, coalesce(sum(${col}), 0)::float8 AS s,
                   count(*) FILTER (WHERE ${col} IS NULL)::int AS u`;
  const counted = (
    await sql<{ v: string | null; n: number; s: number; u: number }>`
      SELECT a.v, ${sums} FROM ticket k CROSS JOIN LATERAL ${each(axisValues(axis))} AS a(v)
       WHERE ${scope} GROUP BY 1`.execute(db)
  ).rows;
  const { out, slot } = await orderAxis(db, workspaceId, axis, counted);
  const added = new Map<string, { s: number; u: number }>();
  for (const c of counted) {
    const at = added.get(slot(c.v)) ?? { s: 0, u: 0 };
    added.set(slot(c.v), { s: at.s + c.s, u: at.u + c.u });
  }
  const once = async (where: RawBuilder<boolean>) =>
    (
      await sql<{ n: number; s: number; u: number }>`
        SELECT ${sums} FROM ticket k WHERE ${where}`.execute(db)
    ).rows[0] ?? { n: 0, s: 0, u: 0 };
  const other = out.find((v) => v.kind === 'other');
  if (other) {
    const gathered = await once(sql<boolean>`${scope} AND ${otherThan(axis, out)}`);
    other.total = gathered.n;
    added.set('*', { s: gathered.s, u: gathered.u });
  }
  const totals = await once(scope);
  return {
    values: out.map((v) => ({
      ...v,
      seconds: added.get(keyOf(v.id))?.s ?? 0,
      unestimated: added.get(keyOf(v.id))?.u ?? 0,
    })),
    total: totals.n,
    seconds: totals.s,
    unestimated: totals.u,
  };
}

export interface TimeRow extends ListedTicket {
  original: number | null;
  remaining: number | null;
  spent: number;
}

export interface TimeTracking {
  tickets: number;
  /** Tickets with an original estimate. */
  estimated: number;
  original: number;
  remaining: number;
  /** Time spent: the sum of the time entries of the tickets, kept on each ticket (M1-019). */
  spent: number;
  /** The first `limit` tickets with time on them, most time spent first. */
  rows: TimeRow[];
}

/**
 * - **Time tracking** (RPT-002 (2)): over the matching tickets, the original and remaining
 *   estimates and the time spent added up, with the tickets that have any of them, most time
 *   spent first. Time spent is each ticket's sum of time entries, so the total is theirs.
 */
export async function timeTracking(
  db: Db,
  input: { scope: RawBuilder<boolean>; limit: number },
): Promise<TimeTracking> {
  const { scope } = input;
  const totals = (
    await sql<{ n: number; e: number; o: number; r: number; s: number }>`
      SELECT count(*)::int AS n, count(k.original_estimate)::int AS e,
             coalesce(sum(k.original_estimate), 0)::float8 AS o,
             coalesce(sum(k.remaining_estimate), 0)::float8 AS r,
             coalesce(sum(k.time_spent), 0)::float8 AS s
        FROM ticket k WHERE ${scope}`.execute(db)
  ).rows[0] ?? { n: 0, e: 0, o: 0, r: 0, s: 0 };
  const rows = (
    await sql<TimeRow>`
      SELECT k.id, t.key || '-' || k.number AS key, k.summary, s.name AS status,
             s.stage = 'closed' AS closed, u.name AS assignee,
             k.original_estimate AS original, k.remaining_estimate AS remaining,
             k.time_spent AS spent
        FROM ticket k
        JOIN track t ON t.id = k.track_id
        JOIN status s ON s.id = k.status_id
        LEFT JOIN app_user u ON u.id = k.assignee_id
       WHERE ${scope} AND (k.original_estimate IS NOT NULL OR k.remaining_estimate IS NOT NULL
                           OR k.time_spent > 0)
       ORDER BY k.time_spent DESC, k.original_estimate DESC NULLS LAST, k.id
       LIMIT ${input.limit}::int`.execute(db)
  ).rows;
  return {
    tickets: totals.n,
    estimated: totals.e,
    original: totals.o,
    remaining: totals.r,
    spent: totals.s,
    rows,
  };
}
