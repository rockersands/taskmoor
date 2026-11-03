import type {
  Backlog,
  BacklogPanels,
  BacklogTicket,
  CompleteTarget,
  RankPlace,
  SprintBurndown,
  SprintClient,
  SprintReport,
  SprintSection,
  Velocity,
} from './client';

/**
 * An in-memory Scrum board backlog for stories and tests (M1-044): one active sprint, one
 * planned sprint and the backlog, estimates in hours. Moves, starts and completions change it
 * as the server would, without scope-change history. Planning (M1-047) adds an outcome and two
 * releases: ranks move tickets within their section, and parents and releases change the
 * tickets and the panels' counts.
 */
const HOUR = 3600;
const ticket = (id: number, summary: string, hours: number, done = false): BacklogTicket => ({
  id,
  key: `CHK-${id}`,
  summary,
  type: 'Task',
  typeIcon: null,
  priority: { id: 1, name: 'High', level: 2 },
  status: done ? { id: 4, name: 'Closed' } : { id: 1, name: 'New' },
  done,
  estimate: hours * HOUR,
  remainingEstimate: done ? 0 : hours * HOUR,
  parentId: null,
  releaseIds: [],
});

const section = (
  id: number,
  name: string,
  state: 'active' | 'future',
  tickets: BacklogTicket[],
): SprintSection => ({
  id,
  boardId: 7,
  name,
  goal: state === 'active' ? 'Card payments in checkout' : '',
  state,
  sequence: id,
  startAt: state === 'active' ? '2026-10-26T09:00:00Z' : null,
  endAt: state === 'active' ? '2026-11-09T09:00:00Z' : null,
  startedAt: state === 'active' ? '2026-10-26T09:00:00Z' : null,
  completedAt: null,
  version: 1,
  tickets,
  totals: { tickets: 0, estimate: 0 },
});

function withTotals(backlog: Backlog): Backlog {
  const totals = (list: BacklogTicket[]) => ({
    tickets: list.length,
    estimate: list.reduce((s, t) => s + (t.estimate ?? 0), 0),
    remaining: list.filter((t) => !t.done).reduce((s, t) => s + (t.remainingEstimate ?? 0), 0),
  });
  return {
    ...backlog,
    sprints: backlog.sprints.map((s) => ({ ...s, totals: totals(s.tickets) })),
    backlog: { tickets: backlog.backlog.tickets, totals: totals(backlog.backlog.tickets) },
  };
}

export function fakeSprintClient(): SprintClient & { state: () => Backlog } {
  let next = 20;
  let named = 2;
  let nextTicket = 6;
  let data: Backlog = withTotals({
    settings: {
      estimation: { statistic: 'originalEstimate' },
      timeTracking: 'remainingEstimate',
      parallelSprints: false,
    },
    mayManage: true,
    sprints: [
      section(11, 'Checkout Sprint 1', 'active', [
        ticket(1, 'Accept card payments', 5),
        ticket(2, 'Show the order total', 2, true),
      ]),
      section(12, 'Checkout Sprint 2', 'future', [ticket(3, 'Save cards for later', 3)]),
    ],
    backlog: {
      tickets: [ticket(4, 'Gift cards', 8), ticket(5, 'Split payments', 13)],
      totals: { tickets: 0, estimate: 0 },
    },
    truncated: false,
    track: { id: 1, key: 'CHK' },
  });
  const panels: BacklogPanels = {
    outcomes: [
      {
        id: 40,
        key: 'CHK-40',
        summary: 'Faster checkout',
        status: 'Active',
        tickets: 0,
        closed: 0,
      },
    ],
    releases: [
      { id: 50, name: 'Checkout 2.0', trackId: 1, releaseDate: '2026-12-01', tickets: 0 },
      { id: 51, name: 'Checkout 2.1', trackId: 1, releaseDate: null, tickets: 0 },
    ],
  };
  const lists = () => [...data.sprints.map((s) => s.tickets), data.backlog.tickets];
  const all = () => lists().flat();
  /** One ticket to a place within its own section, as the global rank shows it there. */
  const place = (id: number, at: RankPlace) => {
    const list = lists().find((l) => l.some((t) => t.id === id));
    if (!list) return false;
    const from = list.findIndex((t) => t.id === id);
    const [moved] = list.splice(from, 1);
    if (!moved) return false;
    const anchor = 'before' in at ? at.before : 'after' in at ? at.after : null;
    const index = anchor === null ? -1 : list.findIndex((t) => t.id === anchor);
    if ('position' in at) list.splice(at.position === 'top' ? 0 : list.length, 0, moved);
    else if (index < 0) list.splice(from, 0, moved);
    else list.splice('before' in at ? index : index + 1, 0, moved);
    return true;
  };
  const counted = () => {
    for (const o of panels.outcomes) o.tickets = all().filter((t) => t.parentId === o.id).length;
    for (const r of panels.releases)
      r.tickets = all().filter((t) => t.releaseIds.includes(r.id)).length;
  };
  const take = (id: number): BacklogTicket | undefined => {
    for (const s of data.sprints) {
      const found = s.tickets.find((t) => t.id === id);
      if (found) {
        s.tickets = s.tickets.filter((t) => t.id !== id);
        return found;
      }
    }
    const found = data.backlog.tickets.find((t) => t.id === id);
    data.backlog.tickets = data.backlog.tickets.filter((t) => t.id !== id);
    return found;
  };
  const update = () => {
    data = withTotals(data);
  };
  return {
    state: () => data,
    backlog: async () => structuredClone(data),
    sprints: async () => structuredClone(data.sprints),
    boardSprints: async () => ({
      sprints: structuredClone(data.sprints).map(({ tickets: _t, totals: _s, ...s }) => s),
      mayManage: data.mayManage,
    }),
    create: async () => {
      const made = section(++next, `Checkout Sprint ${++named}`, 'future', []);
      data.sprints.push(made);
      update();
      return made;
    },
    start: async (sprintId) => {
      if (data.sprints.some((s) => s.state === 'active')) {
        return { ok: false, code: 'sprint_active' };
      }
      data.sprints = data.sprints.map((s) => (s.id === sprintId ? { ...s, state: 'active' } : s));
      update();
      return { ok: true };
    },
    complete: async (sprintId, moveTo: CompleteTarget) => {
      const done = data.sprints.find((s) => s.id === sprintId);
      if (!done) return;
      const open = done.tickets.filter((t) => !t.done);
      data.sprints = data.sprints.filter((s) => s.id !== sprintId);
      if (moveTo.type === 'backlog') data.backlog.tickets.unshift(...open);
      else if (moveTo.type === 'new') {
        data.sprints.push(section(++next, `Checkout Sprint ${++named}`, 'future', open));
      } else data.sprints.find((s) => s.id === moveTo.sprintId)?.tickets.push(...open);
      update();
    },
    addTickets: async (sprintId, ids) => {
      for (const id of ids) {
        const t = take(id);
        if (t) data.sprints.find((s) => s.id === sprintId)?.tickets.push(t);
      }
      update();
    },
    removeTickets: async (_sprintId, ids) => {
      for (const id of ids) {
        const t = take(id);
        if (t) data.backlog.tickets.unshift(t);
      }
      update();
    },
    panels: async () => {
      counted();
      return structuredClone(panels);
    },
    rank: async (_boardId, ids, at) => {
      let done = 0;
      for (const [i, id] of ids.entries()) {
        const prior = ids[i - 1];
        if (!place(id, prior === undefined ? at : { after: prior })) break;
        done++;
      }
      update();
      return { done, refused: ids.length - done };
    },
    setParent: async (_boardId, ids, parent) => {
      for (const t of all()) if (ids.includes(t.id)) t.parentId = parent;
      return { done: ids.length, refused: 0 };
    },
    addRelease: async (_boardId, ids, releaseId) => {
      for (const t of all()) {
        if (ids.includes(t.id) && !t.releaseIds.includes(releaseId)) t.releaseIds.push(releaseId);
      }
      return { done: ids.length, refused: 0 };
    },
    createTicket: async (_track, summary) => {
      const made = { ...ticket(++nextTicket, summary, 0), estimate: null, remainingEstimate: null };
      data.backlog.tickets.push(made);
      update();
      return { id: made.id, key: made.key };
    },
    burndown: async (sprintId): Promise<SprintBurndown> => burndownFixture(sprintId),
    velocity: async (): Promise<Velocity> => velocityFixture(),
    report: async (sprintId): Promise<SprintReport> => ({
      sprint: { ...(data.sprints[0] ?? section(sprintId, 'Checkout Sprint 1', 'active', [])) },
      statistic: { statistic: 'originalEstimate' },
      completed: [
        {
          id: 2,
          key: 'CHK-2',
          summary: 'Show the order total',
          status: { id: 4, name: 'Closed' },
          addedAfterStart: false,
          estimateAtEntry: 2 * HOUR,
          estimate: 2 * HOUR,
          estimateChanged: false,
        },
      ],
      notCompleted: [
        {
          id: 1,
          key: 'CHK-1',
          summary: 'Accept card payments',
          status: { id: 1, name: 'New' },
          addedAfterStart: false,
          estimateAtEntry: 3 * HOUR,
          estimate: 5 * HOUR,
          estimateChanged: true,
        },
        {
          id: 6,
          key: 'CHK-6',
          summary: 'Refunds',
          status: { id: 1, name: 'New' },
          addedAfterStart: true,
          estimateAtEntry: 1 * HOUR,
          estimate: 1 * HOUR,
          estimateChanged: false,
        },
      ],
      removed: [],
      totals: {
        committed: 5 * HOUR,
        added: 1 * HOUR,
        removed: 0,
        completed: 2 * HOUR,
        notCompleted: 6 * HOUR,
        estimateChange: 2 * HOUR,
        remaining: 6 * HOUR,
      },
    }),
  };
}

/** A two-week sprint, eight days in: done on days 2, 4 and 7, an hour added on day 5. */
export function burndownFixture(sprintId = 11): SprintBurndown {
  const dates = [
    '2026-10-26',
    '2026-10-27',
    '2026-10-28',
    '2026-10-29',
    '2026-10-30',
    '2026-10-31',
    '2026-11-01',
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
  ];
  const remaining = [8, 6, 6, 4, 5, 5, 3, 3];
  const completed = [0, 2, 2, 4, 4, 4, 6, 6];
  return {
    sprint: section(sprintId, 'Checkout Sprint 1', 'active', []),
    statistic: { statistic: 'originalEstimate' },
    burnRemaining: false,
    timeZone: 'UTC',
    dates,
    start: { at: '2026-10-26T09:00:00Z', remaining: 8 * HOUR, scope: 8 * HOUR },
    guideline: {
      from: { at: '2026-10-26T09:00:00Z', date: dates[0] as string, value: 8 * HOUR },
      to: { at: '2026-11-04T09:00:00Z', date: dates[9] as string, value: 0 },
    },
    days: remaining.map((r, i) => ({
      date: dates[i] as string,
      remaining: r * HOUR,
      completed: (completed[i] ?? 0) * HOUR,
      scope: (r + (completed[i] ?? 0)) * HOUR,
    })),
    end: { at: '2026-11-02T12:00:00Z', remaining: 3 * HOUR, scope: 9 * HOUR, completed: 6 * HOUR },
  };
}

/** Three closed sprints of the board. */
export function velocityFixture(): Velocity {
  const sprint = (id: number, name: string, committed: number, completed: number) => ({
    ...section(id, name, 'future', []),
    state: 'closed' as const,
    committed: committed * HOUR,
    completed: completed * HOUR,
  });
  return {
    statistic: { statistic: 'originalEstimate' },
    sprints: [
      sprint(8, 'Checkout Sprint 8', 12, 10),
      sprint(9, 'Checkout Sprint 9', 10, 10),
      sprint(10, 'Checkout Sprint 10', 14, 9),
    ],
    average: (29 / 3) * HOUR,
  };
}
