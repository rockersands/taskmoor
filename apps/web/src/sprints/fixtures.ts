import type {
  Backlog,
  BacklogTicket,
  CompleteTarget,
  SprintClient,
  SprintReport,
  SprintSection,
} from './client';

/**
 * An in-memory Scrum board backlog for stories and tests (M1-044): one active sprint, one
 * planned sprint and the backlog, estimates in hours. Moves, starts and completions change it
 * as the server would, without scope-change history.
 */
const HOUR = 3600;
const ticket = (id: number, summary: string, hours: number, done = false): BacklogTicket => ({
  id,
  key: `CHK-${id}`,
  summary,
  type: 'Task',
  status: done ? { id: 4, name: 'Closed' } : { id: 1, name: 'New' },
  done,
  estimate: hours * HOUR,
  remainingEstimate: done ? 0 : hours * HOUR,
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
  });
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
