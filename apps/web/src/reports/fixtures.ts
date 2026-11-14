import type { Board } from '../boards/client';
import { BOARD } from '../boards/fixtures';
import { SHOP_OUTCOMES } from '../tracks/fixtures';
import type {
  CumulativeFlow,
  CycleParams,
  CyclePointView,
  CycleTime,
  OutcomeReport,
  ReleaseReport,
  ReportClient,
  ReportParams,
  ScopeBurndown,
  TimeInStatus,
} from './client';

/**
 * Flow reports of a five-column Kanban board for stories and tests (M1-061): four weeks to
 * 29 October 2026, made up by formula, consistent with themselves (the averages, statistics
 * and bins are computed from the points as the server would).
 */
const HOUR = 3600;
const DAY_MS = 86_400_000;
const STATUS = { New: 1, Active: 2, 'In Review': 3, Closed: 4, Blocked: 5, Parked: 9 } as const;

export const REPORT_BOARD: Board = {
  ...BOARD,
  columns: [
    { id: 'todo', name: 'To do', statusIds: [STATUS.New], min: null, max: null },
    { id: 'doing', name: 'Doing', statusIds: [STATUS.Active], min: null, max: 4 },
    { id: 'blocked', name: 'Blocked', statusIds: [STATUS.Blocked], min: null, max: null },
    { id: 'review', name: 'Review', statusIds: [STATUS['In Review']], min: null, max: null },
    { id: 'done', name: 'Done', statusIds: [STATUS.Closed], min: null, max: null },
  ],
};

const FROM = '2026-10-02';
const TO = '2026-10-29';
const DATES = Array.from({ length: 28 }, (_, i) =>
  new Date(Date.parse(`${FROM}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10),
);
const WINDOW = { timeZone: 'UTC', from: FROM, to: TO };

export function flowFixture(): CumulativeFlow {
  const series = (f: (i: number) => number) => DATES.map((_, i) => f(i));
  return {
    ...WINDOW,
    dates: DATES,
    columns: [
      { id: 'todo', name: 'To do', counts: series((i) => 9 - (i % 6) + Math.floor(i / 7)) },
      { id: 'doing', name: 'Doing', counts: series((i) => 4 + (i % 4 === 0 ? 1 : 0)) },
      { id: 'blocked', name: 'Blocked', counts: series((i) => (i % 5 === 0 ? 2 : 1)) },
      { id: 'review', name: 'Review', counts: series((i) => 2 + (i % 3)) },
      { id: 'done', name: 'Done', counts: series((i) => 4 + Math.round(i * 1.6)) },
    ],
    unmapped: series((i) => (i > 20 ? 1 : 0)),
  };
}

export const SUMMARIES = [
  'Accept card payments',
  'Refund a payment',
  'Show the order total',
  'Send the receipt',
  'Save the address',
];

function points(): Omit<CyclePointView, 'average' | 'deviation'>[] {
  return Array.from({ length: 36 }, (_, k) => ({
    ticket: {
      id: 100 + k,
      key: `SHOP-${100 + k}`,
      summary: SUMMARIES[k % SUMMARIES.length] as string,
    },
    at: new Date(Date.parse(`${FROM}T09:00:00Z`) + k * 0.75 * DAY_MS).toISOString(),
    cycle: (20 + ((k * 37) % 60) + (k % 9 === 0 ? 50 : 0)) * HOUR,
  }));
}

export function cycleFixture(params: CycleParams = {}): CycleTime {
  const raw = points();
  const method = params.average ?? 'tickets';
  const size = params.window ?? 7;
  const window = (i: number) => {
    if (method === 'tickets') {
      const lo = Math.max(0, Math.min(i - Math.floor((size - 1) / 2), raw.length - size));
      return raw.slice(lo, lo + size);
    }
    const at = Date.parse(raw[i]?.at ?? '');
    return raw.filter((p) => Math.abs(Date.parse(p.at) - at) <= (size * DAY_MS) / 2);
  };
  const withAverages = raw.map((p, i) => {
    const w = window(i).map((q) => q.cycle);
    const mean = w.reduce((s, v) => s + v, 0) / w.length;
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / w.length);
    return { ...p, average: Math.round(mean), deviation: Math.round(sd) };
  });
  const sorted = raw.map((p) => p.cycle).sort((a, b) => a - b);
  const rank = (q: number) => sorted[Math.max(0, Math.ceil((q / 100) * sorted.length) - 1)] ?? 0;
  const average = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const width = 8 * HOUR;
  const counts = new Array<number>(Math.floor((sorted.at(-1) ?? 0) / width) + 1).fill(0);
  for (const v of sorted) {
    const bin = Math.floor(v / width);
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  const chosen = params.columns ?? ['doing', 'blocked', 'review'];
  return {
    ...WINDOW,
    start: `${FROM}T00:00:00.000Z`,
    end: '2026-10-30T00:00:00.000Z',
    columns: REPORT_BOARD.columns.map((c) => ({
      id: c.id,
      name: c.name,
      chosen: chosen.includes(c.id),
    })),
    averaging: { method, size },
    statistics: {
      count: sorted.length,
      average: Math.round(average),
      median: rank(50),
      p85: rank(85),
      p95: rank(95),
      min: sorted[0] ?? 0,
      max: sorted.at(-1) ?? 0,
      deviation: Math.round(
        Math.sqrt(sorted.reduce((s, v) => s + (v - average) ** 2, 0) / sorted.length),
      ),
    },
    histogram: { width, counts },
    total: withAverages.length,
    points: withAverages,
  };
}

export function timeInStatusFixture(): TimeInStatus {
  const row = (
    name: keyof typeof STATUS,
    columnId: string | null,
    tickets: number,
    hours: number,
    entries: number,
  ) => ({
    status: { id: STATUS[name], name },
    columnId,
    tickets,
    total: hours * HOUR * tickets,
    average: hours * HOUR,
    entries,
  });
  return {
    ...WINDOW,
    statuses: [
      row('New', 'todo', 31, 70, 22),
      row('Active', 'doing', 27, 30, 34),
      row('Blocked', 'blocked', 6, 19, 7),
      row('In Review', 'review', 22, 11, 25),
      row('Closed', 'done', 48, 260, 40),
      row('Parked', null, 2, 90, 1),
    ],
  };
}

/** The same board as a Scrum board estimating in story points (M1-062). */
export const SCRUM_REPORT_BOARD: Board = {
  ...REPORT_BOARD,
  kind: 'scrum',
  sprintSettings: {
    ...REPORT_BOARD.sprintSettings,
    estimation: { statistic: 'field', fieldId: 31 },
    timeTracking: 'none',
  },
};

export const RELEASES: { id: number; name: string }[] = [
  { id: 31, name: 'Checkout 2.0' },
  { id: 32, name: 'Checkout 2.1' },
];

/** An outcome the fake reports know: SHOP-7, or one of the track fixture's outcomes. */
function knownOutcome(key: string): { id: number; key: string; summary: string } {
  if (key === 'SHOP-7') return { id: 77, key: 'SHOP-7', summary: 'One-page checkout' };
  const found = SHOP_OUTCOMES.find((o) => o.key === key);
  if (!found) throw new Error('not_found');
  return { id: found.id, key: found.key, summary: found.summary };
}

/** Three sprints of a release in points: two completed, one running. */
export function scopeFixture(): ScopeBurndown {
  const sprint = (
    n: number,
    state: 'active' | 'closed',
    work: [number, number, number, number, number],
  ) => ({
    sprintId: n,
    name: `Checkout Sprint ${n}`,
    state,
    startedAt: `2026-10-${String(n * 2 - 8).padStart(2, '0')}T09:00:00Z`,
    completedAt:
      state === 'closed' ? `2026-10-${String(n * 2 - 7 + 4).padStart(2, '0')}T17:00:00Z` : null,
    start: work[0],
    completed: work[1],
    added: work[2],
    removed: work[3],
    end: work[4],
  });
  return {
    statistic: { statistic: 'field', fieldId: 31 },
    sprints: [
      sprint(8, 'closed', [40, 12, 5, 0, 33]),
      sprint(9, 'closed', [33, 10, 8, 3, 28]),
      sprint(10, 'active', [30, 6, 0, 0, 24]),
    ],
    // 52 joined and 12 were done before sprint 8, 2 joined between 9 and 10.
    outside: { completed: 12, added: 54, removed: 0 },
    now: { scope: 64, completed: 40, remaining: 24 },
    velocity: 11,
    forecast: 3,
  };
}

export function releaseReportFixture(): ReleaseReport {
  const days = Array.from({ length: 22 }, (_, i) => ({
    date: new Date(Date.parse('2026-10-08T00:00:00Z') + i * DAY_MS).toISOString().slice(0, 10),
    scope: 40 + Math.min(24, Math.floor(i * 1.3)),
    completed: Math.round(i * 1.85),
  }));
  return {
    release: {
      id: 31,
      name: 'Checkout 2.0',
      startDate: '2026-10-08',
      releaseDate: '2026-11-30',
      shippedAt: null,
    },
    statistic: { statistic: 'field', fieldId: 31 },
    timeZone: 'UTC',
    days,
    pace: 1.86,
    forecast: '2026-11-11',
  };
}

export function outcomeReportFixture(): OutcomeReport {
  const days = Array.from({ length: 15 }, (_, i) => ({
    date: new Date(Date.parse('2026-10-15T00:00:00Z') + i * DAY_MS).toISOString().slice(0, 10),
    scope: 13 + Math.min(8, i),
    completed: Math.round(i * 0.9),
  }));
  const ticket = (n: number, summary: string, done: boolean, value: number, estimated = true) => ({
    id: 70 + n,
    key: `SHOP-${70 + n}`,
    summary,
    status: done ? 'Closed' : 'Active',
    done,
    value,
    estimated,
  });
  return {
    outcome: { id: 77, key: 'SHOP-7', summary: 'One-page checkout' },
    statistic: { statistic: 'field', fieldId: 31 },
    timeZone: 'UTC',
    days,
    pace: 0.9,
    forecast: '2026-11-12',
    tickets: [
      ticket(1, 'Address form on one page', false, 5),
      ticket(2, 'Remember the card', false, 0, false),
      ticket(3, 'Pay with one click', true, 8),
      ticket(4, 'Show the total early', true, 5),
    ],
    counts: { done: 2, open: 2, unestimated: 1 },
  };
}

export interface FakeReportClient extends ReportClient {
  calls: { report: string; params: CycleParams | { release: number } | { outcome: string } }[];
}

export function fakeReportClient(board: Board = REPORT_BOARD): FakeReportClient {
  const calls: FakeReportClient['calls'] = [];
  const record = (report: string, params: ReportParams | CycleParams) =>
    calls.push({ report, params: { ...params } });
  return {
    calls,
    board: async () => board,
    cumulativeFlow: async (_board, params) => {
      record('cumulative-flow', params);
      return flowFixture();
    },
    cycleTime: async (_board, params) => {
      record('cycle-time', params);
      return cycleFixture(params);
    },
    timeInStatus: async (_board, params) => {
      record('time-in-status', params);
      return timeInStatusFixture();
    },
    releases: async () => RELEASES,
    releaseBurndown: async (_board, releaseId) => {
      calls.push({ report: 'release-burndown', params: { release: releaseId } });
      const release = RELEASES.find((r) => r.id === releaseId);
      return { ...scopeFixture(), ...(release ? { release } : {}) };
    },
    outcomeBurndown: async (_board, outcome) => {
      calls.push({ report: 'outcome-burndown', params: { outcome } });
      return { ...scopeFixture(), outcome: knownOutcome(outcome) };
    },
    releaseReport: async () => releaseReportFixture(),
    outcomeReport: async (_board, outcome) => {
      calls.push({ report: 'outcome-report', params: { outcome } });
      return { ...outcomeReportFixture(), outcome: knownOutcome(outcome) };
    },
  };
}
