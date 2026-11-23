import type {
  BaselineClient,
  BaselineComparison,
  BaselineCounts,
  BaselineDays,
  BaselineList,
  BaselineRow,
  BaselineShow,
  BaselineTicket,
  CaptureOutcome,
} from './baselineClient';
import type { Outcome } from './scenarioClient';

/**
 * Baselines of the fake plan "Spring launch" in memory, for stories and tests (ADR-122 stage 9).
 * "Kick-off" was captured from Live on 1 November. Against the days now: SHOP-1 ends 9 days later,
 * SHOP-2 14 days later, SHOP-3 the same, OPS-4 3 days earlier, OPS-5 (closed) 3 days later;
 * WEB-6 was added since and WEB-7 had no days then. The plan's end moves from 1 December to the
 * 4th. A new capture copies the same days.
 */
export interface FakeBaselineOptions {
  editable?: boolean;
  /** Baselines to start with, newest first; "Kick-off" alone by default. */
  baselines?: Partial<BaselineRow>[];
  /** Rows of each baseline on tickets hidden from the reader. */
  notShown?: number;
  /** Tickets a page holds (200 on the server). */
  page?: number;
  /** Fail reading the list, as a dropped connection would. */
  failList?: boolean;
  /** Fail every comparison, as a dropped connection would. */
  failCompare?: boolean;
  /** Refuse every capture so. */
  refuseCapture?: { code: string; limit?: number };
}

const PERSON = { id: 7, name: 'Ana Ruiz' };
const own = (start: string | null, due: string | null): BaselineDays => ({
  start,
  due,
  dated: start === null && due === null ? null : 'own',
});
const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
/** A side's end: its due day, else its start day (the fake's days never end before they start). */
const endOf = (d: BaselineDays | null) => d?.due ?? d?.start ?? null;

/** The fake plan's tickets: their days in "Kick-off" and now. */
const TICKETS: {
  id: number;
  key: string;
  summary: string;
  closed?: boolean;
  was: BaselineDays | null;
  now: BaselineDays;
}[] = [
  {
    id: 1,
    key: 'SHOP-1',
    summary: 'Checkout page',
    was: own('2026-11-02', '2026-11-12'),
    now: own('2026-11-02', '2026-11-21'),
  },
  {
    id: 2,
    key: 'SHOP-2',
    summary: 'Payment form',
    was: own('2026-11-09', '2026-11-20'),
    now: own('2026-11-16', '2026-12-04'),
  },
  {
    id: 3,
    key: 'SHOP-3',
    summary: 'Receipts by email',
    was: own(null, '2026-11-25'),
    now: own(null, '2026-11-25'),
  },
  {
    id: 4,
    key: 'OPS-4',
    summary: 'Monitoring',
    was: own(null, '2026-12-01'),
    now: own(null, '2026-11-28'),
  },
  {
    id: 5,
    key: 'OPS-5',
    summary: 'Runbook',
    closed: true,
    was: own(null, '2026-11-10'),
    now: own(null, '2026-11-13'),
  },
  { id: 6, key: 'WEB-6', summary: 'Landing copy', was: null, now: own(null, '2026-12-10') },
  {
    id: 7,
    key: 'WEB-7',
    summary: 'Analytics',
    was: own(null, null),
    now: own(null, '2026-12-02'),
  },
];

function compared(): BaselineTicket[] {
  return TICKETS.map((x) => {
    const was = endOf(x.was);
    const now = endOf(x.now);
    const start = (d: BaselineDays | null) => d?.start ?? d?.due ?? null;
    const ws = start(x.was);
    const ns = start(x.now);
    return {
      id: x.id,
      key: x.key,
      summary: x.summary,
      level: { rank: 0, kind: 'standard' },
      closed: x.closed ?? false,
      was: x.was,
      now: x.now,
      delay: was && now ? dayNumber(now) - dayNumber(was) : null,
      startShift: ws && ns ? dayNumber(ns) - dayNumber(ws) : null,
    };
  });
}

const SHOWN: Record<BaselineShow, (t: BaselineTicket) => boolean> = {
  slipped: (t) => (t.delay ?? 0) > 0,
  earlier: (t) => (t.delay ?? 0) < 0,
  added: (t) => t.was === null,
  all: () => true,
};

export function fakeBaselineClient(options: FakeBaselineOptions = {}): BaselineClient & {
  /** What each comparison was asked, in order. */
  asked: { bid: number; show?: BaselineShow; after?: string; scenario?: number }[];
} {
  let nextId = 10;
  let rows: BaselineRow[] = (options.baselines ?? [{}]).map((b, i) => ({
    id: i + 1,
    name: 'Kick-off',
    source: 'live',
    scenarioName: null,
    tickets: 6,
    createdAt: '2026-11-01T09:00:00Z',
    createdBy: PERSON,
    version: 1,
    ...b,
  }));
  const asked: { bid: number; show?: BaselineShow; after?: string; scenario?: number }[] = [];
  const page = options.page ?? 200;
  const missing = <T>(): Outcome<T> => ({ ok: false, code: 'not_found', fields: {} });
  return {
    asked,
    list: async (planId): Promise<BaselineList> => {
      if (options.failList) throw new Error('offline');
      return {
        plan: { id: planId, name: 'Spring launch' },
        editable: options.editable ?? true,
        baselines: rows.map((r) => ({ ...r })),
        limits: { baselines: 10, tickets: 50_000, page: 200 },
      };
    },
    capture: async (_planId, name, scenarioId): Promise<CaptureOutcome> => {
      if (options.refuseCapture) {
        return {
          ok: false,
          code: options.refuseCapture.code,
          fields: {},
          ...(options.refuseCapture.limit !== undefined
            ? { limit: options.refuseCapture.limit }
            : {}),
        };
      }
      if (rows.length >= 10)
        return { ok: false, code: 'too_many_baselines', fields: {}, limit: 10 };
      const row: BaselineRow = {
        id: nextId++,
        name,
        source: scenarioId === undefined ? 'live' : 'scenario',
        scenarioName: scenarioId === undefined ? null : 'Faster',
        tickets: 6,
        createdAt: '2026-11-14T09:00:00Z',
        createdBy: PERSON,
        version: 1,
      };
      rows = [row, ...rows];
      return { ok: true, value: row };
    },
    rename: async (_planId, bid, name, version) => {
      const row = rows.find((r) => r.id === bid);
      if (!row) return missing();
      if (row.version !== version) return { ok: false, code: 'version_conflict', fields: {} };
      row.name = name;
      row.version++;
      return { ok: true, value: { ...row } };
    },
    remove: async (_planId, bid, version) => {
      const row = rows.find((r) => r.id === bid);
      if (!row) return missing();
      if (row.version !== version) return { ok: false, code: 'version_conflict', fields: {} };
      rows = rows.filter((r) => r.id !== bid);
      return { ok: true, value: null };
    },
    compare: async (_planId, bid, at): Promise<BaselineComparison> => {
      asked.push({
        bid,
        ...(at.show ? { show: at.show } : {}),
        ...(at.after ? { after: at.after } : {}),
        ...(at.scenario !== undefined ? { scenario: at.scenario } : {}),
      });
      if (options.failCompare) throw new Error('offline');
      const row = rows.find((r) => r.id === bid);
      if (!row) throw new Error('not found');
      const all = compared().sort((a, b) => (b.delay ?? -1e9) - (a.delay ?? -1e9) || a.id - b.id);
      const dated = all.filter((t) => t.delay !== null);
      const counts: BaselineCounts = {
        compared: dated.length,
        slipped: dated.filter((t) => (t.delay as number) > 0).length,
        earlier: dated.filter((t) => (t.delay as number) < 0).length,
        same: dated.filter((t) => t.delay === 0).length,
        addedSince: all.filter((t) => t.was === null).length,
        undatedThen: all.filter((t) => t.was !== null && endOf(t.was) === null).length,
        undatedNow: all.filter((t) => endOf(t.was) !== null && endOf(t.now) === null).length,
        notShown: options.notShown ?? 0,
      };
      const latest = (side: 'was' | 'now') =>
        dated
          .map((t) => endOf(t[side]) as string)
          .sort()
          .at(-1) ?? null;
      const was = latest('was');
      const now = latest('now');
      const show = at.show ?? 'slipped';
      const listed = all.filter(SHOWN[show]);
      const from = at.after ? Number(at.after) : 0;
      const slice = listed.slice(from, from + page);
      return {
        baseline: {
          id: row.id,
          name: row.name,
          source: row.source,
          scenarioName: row.scenarioName,
          createdAt: row.createdAt,
        },
        against:
          at.scenario === undefined ? 'live' : { scenario: { id: at.scenario, name: 'Faster' } },
        counts,
        mostLater: dated.reduce<number | null>(
          (m, t) => (m === null || (t.delay as number) > m ? (t.delay as number) : m),
          null,
        ),
        planEnd: {
          was,
          now,
          delay: was && now ? dayNumber(now) - dayNumber(was) : null,
        },
        show,
        tickets: slice,
        next: from + page < listed.length ? String(from + page) : null,
      };
    },
  };
}
