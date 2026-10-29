import { ApiError, api } from '../api/client';

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

/** A board's configuration (`GET /api/v1/boards/:id`). */
export interface Board extends BoardSummary {
  source: { query: string };
  subFilter: { query: string } | null;
  columns: BoardColumn[];
  boardFilters: BoardFilter[];
  boardFilterDisplay: 'buttons' | 'dropdown';
  mayConfigure: boolean;
  version: number;
}

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
  data(id: number, filters: readonly string[]): Promise<BoardData>;
  move(id: number, move: MoveRequest): Promise<MoveOutcome>;
}

/** The query string of a data request. */
export function dataPath(id: number, filters: readonly string[]): string {
  return filters.length === 0
    ? `/boards/${id}/data`
    : `/boards/${id}/data?filters=${encodeURIComponent(filters.join(','))}`;
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
  data: (id, filters) => api<BoardData>(dataPath(id, filters)),
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
