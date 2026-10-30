import { describe, expect, it } from 'vitest';
import {
  cumulativeFlow,
  cyclePoints,
  cycleStatistics,
  datesBetween,
  dayEnd,
  dayStart,
  type FlowColumn,
  type FlowTicket,
  histogram,
  rolling,
  timeInStatus,
} from './flow';

/**
 * Flow reports from a hand-built week (M1-061; RPT-001 (3)): every number below was worked out
 * by hand from the status changes. Monday 5 to Friday 9 October 2026, UTC unless named.
 */
const TODO = 1;
const ACTIVE = 2;
const REVIEW = 3;
const DONE = 4;
const BLOCKED = 5;
/** No column maps it. */
const PARKED = 9;
const H = 3_600_000;

const COLUMNS: FlowColumn[] = [
  { id: 'todo', name: 'To do', statusIds: [TODO] },
  { id: 'active', name: 'In progress', statusIds: [ACTIVE] },
  { id: 'blocked', name: 'Blocked', statusIds: [BLOCKED] },
  { id: 'review', name: 'Review', statusIds: [REVIEW] },
  { id: 'done', name: 'Done', statusIds: [DONE] },
];

const ticket = (id: number, ...changes: [string, number][]): FlowTicket => ({
  id,
  changes: changes.map(([iso, statusId]) => ({ at: Date.parse(`${iso}:00Z`), statusId })),
});

const WEEK: FlowTicket[] = [
  // In progress 24 h, review 12 h: 36 h, done Tuesday 21:00.
  ticket(
    1,
    ['2026-10-01T10:00', TODO],
    ['2026-10-05T09:00', ACTIVE],
    ['2026-10-06T09:00', REVIEW],
    ['2026-10-06T21:00', DONE],
  ),
  // In progress 24 h, blocked 24 h (left out), in progress 12 h: 36 h, done at midnight.
  ticket(
    2,
    ['2026-10-02T10:00', TODO],
    ['2026-10-05T12:00', ACTIVE],
    ['2026-10-06T12:00', BLOCKED],
    ['2026-10-07T12:00', ACTIVE],
    ['2026-10-08T00:00', DONE],
  ),
  // Done after 6 h, reopened for 24 h: 30 h at its last finish, Wednesday 10:00.
  ticket(
    3,
    ['2026-10-05T08:00', TODO],
    ['2026-10-05T10:00', ACTIVE],
    ['2026-10-05T16:00', DONE],
    ['2026-10-06T10:00', ACTIVE],
    ['2026-10-07T10:00', DONE],
  ),
  // Still in progress: no point.
  ticket(4, ['2026-10-01T10:00', TODO], ['2026-10-03T10:00', ACTIVE]),
  // Straight from to do to done: never in a chosen column, no point.
  ticket(5, ['2026-10-06T09:00', TODO], ['2026-10-06T15:00', DONE]),
  // Parked (unmapped), then review 24 h: 24 h, done Thursday 10:00.
  ticket(6, ['2026-10-04T10:00', PARKED], ['2026-10-07T10:00', REVIEW], ['2026-10-08T10:00', DONE]),
  // Done before the window: no point.
  ticket(7, ['2026-09-28T10:00', TODO], ['2026-09-29T00:00', ACTIVE], ['2026-09-30T00:00', DONE]),
  ticket(8, ['2026-10-07T12:00', TODO]),
];

const DATES = datesBetween('2026-10-05', '2026-10-09');
const FROM = dayStart('2026-10-05', 'UTC');
const TO = dayEnd('2026-10-09', 'UTC');
const NOW = Date.parse('2026-10-12T09:00:00Z');
const counts = (flow: ReturnType<typeof cumulativeFlow>) =>
  Object.fromEntries(flow.columns.map((c) => [c.id, c.counts]));

describe('flow reports (M1-061)', () => {
  it('[RPT-001] counts the tickets in each column at the end of each day', () => {
    const flow = cumulativeFlow({
      columns: COLUMNS,
      tickets: WEEK,
      dates: DATES,
      timeZone: 'UTC',
      now: NOW,
    });
    expect(flow.dates).toEqual(DATES);
    expect(counts(flow)).toEqual({
      todo: [0, 0, 1, 1, 1],
      active: [3, 2, 2, 1, 1],
      blocked: [0, 1, 0, 0, 0],
      review: [0, 0, 1, 0, 0],
      // Ticket 2's move at midnight belongs to Thursday.
      done: [2, 3, 4, 6, 6],
    });
    expect(flow.unmapped).toEqual([1, 1, 0, 0, 0]);
  });

  it('[RPT-001] ends the days on the viewer’s clock', () => {
    // Tuesday ends at 15:00 UTC in Tokyo: ticket 5's move at that instant is Wednesday's.
    const flow = cumulativeFlow({
      columns: COLUMNS,
      tickets: WEEK,
      dates: ['2026-10-06'],
      timeZone: 'Asia/Tokyo',
      now: NOW,
    });
    expect(counts(flow)).toEqual({
      todo: [1],
      active: [2],
      blocked: [1],
      review: [1],
      done: [1],
    });
    expect(flow.unmapped).toEqual([1]);
  });

  it('[RPT-001] counts only the time in the chosen columns, at each ticket’s last finish', () => {
    const points = cyclePoints({
      columns: COLUMNS,
      chosen: ['active', 'review'],
      tickets: WEEK,
      from: FROM,
      to: TO,
    });
    expect(points.map((p) => [p.ticketId, new Date(p.at).toISOString(), p.cycle / H])).toEqual([
      [1, '2026-10-06T21:00:00.000Z', 36],
      [3, '2026-10-07T10:00:00.000Z', 30],
      [2, '2026-10-08T00:00:00.000Z', 36],
      [6, '2026-10-08T10:00:00.000Z', 24],
    ]);
    // Choosing the blocked column too counts its 24 h.
    const withBlocked = cyclePoints({
      columns: COLUMNS,
      chosen: ['active', 'blocked', 'review'],
      tickets: WEEK,
      from: FROM,
      to: TO,
    });
    expect(withBlocked.find((p) => p.ticketId === 2)?.cycle).toBe(60 * H);
    // A window that ends before the reopened ticket's last finish keeps its first.
    const early = cyclePoints({
      columns: COLUMNS,
      chosen: ['active', 'review'],
      tickets: WEEK,
      from: FROM,
      to: Date.parse('2026-10-06T00:00:00Z'),
    });
    expect(early.map((p) => [p.ticketId, p.cycle / H])).toEqual([[3, 6]]);
  });

  it('[RPT-001] averages over neighbouring tickets or over days, with the spread', () => {
    const points = cyclePoints({
      columns: COLUMNS,
      chosen: ['active', 'review'],
      tickets: WEEK,
      from: FROM,
      to: TO,
    });
    const hours = (r: { average: number }[]) => r.map((v) => v.average / H);
    // Three tickets: 36, 30, 36 | 36, 30, 36 | 30, 36, 24 | 30, 36, 24.
    expect(hours(rolling(points, { method: 'tickets', size: 3 }))).toEqual([34, 34, 30, 30]);
    // A day either side of each point.
    expect(hours(rolling(points, { method: 'days', size: 2 }))).toEqual([33, 31.5, 30, 30]);
    const one = rolling(points, { method: 'tickets', size: 4 })[0];
    expect(one?.average).toBe(31.5 * H);
    expect(one?.deviation).toBeCloseTo(Math.sqrt(24.75) * H, 3);

    const stats = cycleStatistics(points);
    expect({
      count: stats.count,
      average: stats.average / H,
      median: stats.median / H,
      p85: stats.p85 / H,
      p95: stats.p95 / H,
      min: stats.min / H,
      max: stats.max / H,
    }).toEqual({ count: 4, average: 31.5, median: 30, p85: 36, p95: 36, min: 24, max: 36 });
    expect(stats.deviation).toBeCloseTo(Math.sqrt(24.75) * H, 3);

    // 36 h needs 2 h bins to stay within 20.
    const bins = histogram(points);
    expect(bins.width).toBe(2 * H);
    expect(bins.counts).toHaveLength(19);
    expect(bins.counts.flatMap((n, i) => (n > 0 ? [[i * 2, n]] : []))).toEqual([
      [24, 1],
      [30, 1],
      [36, 2],
    ]);
  });

  it('[RPT-001] adds up the time in each status inside the window', () => {
    const rows = timeInStatus({ tickets: WEEK, from: FROM, to: TO });
    expect(rows.map((r) => [r.statusId, r.total / H, r.tickets, r.entries])).toEqual([
      [TODO, 89, 5, 3],
      [ACTIVE, 210, 4, 5],
      [REVIEW, 36, 2, 2],
      [DONE, 442, 6, 6],
      [BLOCKED, 24, 1, 1],
      [PARKED, 58, 1, 0],
    ]);
  });
});
