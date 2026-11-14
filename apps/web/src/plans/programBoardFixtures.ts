import type {
  BoardInput,
  BoardSaved,
  CardChange,
  CardMoved,
  ProgramBoard,
  ProgramBoardClient,
  ProgramBoardList,
  ProgramBoardSummary,
} from './programBoardClient';

/**
 * A program board for tests and stories (PLN-008): plan 12's "Spring PI", weekly periods from
 * Monday 2 November 2026, rows Web and Ops by the Team field. SHOP-1 (an outcome) and SHOP-2 are
 * Web's in the first week, with three more found by the cell's search; OPS-7 is Ops's in the
 * second and blocks SHOP-2, which it ends after, so late; SHOP-2 also waits for one ticket outside
 * the plan, only counted. SHOP-3 is the Data team's, a team the plan does not plan with, and has no
 * due day. OPS-9 is closed, in the third week.
 */
export const BOARD_SUMMARY: ProgramBoardSummary = {
  id: 5,
  name: 'Spring PI',
  teamField: { id: 40, name: 'Team' },
  from: '2026-11-02',
  periods: 3,
  archived: false,
  version: 2,
};

const BASE = 'track IN ("SHOP", "OPS")';

export function boardFixture(overrides: Partial<ProgramBoard> = {}): ProgramBoard {
  const card = (
    id: number,
    key: string,
    summary: string,
    rest: Partial<ProgramBoard['cards'][number]> = {},
  ): ProgramBoard['cards'][number] => ({
    id,
    key,
    summary,
    type: 'Feature',
    level: { rank: 0, kind: 'standard' },
    status: { name: 'New', stage: 'new' },
    start: null,
    due: null,
    trackId: key.startsWith('OPS') ? 2 : 1,
    version: 3,
    assignee: null,
    team: null,
    ...rest,
  });
  const web = { id: 3, name: 'Web' };
  const ops = { id: 4, name: 'Ops' };
  const empty = () => ({ count: 0, cards: [] as number[] });
  return {
    board: BOARD_SUMMARY,
    plan: { id: 12, name: 'Spring launch' },
    editable: true,
    query: BASE,
    clause: 'hierarchyLevel IN (0, 1)',
    periods: [
      {
        start: '2026-11-02',
        end: '2026-11-08',
        clause: 'due >= "2026-11-02" AND due <= "2026-11-08"',
      },
      {
        start: '2026-11-09',
        end: '2026-11-15',
        clause: 'due >= "2026-11-09" AND due <= "2026-11-15"',
      },
      {
        start: '2026-11-16',
        end: '2026-11-22',
        clause: 'due >= "2026-11-16" AND due <= "2026-11-22"',
      },
    ],
    unscheduledClause: 'stage != closed AND due IS EMPTY',
    rows: [
      {
        team: web,
        clause: 'cf[40] = 3',
        unscheduled: empty(),
        cells: [{ count: 5, cards: [101, 102] }, empty(), empty()],
      },
      {
        team: ops,
        clause: 'cf[40] = 4',
        unscheduled: empty(),
        cells: [empty(), { count: 1, cards: [103] }, { count: 1, cards: [105] }],
      },
      {
        team: null,
        clause: '(cf[40] IS EMPTY OR cf[40] NOT IN (3, 4))',
        unscheduled: { count: 1, cards: [104] },
        cells: [empty(), empty(), empty()],
      },
    ],
    cards: [
      card(101, 'SHOP-1', 'Checkout', {
        type: 'Outcome',
        level: { rank: 1, kind: 'standard' },
        start: '2026-11-02',
        due: '2026-11-06',
        team: web,
      }),
      card(102, 'SHOP-2', 'Pay by card', { due: '2026-11-05', team: web }),
      card(103, 'OPS-7', 'New database', {
        start: '2026-11-09',
        due: '2026-11-12',
        team: ops,
        status: { name: 'Active', stage: 'active' },
      }),
      card(104, 'SHOP-3', 'Gift cards', { team: { id: 6, name: 'Data' } }),
      card(105, 'OPS-9', 'Old logs', {
        due: '2026-11-18',
        team: ops,
        status: { name: 'Closed', stage: 'closed' },
      }),
    ],
    links: [{ from: 103, to: 102, linkTypeId: 1 }],
    linkTypes: [{ id: 1, name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }],
    sameSprint: false,
    blockersElsewhere: [{ id: 102, outside: 1, unlisted: 0 }],
    ...overrides,
  };
}

export interface FakeBoardOptions {
  board?: ProgramBoard;
  list?: Partial<ProgramBoardList>;
  /** Answer moves with this refusal's code instead of making them. */
  refuse?: string;
  /** Never answer reads: the loading state. */
  pending?: boolean;
}

export function fakeBoardClient(options: FakeBoardOptions = {}): ProgramBoardClient & {
  moves: { key: string; change: CardChange }[];
  reads: () => number;
  created: BoardInput[];
  updated: { boardId: number; input: Record<string, unknown> }[];
  removed: number[];
} {
  let reads = 0;
  const moves: { key: string; change: CardChange }[] = [];
  const created: BoardInput[] = [];
  const updated: { boardId: number; input: Record<string, unknown> }[] = [];
  const removed: number[] = [];
  let boards: ProgramBoardSummary[] = [
    BOARD_SUMMARY,
    { ...BOARD_SUMMARY, id: 6, name: 'Summer PI', from: '2027-01-04', version: 1 },
    { ...BOARD_SUMMARY, id: 7, name: 'Winter PI', archived: true, version: 4 },
  ];
  const saved = (board: ProgramBoardSummary): BoardSaved => ({ ok: true, board });
  return {
    moves,
    created,
    updated,
    removed,
    reads: () => reads,
    list: async () => ({
      editable: true,
      boards: boards.filter((b) => !removed.includes(b.id)),
      teamFields: [{ id: 40, name: 'Team' }],
      ...options.list,
    }),
    create: async (_planId, input) => {
      created.push(input);
      const board = { ...BOARD_SUMMARY, id: 8, name: input.name, version: 1 };
      boards = [...boards, board];
      return saved(board);
    },
    update: async (_planId, boardId, input) => {
      updated.push({ boardId, input });
      const found = boards.find((b) => b.id === boardId) ?? BOARD_SUMMARY;
      const board = {
        ...found,
        ...(input.name ? { name: input.name } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
        version: found.version + 1,
      };
      boards = boards.map((b) => (b.id === boardId ? board : b));
      return saved(board);
    },
    remove: async (_planId, boardId) => {
      removed.push(boardId);
    },
    read: async () => {
      reads++;
      if (options.pending) return new Promise<ProgramBoard>(() => {});
      return options.board ?? boardFixture();
    },
    move: async (key, change): Promise<CardMoved> => {
      moves.push({ key, change });
      return options.refuse ? { ok: false, code: options.refuse } : { ok: true };
    },
  };
}
