import { ApiError, api } from '../api/client';
import type { NumberField, SprintSettings } from '../sprints/client';

/** A board in the list (`GET /api/v1/boards`, M1-043). */
export interface BoardSummary {
  id: number;
  name: string;
  description: string;
  kind: 'scrum' | 'kanban';
  location:
    | { type: 'track'; track: { id: number; key: string | null; name: string | null } }
    | { type: 'user'; user: { id: number | null; name: string | null } };
}

export interface BoardColumn {
  id: string;
  name: string;
  statusIds: number[];
  min: number | null;
  max: number | null;
}

export interface BoardFilter {
  id: string;
  name: string;
  query: string;
  description: string;
}

export interface BoardLaneQuery {
  id?: string;
  name: string;
  query: string;
}

export interface Swimlanes {
  mode: 'none' | 'queries' | 'assignees' | 'parents';
  lanes: BoardLaneQuery[];
  unassigned: 'first' | 'last';
  otherName: string;
}

export interface ColourRule {
  id?: string;
  query: string;
  colour: string;
}

export interface CardRules {
  colourBy: 'none' | 'type' | 'priority' | 'assignee' | 'queries';
  colours: ColourRule[];
  fields: string[];
  daysInColumn: boolean;
}

/** Ticket properties a card may show (the server's `CARD_FIELDS`), up to 10. */
export const CARD_FIELDS = [
  'assignee',
  'priority',
  'dueDate',
  'startDate',
  'labels',
  'targetReleases',
  'areas',
  'requester',
  'parent',
  'track',
  'voteCount',
  'followerCount',
  'timeTracking',
  'createdAt',
  'updatedAt',
] as const;
export const MAX_CARD_FIELDS = 10;

/** A board's configuration (`GET /api/v1/boards/:id`). */
export interface Board extends BoardSummary {
  /** The board's own query, or the saved search it uses (M1-063). */
  source: BoardSource;
  subFilter: { query: string } | null;
  columns: BoardColumn[];
  swimlanes: Swimlanes;
  boardFilters: BoardFilter[];
  boardFilterDisplay: 'buttons' | 'dropdown';
  cardRules: CardRules;
  /** Read on every board; the settings page shows them for Scrum boards (M1-044, M1-045). */
  sprintSettings: SprintSettings;
  mayConfigure: boolean;
  version: number;
}

/** A status a column may take: one of the board's workflows' (`GET /api/v1/boards/:id`). */
export interface BoardStatus {
  id: number;
  name: string;
  stage: string;
  columnId: string | null;
}

/** A change of configuration (`PATCH /api/v1/boards/:id`). */
export type BoardSource = { query: string } | { savedSearchId: number };

/** The query text a source shows as: a saved search reads as a reference to it. */
export const sourceText = (source: BoardSource): string =>
  'query' in source ? source.query : `savedSearch = ${source.savedSearchId}`;

/** A query that only names one saved search by id keeps the board on that saved search. */
export function sourceOf(text: string): BoardSource {
  const ref = /^savedSearch\s*=\s*(\d{1,10})$/.exec(text.trim());
  return ref ? { savedSearchId: Number(ref[1]) } : { query: text.trim() };
}

export interface BoardPatch {
  version: number;
  name?: string;
  kind?: 'scrum' | 'kanban';
  source?: BoardSource;
  subFilter?: { query: string } | null;
  columns?: {
    id?: string;
    name: string;
    statusIds: number[];
    min: number | null;
    max: number | null;
  }[];
  swimlanes?: Swimlanes;
  boardFilters?: { id?: string; name: string; query: string; description: string }[];
  boardFilterDisplay?: 'buttons' | 'dropdown';
  cardRules?: CardRules;
  sprintSettings?: SprintSettings;
}

/** Saved, or refused with a problem per field (`columns`, `boardFilters.1.query`, ...). */
export type UpdateOutcome =
  | { ok: true; board: Board }
  | { ok: false; fields: Record<string, string>; conflict?: boolean };

export interface BoardCard {
  id: number;
  key: string;
  summary: string;
  status: { id: number; name: string };
  ticketType: { id: number; name: string; icon: string | null; color: string | null };
  columnId: string;
  laneId: string;
  rank: string;
  version: number;
  colour: string | null;
  fields: Record<string, unknown>;
  daysInColumn: number | null;
}

export interface BoardLane {
  id: string;
  name: string;
  catchAll: boolean;
  assignee?: { id: number; name: string } | null;
  parent?: { id: number; key: string; summary: string } | null;
}

/** What the board shows (`GET /api/v1/boards/:id/data`). */
export interface BoardData {
  columns: (BoardColumn & { count: number; shown: number; wip: 'over' | 'under' | null })[];
  lanes: BoardLane[];
  cards: BoardCard[];
  unmapped: { count: number; statuses: { id: number; name: string; count: number }[] };
  truncated: boolean;
  warnings: string[];
  activeFilters: string[];
}

export interface Transition {
  id: number;
  name: string;
  to: { id: number; name: string };
}

export interface MoveRequest {
  ticket: number;
  columnId: string;
  transitionId?: number;
  before?: number;
  after?: number;
}

/**
 * How a move ended: done, or refused because several transitions lead into the column (pick
 * one), none does, or the ticket route said no (`message` from its answer).
 */
export type MoveOutcome =
  | { kind: 'moved' }
  | { kind: 'choose'; transitions: Transition[] }
  | { kind: 'no_transition' }
  | { kind: 'refused'; code: string };

export interface NewBoard {
  name: string;
  kind: 'scrum' | 'kanban';
  query: string;
}

export interface BoardClient {
  list(): Promise<BoardSummary[]>;
  create(board: NewBoard): Promise<BoardSummary>;
  board(id: number): Promise<Board>;
  /** The configuration with the statuses its columns may take. */
  settings(id: number): Promise<{ board: Board; statuses: BoardStatus[] }>;
  update(id: number, patch: BoardPatch): Promise<UpdateOutcome>;
  /** The number fields the person sees, for the estimation statistic. */
  numberFields(): Promise<NumberField[]>;
  /** `sprints: 'active'` shows a Scrum board's active sprints only (M1-044). */
  data(id: number, filters: readonly string[], sprints?: 'active'): Promise<BoardData>;
  move(id: number, move: MoveRequest): Promise<MoveOutcome>;
}

/** The query string of a data request. */
export function dataPath(id: number, filters: readonly string[], sprints?: 'active'): string {
  const params = [
    ...(filters.length > 0 ? [`filters=${encodeURIComponent(filters.join(','))}`] : []),
    ...(sprints ? [`sprints=${sprints}`] : []),
  ];
  return params.length === 0 ? `/boards/${id}/data` : `/boards/${id}/data?${params.join('&')}`;
}

export const boardClient: BoardClient = {
  list: async () => (await api<{ boards: BoardSummary[] }>('/boards')).boards,
  create: async (board) =>
    (
      await api<{ board: BoardSummary }>('/boards', {
        method: 'POST',
        body: { name: board.name, kind: board.kind, source: { query: board.query } },
      })
    ).board,
  board: async (id) => (await api<{ board: Board }>(`/boards/${id}`)).board,
  settings: (id) => api<{ board: Board; statuses: BoardStatus[] }>(`/boards/${id}`),
  update: async (id, patch) => {
    try {
      const { board } = await api<{ board: Board }>(`/boards/${id}`, {
        method: 'PATCH',
        body: patch,
      });
      return { ok: true, board };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const body = error.body as { fields?: Record<string, string> } | null;
      if (error.code === 'version_conflict') return { ok: false, fields: {}, conflict: true };
      if (error.code === 'invalid_fields') return { ok: false, fields: body?.fields ?? {} };
      throw error;
    }
  },
  numberFields: async () =>
    (await api<{ fields: (NumberField & { type: string })[] }>('/fields')).fields
      .filter((f) => f.type === 'number')
      .map((f) => ({ id: f.id, name: f.name })),
  data: (id, filters, sprints) => api<BoardData>(dataPath(id, filters, sprints)),
  move: async (id, move) => {
    try {
      await api(`/boards/${id}/moves`, { method: 'POST', body: move });
      return { kind: 'moved' };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const body = error.body as { transitions?: Transition[] } | null;
      if (error.code === 'transition_choice') {
        return { kind: 'choose', transitions: body?.transitions ?? [] };
      }
      if (error.code === 'no_transition') return { kind: 'no_transition' };
      return { kind: 'refused', code: error.code ?? String(error.status) };
    }
  },
};
