import { ApiError, api } from '../api/client';
import type { Translate } from '../i18n/I18nProvider';

/** An auto-rolling cycle (M1-045, AGL-012): sprints of `lengthDays` on `timeZone`'s clock. */
export interface SprintCycle {
  lengthDays: number;
  timeZone: string;
}

/** A number field a Scrum board may estimate with (AGL-007): story points and the like. */
export interface NumberField {
  id: number;
  name: string;
}

/** A board's sprint settings (M1-044, AGL-007, AGL-011; the cycle since M1-045). */
export interface SprintSettings {
  estimation: { statistic: 'ticketCount' | 'originalEstimate' | 'field'; fieldId?: number };
  timeTracking: 'none' | 'remainingEstimate';
  parallelSprints: boolean;
  /** Null or absent: people plan, start and complete every sprint. */
  cycle?: SprintCycle | null;
}

export interface Sprint {
  id: number;
  boardId: number;
  name: string;
  goal: string;
  state: 'future' | 'active' | 'closed';
  sequence: number;
  startAt: string | null;
  endAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  version: number;
}

export interface BacklogTicket {
  id: number;
  key: string;
  summary: string;
  type: string;
  status: { id: number; name: string };
  done: boolean;
  estimate: number | null;
  remainingEstimate: number | null;
  /** The ticket's parent, such as an outcome (M1-047). */
  parentId: number | null;
  /** The releases the ticket targets (M1-047). */
  releaseIds: number[];
}

export interface Totals {
  tickets: number;
  estimate: number;
  remaining?: number;
}

export interface SprintSection extends Sprint {
  tickets: BacklogTicket[];
  totals: Totals;
}

/** `GET /api/v1/boards/:id/backlog`: sprint sections, then the backlog. */
export interface Backlog {
  settings: SprintSettings;
  mayManage: boolean;
  sprints: SprintSection[];
  backlog: { tickets: BacklogTicket[]; totals: Totals };
  truncated: boolean;
  /** The board's track, where tickets made inline go; null for a board in a person's space. */
  track: { id: number; key: string } | null;
}

/** An open outcome of the board's tracks, with how many of its tickets the viewer sees. */
export interface OutcomeItem {
  id: number;
  key: string;
  summary: string;
  status: string;
  tickets: number;
  closed: number;
}

/** An unshipped release of the board's tracks. */
export interface ReleaseItem {
  id: number;
  name: string;
  trackId: number;
  releaseDate: string | null;
  tickets: number;
}

/** `GET /api/v1/boards/:id/backlog/panels` (M1-047). */
export interface BacklogPanels {
  outcomes: OutcomeItem[];
  releases: ReleaseItem[];
}

/** Where a block of tickets goes in the rank: before or after a ticket, or at an end. */
export type RankPlace = { before: number } | { after: number } | { position: 'top' | 'bottom' };

/** A planning change to selected tickets: how many went through and how many were refused. */
export interface Planned {
  done: number;
  refused: number;
}

export interface ReportTicket {
  id: number;
  key: string;
  summary: string;
  status: { id: number; name: string };
  addedAfterStart: boolean;
  estimateAtEntry: number | null;
  estimate: number | null;
  estimateChanged: boolean;
  carriedTo?: number | null;
}

/** `GET /api/v1/sprints/:id/report`. */
export interface SprintReport {
  sprint: Sprint;
  statistic: SprintSettings['estimation'];
  completed: ReportTicket[];
  notCompleted: ReportTicket[];
  removed: ReportTicket[];
  totals: {
    committed: number;
    added: number;
    removed: number;
    completed: number;
    notCompleted: number;
    estimateChange: number;
    remaining?: number;
  };
}

/** A day of a sprint chart (`GET /api/v1/sprints/:id/burndown`, M1-060). */
export interface ChartDay {
  date: string;
  remaining: number;
  scope: number;
  completed: number;
}

/** `GET /api/v1/sprints/:id/burndown`: burndown and burnup by day on `timeZone`. */
export interface SprintBurndown {
  sprint: Sprint;
  statistic: SprintSettings['estimation'];
  /** The remaining estimate burns down (time tracking on). */
  burnRemaining: boolean;
  timeZone: string;
  dates: string[];
  start: { at: string; remaining: number; scope: number };
  guideline: {
    from: { at: string; date: string; value: number };
    to: { at: string; date: string; value: number };
  };
  days: ChartDay[];
  end: { at: string; remaining: number; scope: number; completed: number };
}

/** `GET /api/v1/boards/:id/velocity`: committed and completed per closed sprint, oldest first. */
export interface Velocity {
  statistic: SprintSettings['estimation'];
  sprints: (Sprint & { committed: number; completed: number })[];
  average: number;
}

export type CompleteTarget =
  | { type: 'backlog' }
  | { type: 'sprint'; sprintId: number }
  | { type: 'new' };

export interface SprintClient {
  backlog(boardId: number): Promise<Backlog>;
  create(boardId: number): Promise<Sprint>;
  start(sprintId: number, endAt: string): Promise<{ ok: true } | { ok: false; code: string }>;
  complete(sprintId: number, moveTo: CompleteTarget): Promise<void>;
  /** Moves tickets into a sprint, from the backlog or another open sprint. */
  addTickets(sprintId: number, ticketIds: number[]): Promise<void>;
  /** Sends tickets from a sprint back to the backlog. */
  removeTickets(sprintId: number, ticketIds: number[]): Promise<void>;
  report(sprintId: number): Promise<SprintReport>;
  burndown(sprintId: number): Promise<SprintBurndown>;
  velocity(boardId: number): Promise<Velocity>;
  /** The outcome and release panels (M1-047). */
  panels(boardId: number): Promise<BacklogPanels>;
  /** Ranks selected tickets together, in the order given (M1-047). */
  rank(boardId: number, ticketIds: number[], place: RankPlace): Promise<Planned>;
  /** Puts selected tickets under a parent, or takes them from theirs (null). */
  setParent(boardId: number, ticketIds: number[], parent: number | null): Promise<Planned>;
  /** Adds selected tickets to a release, keeping the releases they target. */
  addRelease(boardId: number, ticketIds: number[], releaseId: number): Promise<Planned>;
  /** Makes a ticket in a track from its summary alone. */
  createTicket(track: string, summary: string): Promise<{ id: number; key: string }>;
}

interface BatchAnswer {
  ranked?: number;
  updated?: number;
  results: { ok: boolean }[];
}
const planned = (answer: BatchAnswer): Planned => ({
  done: answer.ranked ?? answer.updated ?? 0,
  refused: answer.results.filter((r) => !r.ok).length,
});

export const sprintClient: SprintClient = {
  backlog: (boardId) => api<Backlog>(`/boards/${boardId}/backlog`),
  create: async (boardId) =>
    (await api<{ sprint: Sprint }>(`/boards/${boardId}/sprints`, { method: 'POST', body: {} }))
      .sprint,
  start: async (sprintId, endAt) => {
    try {
      await api(`/sprints/${sprintId}/start`, { method: 'POST', body: { endAt } });
      return { ok: true };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { ok: false, code: error.code ?? String(error.status) };
    }
  },
  complete: async (sprintId, moveTo) => {
    await api(`/sprints/${sprintId}/complete`, { method: 'POST', body: { moveTo } });
  },
  addTickets: async (sprintId, ticketIds) => {
    await api(`/sprints/${sprintId}/tickets`, { method: 'POST', body: { tickets: ticketIds } });
  },
  removeTickets: async (sprintId, ticketIds) => {
    await api(`/sprints/${sprintId}/tickets/remove`, {
      method: 'POST',
      body: { tickets: ticketIds },
    });
  },
  report: (sprintId) => api<SprintReport>(`/sprints/${sprintId}/report`),
  burndown: (sprintId) => api<SprintBurndown>(`/sprints/${sprintId}/burndown`),
  velocity: (boardId) => api<Velocity>(`/boards/${boardId}/velocity`),
  panels: (boardId) => api<BacklogPanels>(`/boards/${boardId}/backlog/panels`),
  rank: async (boardId, tickets, place) =>
    planned(
      await api<BatchAnswer>(`/boards/${boardId}/backlog/rank`, {
        method: 'POST',
        body: { tickets, ...place },
      }),
    ),
  setParent: async (boardId, tickets, parent) =>
    planned(
      await api<BatchAnswer>(`/boards/${boardId}/backlog/parent`, {
        method: 'POST',
        body: { tickets, parent },
      }),
    ),
  addRelease: async (boardId, tickets, releaseId) =>
    planned(
      await api<BatchAnswer>(`/boards/${boardId}/backlog/release`, {
        method: 'POST',
        body: { tickets, releaseId },
      }),
    ),
  createTicket: async (track, summary) =>
    (
      await api<{ ticket: { id: number; key: string } }>('/tickets', {
        method: 'POST',
        body: { track, summary },
      })
    ).ticket,
};

/** An estimate as the board's statistic reads: hours for time, the number otherwise. */
export function estimateText(
  t: Translate,
  value: number | null | undefined,
  statistic: SprintSettings['estimation']['statistic'],
): string {
  if (value === null || value === undefined) return t('sprints.estimate.none');
  if (statistic === 'originalEstimate') {
    return t('sprints.estimate.hours', { hours: Math.round((value / 3600) * 10) / 10 });
  }
  return String(value);
}
