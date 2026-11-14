import { ApiError, api } from '../api/client';
import { type Refusal, refusalOf } from '../timeline/client';
import type { BlockersElsewhere, DependencyLink } from '../timeline/dependencies';
import { filterParams, type LinkTypeOption, type PlanFilters } from './client';

/** A program board as a plan lists it (PLN-008; ADR-122 stage 5). */
export interface ProgramBoardSummary {
  id: number;
  name: string;
  /** The Team field its rows read; null once that field is gone. */
  teamField: { id: number; name: string } | null;
  /** The first period is the plan's period holding this day. */
  from: string;
  periods: number;
  archived: boolean;
  version: number;
}

/** `GET /api/v1/plans/:id/program-boards`. */
export interface ProgramBoardList {
  editable: boolean;
  boards: ProgramBoardSummary[];
  /** The site's Team fields a board may read: shared, one value each, oldest first. */
  teamFields: { id: number; name: string }[];
}

/** One cell: how many cards its search finds, and the first 20 of them by id. */
export interface BoardCell {
  count: number;
  cards: number[];
}

export interface BoardRow {
  /** Null for other or no team. */
  team: { id: number; name: string } | null;
  /** Its condition for the search behind a number; null when it adds none. */
  clause: string | null;
  unscheduled: BoardCell;
  cells: BoardCell[];
}

export interface ProgramBoardCard {
  id: number;
  key: string;
  summary: string;
  type: string;
  level: { rank: number; kind: string };
  status: { name: string; stage: 'new' | 'active' | 'closed' };
  start: string | null;
  due: string | null;
  trackId: number;
  /** The version read, sent with a move so a stale one is refused. */
  version: number;
  assignee: { id: number; name: string } | null;
  team: { id: number; name: string } | null;
}

/** `GET /api/v1/plans/:id/program-boards/:boardId`. */
export interface ProgramBoard {
  board: ProgramBoardSummary;
  plan: { id: number; name: string };
  editable: boolean;
  /** The plan's query with the filters; null when the viewer sees none of it. */
  query: string | null;
  /** The levels a board shows, as a clause. */
  clause: string;
  periods: { start: string; end: string; clause: string }[];
  unscheduledClause: string;
  rows: BoardRow[];
  cards: ProgramBoardCard[];
  links: DependencyLink[];
  linkTypes: LinkTypeOption[];
  sameSprint: boolean;
  blockersElsewhere: BlockersElsewhere[];
}

export interface BoardInput {
  name: string;
  teamFieldId?: number;
  from?: string;
  periods?: number;
}

export type BoardSaved =
  | { ok: true; board: ProgramBoardSummary }
  | { ok: false; error: string; fields: Record<string, string> };

/** What a move sends to the ticket's own route. */
export interface CardChange {
  version: number;
  startDate?: string | null;
  dueDate?: string | null;
  fields?: Record<string, number | null>;
}

export type CardMoved = { ok: true } | Refusal;

export interface ProgramBoardClient {
  list(planId: number): Promise<ProgramBoardList>;
  create(planId: number, input: BoardInput): Promise<BoardSaved>;
  update(
    planId: number,
    boardId: number,
    input: Partial<BoardInput> & { archived?: boolean; version?: number },
  ): Promise<BoardSaved>;
  remove(planId: number, boardId: number): Promise<void>;
  read(planId: number, boardId: number, filters: PlanFilters): Promise<ProgramBoard>;
  /** A card moves through the ticket's own route (`PATCH /tickets/:key`), with the version read. */
  move(key: string, change: CardChange): Promise<CardMoved>;
}

const boardsOf = (planId: number) => `/plans/${planId}/program-boards`;

async function saved(call: () => Promise<{ board: ProgramBoardSummary }>): Promise<BoardSaved> {
  try {
    return { ok: true, board: (await call()).board };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const body = error.body as { fields?: Record<string, string> } | null;
    return { ok: false, error: error.code ?? String(error.status), fields: body?.fields ?? {} };
  }
}

export const programBoardClient: ProgramBoardClient = {
  list: (planId) => api<ProgramBoardList>(boardsOf(planId)),
  create: (planId, input) =>
    saved(() =>
      api<{ board: ProgramBoardSummary }>(boardsOf(planId), { method: 'POST', body: input }),
    ),
  update: (planId, boardId, input) =>
    saved(() =>
      api<{ board: ProgramBoardSummary }>(`${boardsOf(planId)}/${boardId}`, {
        method: 'PATCH',
        body: input,
      }),
    ),
  remove: async (planId, boardId) => {
    await api(`${boardsOf(planId)}/${boardId}`, { method: 'DELETE' });
  },
  read: (planId, boardId, filters) => {
    const params = filterParams(filters).toString();
    return api<ProgramBoard>(`${boardsOf(planId)}/${boardId}${params ? `?${params}` : ''}`);
  },
  move: async (key, change) => {
    try {
      await api(`/tickets/${encodeURIComponent(key)}`, { method: 'PATCH', body: change });
      return { ok: true };
    } catch (error) {
      // A dropped connection is said as one: the move may not have happened.
      if (!(error instanceof ApiError)) return { ok: false, code: 'unreachable' };
      return refusalOf(error);
    }
  },
};

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const isoDay = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** Where a card stands: its row (a team's id, null for other or no team) and column. */
export interface Place {
  team: number | null;
  /** 0 for Not scheduled, then each period from 1. */
  column: number;
}

/**
 * What moving a card from one place to another changes (ADR-122 stage 5), or null for nothing:
 * - another row sets its Team value to that team, or clears it for other or no team;
 * - another period moves its start and due days by the distance between the periods' first days,
 *   the due day kept inside the new period and a start after it brought to it; from Not scheduled
 *   the due day becomes the period's last day and a start after it the period's first; to Not
 *   scheduled the due day is cleared and the start stays.
 */
export function cardChange(
  card: Pick<ProgramBoardCard, 'version' | 'start' | 'due'>,
  from: Place,
  to: Place,
  periods: readonly { start: string; end: string }[],
  teamFieldId: number | null,
): CardChange | null {
  const change: CardChange = { version: card.version };
  let changed = false;
  if (to.team !== from.team && teamFieldId !== null) {
    change.fields = { [String(teamFieldId)]: to.team };
    changed = true;
  }
  if (to.column !== from.column) {
    changed = true;
    const target = periods[to.column - 1];
    if (to.column === 0 || !target) {
      change.dueDate = null;
    } else {
      const first = dayNumber(target.start);
      const last = dayNumber(target.end);
      const source = periods[from.column - 1];
      let due: number;
      let start: number | null = card.start === null ? null : dayNumber(card.start);
      if (from.column === 0 || !source || card.due === null) {
        due = last;
        if (start !== null && start > due) start = first;
      } else {
        const shift = first - dayNumber(source.start);
        due = Math.min(Math.max(dayNumber(card.due) + shift, first), last);
        if (start !== null) start = Math.min(start + shift, due);
      }
      change.dueDate = isoDay(due);
      if (start !== null && isoDay(start) !== card.start) change.startDate = isoDay(start);
    }
  }
  return changed ? change : null;
}
