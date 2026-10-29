import type {
  Board,
  BoardCard,
  BoardClient,
  BoardData,
  BoardLane,
  BoardPatch,
  BoardStatus,
  BoardSummary,
  MoveOutcome,
  MoveRequest,
  Transition,
  UpdateOutcome,
} from './client';

/**
 * An in-memory board for stories and tests (M1-043): three columns over the default
 * statuses, an Expedite lane and its catch-all, two board filters. Moves follow the default
 * workflow: New to Active by Start; from Active, Send to review and Close both lead into the
 * last column, so the board asks which; nothing leads back to New.
 */
const STATUS = { New: 1, Active: 2, 'In Review': 3, Closed: 4 } as const;
type StatusName = keyof typeof STATUS;
const statusName = (id: number) =>
  (Object.keys(STATUS) as StatusName[]).find((k) => STATUS[k] === id) ?? 'New';

export const BOARD: Board = {
  id: 7,
  name: 'Checkout team',
  description: '',
  kind: 'kanban',
  location: { type: 'track', track: { id: 1, key: 'SHOP', name: 'Shop' } },
  source: { query: 'track = SHOP' },
  subFilter: null,
  columns: [
    { id: 'todo', name: 'To do', statusIds: [STATUS.New], min: null, max: null },
    { id: 'doing', name: 'Doing', statusIds: [STATUS.Active], min: null, max: 2 },
    {
      id: 'done',
      name: 'Review and done',
      statusIds: [STATUS['In Review'], STATUS.Closed],
      min: 1,
      max: null,
    },
  ],
  boardFilters: [
    { id: 'mine', name: 'Only my tickets', query: 'assignee = currentUser()', description: '' },
    { id: 'recent', name: 'Recently updated', query: 'updated >= -1d', description: '' },
  ],
  boardFilterDisplay: 'buttons',
  swimlanes: {
    mode: 'queries',
    lanes: [{ id: 'expedite', name: 'Expedite', query: 'priority = Urgent' }],
    unassigned: 'last',
    otherName: 'Everything else',
  },
  cardRules: {
    colourBy: 'type',
    colours: [],
    fields: ['assignee', 'priority'],
    daysInColumn: true,
  },
  mayConfigure: true,
  version: 3,
};

/** The statuses of the board's workflow, each with the column that takes it. */
export const STATUSES: Omit<BoardStatus, 'columnId'>[] = [
  { id: STATUS.New, name: 'New', stage: 'new' },
  { id: STATUS.Active, name: 'Active', stage: 'active' },
  { id: STATUS['In Review'], name: 'In Review', stage: 'active' },
  { id: STATUS.Closed, name: 'Closed', stage: 'closed' },
];

export const LANES: BoardLane[] = [
  { id: 'expedite', name: 'Expedite', catchAll: false },
  { id: 'other', name: 'Everything else', catchAll: true },
];

interface FakeCard extends BoardCard {
  mine: boolean;
}

const card = (
  n: number,
  summary: string,
  status: StatusName,
  lane: string,
  extra: Partial<FakeCard> = {},
): FakeCard => ({
  id: 100 + n,
  key: `SHOP-${n}`,
  summary,
  status: { id: STATUS[status], name: status },
  ticketType: { id: 1, name: 'Task', icon: null, color: null },
  columnId: '',
  laneId: lane,
  rank: `a${String(n).padStart(3, '0')}`,
  version: 1,
  colour: '#2f6fdb',
  fields: { assignee: null, priority: { id: 3, name: 'Normal' } },
  daysInColumn: n % 4,
  mine: false,
  ...extra,
});

export const CARDS: FakeCard[] = [
  card(12, 'Checkout fails for expired cards', 'Active', 'expedite', {
    colour: '#c4314b',
    fields: { assignee: { id: 5, name: 'Kalo Smith' }, priority: { id: 1, name: 'Urgent' } },
    mine: true,
  }),
  card(19, 'Refunds show the wrong currency', 'New', 'other'),
  card(21, 'Saved addresses lose the postcode', 'New', 'other', {
    fields: { assignee: { id: 5, name: 'Kalo Smith' }, priority: { id: 3, name: 'Normal' } },
    mine: true,
  }),
  card(23, 'Gift cards cannot be combined', 'Active', 'other'),
  card(24, 'Apple Pay button misaligned on small screens', 'Active', 'other'),
];

const TRANSITIONS: { id: number; name: string; from: StatusName[] | 'any'; to: StatusName }[] = [
  { id: 1, name: 'Start', from: ['New'], to: 'Active' },
  { id: 2, name: 'Send to review', from: ['Active'], to: 'In Review' },
  { id: 3, name: 'Back to active', from: ['In Review'], to: 'Active' },
  { id: 4, name: 'Close', from: 'any', to: 'Closed' },
];

export interface FakeBoardClient extends BoardClient {
  moves: MoveRequest[];
  dataCalls: string[][];
  patches: BoardPatch[];
}

export function fakeBoardClient(
  options: { cards?: FakeCard[]; board?: Partial<Board>; lanes?: BoardLane[] } = {},
): FakeBoardClient {
  let board: Board = { ...BOARD, ...options.board };
  const lanes = options.lanes ?? LANES;
  let cards = (options.cards ?? CARDS).map((c) => ({ ...c }));
  const columnOf = (statusId: number) =>
    board.columns.find((c) => c.statusIds.includes(statusId))?.id ?? null;
  const boards: BoardSummary[] = [
    board,
    {
      id: 8,
      name: 'Ops on call',
      description: '',
      kind: 'scrum',
      location: { type: 'user', user: { id: 5, name: 'Kalo Smith' } },
    },
  ];
  const client: FakeBoardClient = {
    moves: [],
    dataCalls: [],
    patches: [],
    list: async () => boards,
    create: async (input) => {
      const created: BoardSummary = {
        id: 9,
        name: input.name,
        description: '',
        kind: input.kind,
        location: { type: 'user', user: { id: 5, name: 'Kalo Smith' } },
      };
      boards.push(created);
      return created;
    },
    board: async () => board,
    settings: async () => ({
      board,
      statuses: STATUSES.map((s) => ({
        ...s,
        columnId: board.columns.find((c) => c.statusIds.includes(s.id))?.id ?? null,
      })),
    }),
    update: async (_id, patch): Promise<UpdateOutcome> => {
      client.patches.push(patch);
      if (patch.version !== board.version) return { ok: false, fields: {}, conflict: true };
      if (patch.source && 'query' in patch.source && /=\s*$/.test(patch.source.query)) {
        return { ok: false, fields: { 'source.query': 'invalid_query' } };
      }
      let n = 0;
      const {
        version: _version,
        source,
        subFilter,
        columns,
        swimlanes,
        boardFilters,
        ...rest
      } = patch;
      board = {
        ...board,
        ...rest,
        ...(source ? { source } : {}),
        ...(subFilter !== undefined ? { subFilter } : {}),
        ...(columns ? { columns: columns.map((c) => ({ ...c, id: c.id ?? `n${++n}` })) } : {}),
        ...(swimlanes ? { swimlanes } : {}),
        ...(boardFilters
          ? { boardFilters: boardFilters.map((b) => ({ ...b, id: b.id ?? `f${++n}` })) }
          : {}),
        version: board.version + 1,
      };
      return { ok: true, board };
    },
    data: async (_id, filters): Promise<BoardData> => {
      client.dataCalls.push([...filters]);
      const all = [...cards].sort((a, b) => (a.rank < b.rank ? -1 : 1));
      const shown = all.filter(
        (c) => columnOf(c.status.id) !== null && (!filters.includes('mine') || c.mine),
      );
      return {
        columns: board.columns.map((c) => {
          const count = all.filter((k) => c.statusIds.includes(k.status.id)).length;
          const wip =
            c.max !== null && count > c.max
              ? 'over'
              : c.min !== null && count < c.min
                ? 'under'
                : null;
          return {
            ...c,
            count,
            shown: shown.filter((k) => c.statusIds.includes(k.status.id)).length,
            wip,
          };
        }),
        lanes,
        cards: shown.map(({ mine: _mine, ...c }) => ({
          ...c,
          columnId: columnOf(c.status.id) as string,
        })),
        unmapped: { count: 0, statuses: [] },
        truncated: false,
        warnings: [],
        activeFilters: [...filters],
      };
    },
    move: async (_id, move): Promise<MoveOutcome> => {
      client.moves.push(move);
      const target = board.columns.find((c) => c.id === move.columnId);
      const moving = cards.find((c) => c.id === move.ticket);
      if (!target || !moving) return { kind: 'refused', code: 'invalid_fields' };
      if (!target.statusIds.includes(moving.status.id)) {
        const from = statusName(moving.status.id);
        const candidates: Transition[] = TRANSITIONS.filter(
          (t) =>
            (t.from === 'any' || t.from.includes(from)) && target.statusIds.includes(STATUS[t.to]),
        ).map((t) => ({ id: t.id, name: t.name, to: { id: STATUS[t.to], name: t.to } }));
        let chosen = candidates[0];
        if (move.transitionId !== undefined) {
          chosen = candidates.find((t) => t.id === move.transitionId);
          if (!chosen) return { kind: 'refused', code: 'transition_not_offered' };
        } else if (candidates.length > 1) {
          return { kind: 'choose', transitions: candidates };
        }
        if (!chosen) return { kind: 'no_transition' };
        moving.status = { id: chosen.to.id, name: chosen.to.name };
      }
      const anchorId = move.before ?? move.after;
      if (anchorId !== undefined) {
        const ordered = [...cards].sort((a, b) => (a.rank < b.rank ? -1 : 1));
        const without = ordered.filter((c) => c.id !== moving.id);
        const at = without.findIndex((c) => c.id === anchorId);
        without.splice(move.before !== undefined ? at : at + 1, 0, moving);
        cards = without.map((c, i) => ({ ...c, rank: `a${String(i).padStart(3, '0')}` }));
      }
      return { kind: 'moved' };
    },
  };
  return client;
}
