import { api } from '../api/client';
import { type Board, boardClient } from '../boards/client';

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
};
