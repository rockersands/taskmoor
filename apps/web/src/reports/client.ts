import { api } from '../api/client';
import { type Board, boardClient } from '../boards/client';
import type { SprintSettings } from '../sprints/client';

/** The flow reports of a board (M1-061; `GET /api/v1/boards/:id/reports/...`). */
export interface ReportWindow {
  timeZone: string;
  from: string;
  to: string;
}

export interface CumulativeFlow extends ReportWindow {
  dates: string[];
  columns: { id: string; name: string; counts: number[] }[];
  unmapped: number[];
}

export interface CyclePointView {
  ticket: { id: number; key: string; summary: string };
  at: string;
  /** Seconds, like the averages and statistics. */
  cycle: number;
  average: number;
  deviation: number;
}

export interface CycleTime extends ReportWindow {
  /** The window as instants: the start of `from`, the end of `to` (now when that is later). */
  start: string;
  end: string;
  columns: { id: string; name: string; chosen: boolean }[];
  averaging: { method: 'tickets' | 'days'; size: number };
  statistics: {
    count: number;
    average: number;
    median: number;
    p85: number;
    p95: number;
    min: number;
    max: number;
    deviation: number;
  };
  histogram: { width: number; counts: number[] };
  /** Points in the window; `points` holds the newest of them. */
  total: number;
  points: CyclePointView[];
}

export interface TimeInStatus extends ReportWindow {
  statuses: {
    status: { id: number; name: string };
    columnId: string | null;
    tickets: number;
    /** Seconds. */
    total: number;
    average: number;
    entries: number;
  }[];
}

/** One sprint of a release or outcome burndown (M1-062). */
export interface SprintWork {
  sprintId: number;
  name: string;
  state: 'active' | 'closed' | 'future';
  startedAt: string | null;
  completedAt: string | null;
  /** Remaining at the start and at the end (now while it runs), by the board's statistic. */
  start: number;
  end: number;
  completed: number;
  added: number;
  removed: number;
}

export interface ScopeBurndown {
  statistic: SprintSettings['estimation'];
  sprints: SprintWork[];
  now: { scope: number; completed: number; remaining: number };
  /** Completed per sprint over the last three completed sprints. */
  velocity: number;
  /** Sprints still needed at that velocity; null without one. */
  forecast: number | null;
  release?: { id: number; name: string };
  outcome?: { id: number; key: string; summary: string };
}

export interface ReleaseReport {
  release: {
    id: number;
    name: string;
    startDate: string | null;
    releaseDate: string | null;
    shippedAt: string | null;
  };
  statistic: SprintSettings['estimation'];
  timeZone: string;
  days: { date: string; scope: number; completed: number }[];
  /** Completed per day over the last 14 days. */
  pace: number;
  /** The local date the work would be complete at that pace; null without pace. */
  forecast: string | null;
}

/** An outcome's work day by day, and its tickets as they stand (RPT-001, outcome report). */
export interface OutcomeReport {
  outcome: { id: number; key: string; summary: string };
  statistic: SprintSettings['estimation'];
  timeZone: string;
  days: { date: string; scope: number; completed: number }[];
  pace: number;
  forecast: string | null;
  tickets: {
    id: number;
    key: string;
    summary: string;
    status: string;
    done: boolean;
    /** By the board's statistic. */
    value: number;
    estimated: boolean;
  }[];
  counts: { done: number; open: number; unestimated: number };
}

export interface ReportParams {
  from?: string;
  to?: string;
  /** Without `from`: this many days up to `to` (or today). */
  days?: number;
  filters?: readonly string[];
}

export interface CycleParams extends ReportParams {
  columns?: readonly string[];
  average?: 'tickets' | 'days';
  window?: number;
}

export interface ReportClient {
  board(id: number): Promise<Board>;
  cumulativeFlow(boardId: number, params: ReportParams): Promise<CumulativeFlow>;
  cycleTime(boardId: number, params: CycleParams): Promise<CycleTime>;
  timeInStatus(boardId: number, params: ReportParams): Promise<TimeInStatus>;
  /** The releases of a track, for the release reports. */
  releases(trackId: number): Promise<{ id: number; name: string }[]>;
  releaseBurndown(boardId: number, releaseId: number): Promise<ScopeBurndown>;
  /** An outcome by key or id. */
  outcomeBurndown(boardId: number, outcome: string): Promise<ScopeBurndown>;
  releaseReport(boardId: number, releaseId: number): Promise<ReleaseReport>;
  /** An outcome by key or id. */
  outcomeReport(boardId: number, outcome: string): Promise<OutcomeReport>;
}

/** A report's path with its query string; empty values are left out. */
export function reportPath(boardId: number, report: string, params: CycleParams): string {
  const query = new URLSearchParams();
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.days !== undefined) query.set('days', String(params.days));
  if (params.filters && params.filters.length > 0) query.set('filters', params.filters.join(','));
  if (params.columns && params.columns.length > 0) query.set('columns', params.columns.join(','));
  if (params.average) query.set('average', params.average);
  if (params.window !== undefined) query.set('window', String(params.window));
  const text = query.toString();
  return `/boards/${boardId}/reports/${report}${text ? `?${text}` : ''}`;
}

export const reportClient: ReportClient = {
  board: (id) => boardClient.board(id),
  cumulativeFlow: (boardId, params) =>
    api<CumulativeFlow>(reportPath(boardId, 'cumulative-flow', params)),
  cycleTime: (boardId, params) => api<CycleTime>(reportPath(boardId, 'cycle-time', params)),
  timeInStatus: (boardId, params) =>
    api<TimeInStatus>(reportPath(boardId, 'time-in-status', params)),
  releases: async (trackId) =>
    (await api<{ releases: { id: number; name: string }[] }>(`/tracks/${trackId}/releases`))
      .releases,
  releaseBurndown: (boardId, releaseId) =>
    api<ScopeBurndown>(`/boards/${boardId}/reports/release-burndown?release=${releaseId}`),
  outcomeBurndown: (boardId, outcome) =>
    api<ScopeBurndown>(
      `/boards/${boardId}/reports/outcome-burndown?outcome=${encodeURIComponent(outcome)}`,
    ),
  releaseReport: (boardId, releaseId) =>
    api<ReleaseReport>(`/boards/${boardId}/reports/release-report?release=${releaseId}`),
  outcomeReport: (boardId, outcome) =>
    api<OutcomeReport>(
      `/boards/${boardId}/reports/outcome-report?outcome=${encodeURIComponent(outcome)}`,
    ),
};
