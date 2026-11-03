import { fromMarkdown } from '@taskmoor/richtext';
import { ApiError } from '../../api/client';
import type {
  HistoryEntry,
  Priority,
  TicketClient,
  TicketDetails,
  TicketEdit,
  TicketInfo,
  TimeEntry,
  Transition,
} from './client';

export const ADA = { id: 1, name: 'Ada Lovelace' };
export const GRACE = { id: 2, name: 'Grace Hopper' };

/** SHOP-41 as the API shows it. */
export const SHOP_41: TicketDetails = {
  id: 41,
  key: 'SHOP-41',
  track: { id: 3, key: 'SHOP', name: 'Shop' },
  ticketType: { id: 5, name: 'Bug' },
  parent: { id: 40, key: 'SHOP-40', summary: 'Card payments' },
  status: { id: 2, name: 'Active', stage: 'active' },
  summary: 'Checkout fails for expired cards',
  description: fromMarkdown('Paying with an **expired card** shows no message.\n'),
  assignee: GRACE,
  requester: ADA,
  creator: ADA,
  startDate: '2026-10-20',
  dueDate: '2026-11-02',
  priority: { id: 2, name: 'High' },
  closeReason: null,
  visibilityLevel: null,
  labels: ['payments', 'checkout'],
  targetReleases: [{ id: 9, name: '2.4' }],
  foundInReleases: [],
  areas: [{ id: 4, name: 'Payments' }],
  followerCount: 2,
  voteCount: 1,
  timeTracking: { originalEstimate: 4 * 3600, remainingEstimate: 2 * 3600, timeSpent: 2 * 3600 },
  version: 7,
  createdAt: '2026-10-20T09:00:00Z',
  updatedAt: '2026-10-21T15:30:00Z',
};

/** SHOP-41 for a member who may change its labels, due date and Points, and nothing else. */
export const SHOP_41_SOME_FIELDS: TicketDetails = {
  ...SHOP_41,
  mayEdit: true,
  editableFields: ['labels', 'dueDate', 'cf[31]'],
};

export const TRANSITIONS: Transition[] = [
  { id: 2, name: 'Send to review', to: { id: 3, name: 'In review', stage: 'active' }, layout: [] },
  {
    id: 4,
    name: 'Close',
    to: { id: 4, name: 'Closed', stage: 'closed' },
    layout: ['close-reason'],
  },
];

export const HISTORY: HistoryEntry[] = [
  {
    id: '12',
    at: '2026-10-21T15:30:00Z',
    actor: GRACE,
    field: 'status',
    from: { value: '1', display: 'New' },
    to: { value: '2', display: 'Active' },
    transitionId: 1,
  },
  {
    id: '11',
    at: '2026-10-21T15:00:00Z',
    actor: ADA,
    field: 'priority',
    from: { value: null, display: null },
    to: { value: '2', display: 'High' },
    transitionId: null,
  },
];

export const TIME: TimeEntry[] = [
  {
    id: 31,
    author: GRACE,
    startedAt: '2026-10-21T13:00:00Z',
    duration: 2 * 3600,
    description: 'Reproduced and traced',
    visibility: null,
  },
];

/** SHOP-41's info fields: answered by Grace, in progress twice. */
export const INFO: TicketInfo = {
  firstResponse: '2026-10-20T09:30:00Z',
  lastComment: '2026-10-21T16:05:00Z',
  daysSinceLastComment: 1,
  participants: [ADA, GRACE],
  timeInStatus: [
    { status: { id: 1, name: 'To do' }, seconds: 5400, visits: 1 },
    { status: { id: 2, name: 'In progress' }, seconds: 2 * 86400 + 4 * 3600, visits: 2 },
    { status: { id: 3, name: 'In review' }, seconds: 40, visits: 1 },
  ],
};

export const PRIORITIES: Priority[] = [
  { id: 1, name: 'Highest' },
  { id: 2, name: 'High' },
  { id: 3, name: 'Medium' },
];

export interface FakeTicketClient extends TicketClient {
  calls: { action: string; args: unknown[] }[];
}

/** An in-memory backend for stories and tests: it answers as the API would. */
export function fakeTicketClient(
  start: { ticket?: TicketDetails; transitions?: Transition[]; missing?: boolean } = {},
): FakeTicketClient {
  let ticket = structuredClone(start.ticket ?? SHOP_41);
  const history = structuredClone(HISTORY);
  const time = structuredClone(TIME);
  const follow = { count: 2, mine: false };
  const votes = { count: 1, mine: false };
  const calls: FakeTicketClient['calls'] = [];
  const at = '2026-10-22T10:00:00Z';
  const record = (field: string, from: string | null, to: string | null) =>
    history.unshift({
      id: String(100 + history.length),
      at,
      actor: ADA,
      field,
      from: { value: from, display: from },
      to: { value: to, display: to },
      transitionId: null,
    });
  return {
    calls,
    get: async (key) => {
      calls.push({ action: 'get', args: [key] });
      if (start.missing) throw new ApiError(404, { error: 'not_found' });
      return structuredClone(ticket);
    },
    edit: async (id, change: TicketEdit) => {
      calls.push({ action: 'edit', args: [id, change] });
      const next = { ...ticket };
      if (change.summary !== undefined) {
        record('summary', ticket.summary, change.summary);
        next.summary = change.summary;
      }
      if (change.fields !== undefined) next.fields = { ...ticket.fields, ...change.fields };
      if (change.assigneeId !== undefined) {
        next.assignee =
          change.assigneeId === null ? null : change.assigneeId === ADA.id ? ADA : GRACE;
        record('assignee', ticket.assignee?.name ?? null, next.assignee?.name ?? null);
      }
      if (change.priorityId !== undefined) {
        next.priority = PRIORITIES.find((p) => p.id === change.priorityId) ?? null;
        record('priority', ticket.priority?.name ?? null, next.priority?.name ?? null);
      }
      if (change.labels !== undefined) next.labels = change.labels;
      if (change.dueDate !== undefined) next.dueDate = change.dueDate;
      if (change.startDate !== undefined) next.startDate = change.startDate;
      ticket = { ...next, version: ticket.version + 1, updatedAt: at };
      return structuredClone(ticket);
    },
    transitions: async () => structuredClone(start.transitions ?? TRANSITIONS),
    transition: async (id, transitionId, fields) => {
      calls.push({ action: 'transition', args: [id, transitionId, fields ?? {}] });
      const to = (start.transitions ?? TRANSITIONS).find((tr) => tr.id === transitionId);
      if (!to) throw new ApiError(409, { error: 'transition_unavailable' });
      record('status', ticket.status.name, to.to.name);
      ticket = {
        ...ticket,
        status: {
          id: to.to.id,
          name: to.to.name,
          stage: to.to.stage as 'new' | 'active' | 'closed',
        },
        closeReason: fields?.['close-reason'] ? { id: 1, name: 'Done' } : ticket.closeReason,
        version: ticket.version + 1,
      };
      return structuredClone(ticket);
    },
    following: async () => ({ ...follow }),
    follow: async (_id, on) => {
      calls.push({ action: 'follow', args: [on] });
      if (on !== follow.mine) follow.count += on ? 1 : -1;
      follow.mine = on;
    },
    votes: async () => ({ ...votes }),
    vote: async (_id, on) => {
      calls.push({ action: 'vote', args: [on] });
      if (on !== votes.mine) votes.count += on ? 1 : -1;
      votes.mine = on;
    },
    history: async () => ({ changes: structuredClone(history), next: null }),
    timeEntries: async () => structuredClone(time),
    logTime: async (_id, entry) => {
      calls.push({ action: 'logTime', args: [entry] });
      const hours = Number.parseFloat(entry.duration);
      if (!Number.isFinite(hours)) {
        throw new ApiError(400, { error: 'invalid_fields', fields: { duration: 'invalid' } });
      }
      const made: TimeEntry = {
        id: 40 + time.length,
        author: ADA,
        startedAt: at,
        duration: hours * 3600,
        description: entry.description,
        visibility: null,
      };
      time.push(made);
      return structuredClone(made);
    },
    links: async () => ({
      links: [
        {
          id: 1,
          type: { id: 1, name: 'Blocks' },
          phrase: 'is blocked by',
          ticket: { id: 39, key: 'SHOP-39', summary: 'Card validation service', closed: false },
        },
      ],
      webLinks: [],
    }),
    info: async () => structuredClone(INFO),
    priorities: async () => structuredClone(PRIORITIES),
    numberFields: async () => [{ id: 31, name: 'Points', locked: false }],
    closeReasons: async () => [
      { id: 1, name: 'Done' },
      { id: 2, name: "Won't do" },
    ],
  };
}
