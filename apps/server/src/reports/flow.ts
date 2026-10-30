import { instantOf } from '@taskmoor/query';

/**
 * Flow reports of any board (M1-061; RPT-001; ADR-058), computed from each ticket's status
 * changes (M1-059's report events, status only) and the board's columns, nothing else, so a
 * report over past days replays identically.
 *
 * - **Cumulative flow**: at the end of each local day, how many of the board's tickets are in
 *   each column. A status no column maps counts as unmapped; a ticket not yet created counts
 *   nowhere.
 * - **Cycle time** (control chart and cycle time report): the columns chosen are the work; the
 *   others are left out of the time. A ticket finishes when it moves from a column at or left
 *   of the rightmost chosen one to a column right of it; its cycle time is all the time it
 *   spent in the chosen columns up to then. Each ticket shows once, at its last finish in the
 *   window. A ticket that never entered a chosen column has no cycle time.
 * - **Rolling average**, two methods, both centred so the line does not lag the points: over a
 *   number of neighbouring tickets, or over the tickets finished within a number of days
 *   around each point. The standard deviation over the same window gives the band.
 * - **Time in status**: per status, the time the board's tickets spent in it inside the
 *   window (clipped to it), how many tickets were in it and how often they entered it.
 */
export interface FlowColumn {
  id: string;
  name: string;
  statusIds: readonly number[];
}

/** One status change: the ticket has `statusId` from `at` (milliseconds) on. */
export interface StatusChange {
  at: number;
  statusId: number | null;
}

/** A ticket and its status changes in time order, creation first. */
export interface FlowTicket {
  id: number;
  changes: readonly StatusChange[];
}

const DAY = 86_400_000;

/** The column index of each mapped status. */
function columnIndex(columns: readonly FlowColumn[]): Map<number, number> {
  const out = new Map<number, number>();
  columns.forEach((c, i) => {
    for (const s of c.statusIds) if (!out.has(s)) out.set(s, i);
  });
  return out;
}

/** The instant a local day ends: the next day's midnight on the zone's clock. */
export function dayEnd(date: string, timeZone: string): number {
  const [year, month, day] = nextDay(date).split('-').map(Number) as [number, number, number];
  return instantOf({ year, month, day, hour: 0, minute: 0, second: 0, ms: 0 }, timeZone).getTime();
}

/** The instant a local day starts. */
export function dayStart(date: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return instantOf({ year, month, day, hour: 0, minute: 0, second: 0, ms: 0 }, timeZone).getTime();
}

export function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
}

/** Every local date from `from` to `to`, both included. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = nextDay(d)) out.push(d);
  return out;
}

/** The first index whose value is past `v` in an ascending list (its length if none). */
function firstAfter(sorted: readonly number[], v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface CumulativeFlow {
  dates: string[];
  /** Per column in board order, the tickets in it at the end of each day. */
  columns: { id: string; name: string; counts: number[] }[];
  /** Tickets in a status no column maps, per day. */
  unmapped: number[];
}

/**
 * Tickets per column at the end of each date (today: now). Each change adds one to its new
 * column and takes one from the old from the first day that ends after it (a change at
 * midnight belongs to the day it starts); prefix sums give the days, so the cost is the number
 * of changes, not tickets times days.
 */
export function cumulativeFlow(input: {
  columns: readonly FlowColumn[];
  tickets: readonly FlowTicket[];
  dates: readonly string[];
  timeZone: string;
  now: number;
}): CumulativeFlow {
  const { columns, dates } = input;
  const index = columnIndex(columns);
  const unmapped = columns.length;
  const ends = dates.map((d) => Math.min(dayEnd(d, input.timeZone), input.now));
  // Per column (and unmapped last), the change of count on each day.
  const delta = Array.from({ length: columns.length + 1 }, () => new Int32Array(dates.length));
  for (const t of input.tickets) {
    let was = -1;
    for (const c of t.changes) {
      const day = firstAfter(ends, c.at);
      if (day >= dates.length) break;
      const now = c.statusId === null ? -1 : (index.get(c.statusId) ?? unmapped);
      if (now === was) continue;
      const leaving = delta[was];
      const entering = delta[now];
      if (leaving) leaving[day] = (leaving[day] as number) - 1;
      if (entering) entering[day] = (entering[day] as number) + 1;
      was = now;
    }
  }
  const run = (d: Int32Array) => {
    const out: number[] = [];
    let n = 0;
    for (const v of d) {
      n += v;
      out.push(n);
    }
    return out;
  };
  return {
    dates: [...dates],
    columns: columns.map((c, i) => ({
      id: c.id,
      name: c.name,
      counts: run(delta[i] as Int32Array),
    })),
    unmapped: run(delta[unmapped] as Int32Array),
  };
}

export interface CyclePoint {
  ticketId: number;
  /** When the ticket moved past the chosen columns, in milliseconds. */
  at: number;
  /** Time spent in the chosen columns up to then, in milliseconds. */
  cycle: number;
}

/** One point per ticket that finished inside [from, to], in finish order. */
export function cyclePoints(input: {
  columns: readonly FlowColumn[];
  /** The chosen columns' ids; at least one. */
  chosen: readonly string[];
  tickets: readonly FlowTicket[];
  from: number;
  to: number;
}): CyclePoint[] {
  const index = columnIndex(input.columns);
  const chosen = new Set<number>();
  input.columns.forEach((c, i) => {
    if (input.chosen.includes(c.id)) chosen.add(i);
  });
  const last = Math.max(-1, ...chosen);
  const points: CyclePoint[] = [];
  for (const t of input.tickets) {
    let col = -1;
    let since = 0;
    let spent = 0;
    let entered = false;
    let point: CyclePoint | null = null;
    for (const c of t.changes) {
      if (c.at > input.to) break;
      const next = c.statusId === null ? -1 : (index.get(c.statusId) ?? -1);
      if (next === col) continue;
      if (chosen.has(col)) spent += c.at - since;
      // Moving past the chosen columns from at or left of the last of them.
      if (col >= 0 && col <= last && next > last && entered && c.at >= input.from) {
        point = { ticketId: t.id, at: c.at, cycle: spent };
      }
      if (chosen.has(next)) entered = true;
      col = next;
      since = c.at;
    }
    if (point) points.push(point);
  }
  return points.sort((a, b) => a.at - b.at || a.ticketId - b.ticketId);
}

export type Averaging = { method: 'tickets'; size: number } | { method: 'days'; size: number };

/** A ticket window of about a fifth of the points, at least 1. */
export function defaultTicketWindow(points: number): number {
  return Math.max(1, Math.round(points / 5));
}

/**
 * The rolling average and standard deviation at each point, over a centred window: `size`
 * neighbouring tickets (the point in the middle), or the tickets finished within `size` days
 * around the point (half before, half after). Prefix sums keep it linear.
 */
export function rolling(
  points: readonly CyclePoint[],
  averaging: Averaging,
): { average: number; deviation: number }[] {
  const n = points.length;
  const sum = new Float64Array(n + 1);
  const squares = new Float64Array(n + 1);
  points.forEach((p, i) => {
    sum[i + 1] = (sum[i] as number) + p.cycle;
    squares[i + 1] = (squares[i] as number) + p.cycle * p.cycle;
  });
  const window = (lo: number, hi: number) => {
    // Points lo to hi - 1.
    const k = hi - lo;
    const mean = ((sum[hi] as number) - (sum[lo] as number)) / k;
    const variance = Math.max(
      0,
      ((squares[hi] as number) - (squares[lo] as number)) / k - mean * mean,
    );
    return { average: mean, deviation: Math.sqrt(variance) };
  };
  if (averaging.method === 'tickets') {
    const size = Math.max(1, Math.min(n, Math.floor(averaging.size)));
    const before = Math.floor((size - 1) / 2);
    return points.map((_, i) => {
      const lo = Math.max(0, Math.min(i - before, n - size));
      return window(lo, lo + size);
    });
  }
  const half = (averaging.size * DAY) / 2;
  const out: { average: number; deviation: number }[] = [];
  let lo = 0;
  let hi = 0;
  for (const p of points) {
    while ((points[lo] as CyclePoint).at < p.at - half) lo++;
    while (hi < n && (points[hi] as CyclePoint).at <= p.at + half) hi++;
    out.push(window(lo, hi));
  }
  return out;
}

export interface CycleStatistics {
  count: number;
  average: number;
  median: number;
  p85: number;
  p95: number;
  min: number;
  max: number;
  deviation: number;
}

/** The nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

export function cycleStatistics(points: readonly CyclePoint[]): CycleStatistics {
  const sorted = points.map((p) => p.cycle).sort((a, b) => a - b);
  const n = sorted.length;
  const average = n === 0 ? 0 : sorted.reduce((s, v) => s + v, 0) / n;
  const variance = n === 0 ? 0 : sorted.reduce((s, v) => s + (v - average) ** 2, 0) / n;
  return {
    count: n,
    average,
    median: percentile(sorted, 50),
    p85: percentile(sorted, 85),
    p95: percentile(sorted, 95),
    min: sorted[0] ?? 0,
    max: sorted[n - 1] ?? 0,
    deviation: Math.sqrt(variance),
  };
}

const HOUR = 3_600_000;
const WIDTHS = [1, 2, 4, 8, 12, 24, 48, 72, 168, 336, 720].map((h) => h * HOUR);

/** Cycle times in bins from zero, the narrowest of a fixed set that needs at most 20 bins. */
export function histogram(points: readonly CyclePoint[]): { width: number; counts: number[] } {
  const max = Math.max(0, ...points.map((p) => p.cycle));
  const width =
    WIDTHS.find((w) => Math.floor(max / w) + 1 <= 20) ??
    Math.ceil(max / 20 / (720 * HOUR)) * 720 * HOUR;
  const counts = new Array<number>(points.length === 0 ? 0 : Math.floor(max / width) + 1).fill(0);
  for (const p of points) {
    const bin = Math.floor(p.cycle / width);
    counts[bin] = (counts[bin] as number) + 1;
  }
  return { width, counts };
}

export interface StatusTime {
  statusId: number;
  /** Tickets that spent time in the status inside the window, or entered it there. */
  tickets: number;
  /** Time spent in it inside the window, in milliseconds. */
  total: number;
  /** Times a ticket entered it inside the window. */
  entries: number;
}

/** Time in each status inside [from, to], per status, in status id order. */
export function timeInStatus(input: {
  tickets: readonly FlowTicket[];
  from: number;
  to: number;
}): StatusTime[] {
  const { from, to } = input;
  const by = new Map<number, StatusTime>();
  const row = (statusId: number) => {
    let r = by.get(statusId);
    if (!r) {
      r = { statusId, tickets: 0, total: 0, entries: 0 };
      by.set(statusId, r);
    }
    return r;
  };
  for (const t of input.tickets) {
    const seen = new Set<number>();
    const changes = t.changes;
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i] as StatusChange;
      if (c.at > to) break;
      if (c.statusId === null) continue;
      const prev = i > 0 ? (changes[i - 1] as StatusChange).statusId : null;
      if (prev === c.statusId) continue;
      // Until the next change to another status.
      let j = i + 1;
      while (j < changes.length && (changes[j] as StatusChange).statusId === c.statusId) j++;
      const end = Math.min(to, j < changes.length ? (changes[j] as StatusChange).at : to);
      const overlap = Math.max(0, end - Math.max(from, c.at));
      const entered = c.at >= from;
      if (overlap === 0 && !entered) continue;
      const r = row(c.statusId);
      r.total += overlap;
      if (entered) r.entries += 1;
      if (!seen.has(c.statusId)) {
        seen.add(c.statusId);
        r.tickets += 1;
      }
    }
  }
  return [...by.values()].sort((a, b) => a.statusId - b.statusId);
}
