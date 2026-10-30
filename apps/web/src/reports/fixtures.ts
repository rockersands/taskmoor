import type { Board } from '../boards/client';
import { BOARD } from '../boards/fixtures';
import type {
  CumulativeFlow,
  CycleParams,
  CyclePointView,
  CycleTime,
  ReportClient,
  ReportParams,
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

export interface FakeReportClient extends ReportClient {
  calls: { report: string; params: CycleParams }[];
}

export function fakeReportClient(): FakeReportClient {
  const calls: { report: string; params: CycleParams }[] = [];
  const record = (report: string, params: ReportParams | CycleParams) =>
    calls.push({ report, params: { ...params } });
  return {
    calls,
    board: async () => REPORT_BOARD,
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
  };
}
