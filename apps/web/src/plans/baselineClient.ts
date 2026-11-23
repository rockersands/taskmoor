import { ApiError, api } from '../api/client';
import { filterParams, type PlanFilters } from './client';
import type { Outcome } from './scenarioClient';

/**
 * Baselines of a plan (T-089a; PLN-011; ADR-122 stage 9). A baseline is a named, frozen copy of
 * the days of the plan's tickets its capturer was shown, from the tickets as they are (Live) or
 * from a scenario. A comparison sets the days now against it: delay is a ticket's end now less its
 * end then, in calendar days. A baseline gives no access: its days show only on tickets the plan
 * shows the reader now; the rest are one number (`notShown`).
 */

/** One row of `GET /plans/:id/baselines`. */
export interface BaselineRow {
  id: number;
  name: string;
  source: 'live' | 'scenario';
  /** The scenario's name when it was captured; null from Live. */
  scenarioName: string | null;
  /** How many tickets it holds. */
  tickets: number;
  createdAt: string;
  createdBy: { id: number; name: string };
  version: number;
}

export interface BaselineList {
  plan: { id: number; name: string };
  /** Whether the viewer may capture, rename and delete: the plan's owner and site admins. */
  editable: boolean;
  /** Newest first. */
  baselines: BaselineRow[];
  limits: { baselines: number; tickets: number; page: number };
}

/**
 * What a comparison lists: tickets that end later (the default), earlier, not in the baseline
 * (added to the plan since, or not shown to whoever captured it), or all.
 */
export const BASELINE_SHOWS = ['slipped', 'earlier', 'added', 'all'] as const;
export type BaselineShow = (typeof BASELINE_SHOWS)[number];

/** One side's days of a ticket: its own, else its sprint's, and which. */
export interface BaselineDays {
  start: string | null;
  due: string | null;
  dated: 'own' | 'sprint' | null;
}

export interface BaselineTicket {
  id: number;
  key: string;
  summary: string;
  level: { rank: number; kind: string };
  /** Closed now. */
  closed: boolean;
  /** Its days in the baseline; null for a ticket not in it (added since, or not shown to its capturer). */
  was: BaselineDays | null;
  now: BaselineDays;
  /** Its end now less its end then, in calendar days; null unless dated on both sides. */
  delay: number | null;
  /** Its start now less its start then, in days. */
  startShift: number | null;
}

export interface BaselineCounts {
  /** Dated on both sides. */
  compared: number;
  slipped: number;
  earlier: number;
  same: number;
  addedSince: number;
  /** In the baseline without days. */
  undatedThen: number;
  /** With days then and none now. */
  undatedNow: number;
  /** Rows on tickets the plan does not show the reader now. */
  notShown: number;
}

/** `GET /plans/:id/baselines/:bid/compare`. */
export interface BaselineComparison {
  baseline: {
    id: number;
    name: string;
    source: 'live' | 'scenario';
    scenarioName: string | null;
    createdAt: string;
  };
  against: 'live' | { scenario: { id: number; name: string } };
  counts: BaselineCounts;
  /** The most a compared ticket ends later (or earlier, below 0); null when none is compared. */
  mostLater: number | null;
  /** The latest end on each side over the tickets compared. */
  planEnd: { was: string | null; now: string | null; delay: number | null };
  show: BaselineShow;
  tickets: BaselineTicket[];
  /** The cursor of the next page; null on the last. */
  next: string | null;
}

export interface BaselineCompareAt {
  filters: PlanFilters;
  /** The scenario whose days are now; Live without one. */
  scenario?: number | undefined;
  show?: BaselineShow;
  after?: string;
}

/** A refused capture: the code, the fields it names, and the limit it reached. */
export type CaptureOutcome = Outcome<BaselineRow> & { limit?: number };

export interface BaselineClient {
  list(planId: number): Promise<BaselineList>;
  /** Captures the days now, from Live or the scenario given. */
  capture(planId: number, name: string, scenarioId?: number): Promise<CaptureOutcome>;
  rename(planId: number, bid: number, name: string, version: number): Promise<Outcome<BaselineRow>>;
  remove(planId: number, bid: number, version: number): Promise<Outcome<null>>;
  compare(planId: number, bid: number, at: BaselineCompareAt): Promise<BaselineComparison>;
}

const of = (planId: number) => `/plans/${planId}/baselines`;

/** A call's answer, or its refusal as the server said it; a dropped connection still throws. */
async function outcome<T>(call: () => Promise<T>): Promise<Outcome<T> & { limit?: number }> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const body = error.body as {
      fields?: Record<string, string>;
      permission?: unknown;
      limit?: unknown;
    } | null;
    return {
      ok: false,
      code: error.code ?? String(error.status),
      fields: body?.fields ?? {},
      ...(typeof body?.permission === 'string' ? { permission: body.permission } : {}),
      ...(typeof body?.limit === 'number' ? { limit: body.limit } : {}),
    };
  }
}

export const baselineClient: BaselineClient = {
  list: (planId) => api<BaselineList>(of(planId)),
  capture: (planId, name, scenarioId) =>
    outcome(
      async () =>
        (
          await api<{ baseline: BaselineRow }>(of(planId), {
            method: 'POST',
            body: scenarioId === undefined ? { name } : { name, scenarioId },
          })
        ).baseline,
    ),
  rename: (planId, bid, name, version) =>
    outcome(
      async () =>
        (
          await api<{ baseline: BaselineRow }>(`${of(planId)}/${bid}`, {
            method: 'PATCH',
            body: { name, version },
          })
        ).baseline,
    ),
  remove: (planId, bid, version) =>
    outcome(async () => {
      await api(`${of(planId)}/${bid}?version=${version}`, { method: 'DELETE' });
      return null;
    }),
  compare: (planId, bid, at) => {
    const params = filterParams(at.filters);
    if (at.scenario !== undefined) params.set('scenario', String(at.scenario));
    if (at.show) params.set('show', at.show);
    if (at.after) params.set('after', at.after);
    const text = params.toString();
    return api<BaselineComparison>(`${of(planId)}/${bid}/compare${text ? `?${text}` : ''}`);
  },
};
