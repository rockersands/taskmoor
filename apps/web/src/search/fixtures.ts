import { ApiError } from '../api/client';
import type { SearchClient, SearchTicket } from './client';
import type { SavedSearch, SavedSearchClient, SubscriptionInput } from './savedClient';

const PRIORITIES = [
  { id: 1, name: 'High' },
  { id: 2, name: 'Medium' },
  { id: 3, name: 'Low' },
];

const ticket = (
  id: number,
  key: string,
  summary: string,
  stage: 'new' | 'active' | 'closed',
  extra: Partial<SearchTicket> = {},
) =>
  ({
    id,
    key,
    summary,
    status: { name: stage === 'new' ? 'New' : stage === 'active' ? 'Active' : 'Closed', stage },
    ticketType: { name: 'Bug' },
    assignee: stage === 'new' ? null : { id: 7, name: 'Kalo Moana' },
    priority: PRIORITIES[1] ?? null,
    labels: [],
    fields: {},
    version: 1,
    updatedAt: '2026-10-29T08:00:00Z',
    ...extra,
  }) satisfies SearchTicket;

/** A fresh copy each time, so one test's edits never reach another's. */
const tickets = (): SearchTicket[] => [
  ticket(41, 'SHOP-41', 'Refunds fail for expired cards', 'active', {
    labels: ['payments'],
    fields: { '40': 'Acme', '41': 3 },
  }),
  ticket(44, 'SHOP-44', 'Receipts show the wrong currency', 'new', {
    priority: PRIORITIES[0] ?? null,
  }),
  ticket(12, 'OPS-12', 'Rotate the payment keys', 'closed'),
];

export const TICKETS: SearchTicket[] = tickets();

export interface FakeSearchClient extends SearchClient {
  queries: string[];
  edits: { id: number; change: object }[];
}

/**
 * An in-memory backend: a query naming `nope` is refused at that word, as the backend's check
 * would; results come two at a time. Edits apply to the tickets, except that a closed ticket
 * is locked (as a status lock refuses it), an empty summary is invalid, and a ticket edited
 * with an old version is stale.
 */
export function fakeSearchClient(): FakeSearchClient {
  const queries: string[] = [];
  const edits: { id: number; change: object }[] = [];
  const all = tickets();
  return {
    queries,
    edits,
    search: async (q, cursor) => {
      queries.push(q);
      const from = cursor ? Number(cursor) : 0;
      return {
        tickets: all.slice(from, from + 2).map((t) => ({ ...t })),
        next: from + 2 < all.length ? String(from + 2) : null,
        ...(cursor ? {} : { total: { count: all.length, exact: true } }),
      };
    },
    check: async (q) => {
      const at = q.indexOf('nope');
      return at < 0
        ? { ok: true }
        : { ok: false, error: { message: 'There is no field "nope"', position: at, length: 4 } };
    },
    tracks: async () => [
      { key: 'SHOP', name: 'Shop' },
      { key: 'OPS', name: 'Operations' },
    ],
    fields: async () => [
      { id: 40, name: 'Customer', type: 'text' },
      { id: 41, name: 'Points', type: 'number' },
      { id: 42, name: 'Team', type: 'select' },
    ],
    priorities: async () => PRIORITIES,
    edit: async (id, change) => {
      edits.push({ id, change });
      const found = all.find((t) => t.id === id);
      if (!found) throw new ApiError(404, { error: 'not_found' });
      if (found.status.stage === 'closed') {
        throw new ApiError(403, {
          error: 'forbidden',
          permission: 'edit',
          locks: [
            {
              by: 'status',
              statusId: 3,
              statusName: 'Closed',
              allowed: [{ type: 'role', id: 1, name: 'Administrators' }],
            },
          ],
        });
      }
      const c = change as Record<string, unknown>;
      if (c.version !== undefined && c.version !== found.version) {
        throw new ApiError(409, { error: 'version_conflict' });
      }
      if (c.summary !== undefined && String(c.summary).trim() === '') {
        throw new ApiError(400, { error: 'invalid_fields', fields: { summary: 'required' } });
      }
      if (typeof c.summary === 'string') found.summary = c.summary;
      if ('priorityId' in c) found.priority = PRIORITIES.find((p) => p.id === c.priorityId) ?? null;
      if ('assigneeId' in c) {
        const people: Record<number, string> = { 2: 'Bo', 7: 'Kalo Moana' };
        found.assignee =
          c.assigneeId === null
            ? null
            : { id: c.assigneeId as number, name: people[c.assigneeId as number] ?? '?' };
      }
      if (Array.isArray(c.labels)) found.labels = c.labels as string[];
      if (c.fields) found.fields = { ...found.fields, ...(c.fields as Record<string, unknown>) };
      found.version = (found.version ?? 0) + 1;
      return { ...found };
    },
  };
}

/** Saved searches in memory for stories and tests (M1-063). */
export function fakeSavedSearchClient(
  start: SavedSearch[] = [
    {
      id: 1,
      name: 'My open work',
      description: '',
      query: 'assignee = currentUser() AND stage != closed',
      columns: null,
      owner: { id: 2, name: 'Mira Member' },
      shares: [],
      starred: true,
      editable: true,
      version: 1,
    },
    {
      id: 2,
      name: 'Shop releases',
      description: '',
      query: 'track = SHOP',
      columns: ['summary', 'status', 'priority'],
      owner: { id: 9, name: 'Ada Admin' },
      shares: [{ scope: 'any_user' }],
      starred: false,
      editable: false,
      version: 3,
    },
  ],
): SavedSearchClient & { saved: SavedSearch[]; subscriptions: SubscriptionInput[] } {
  const saved = start.map((s) => ({ ...s }));
  const subscriptions: SubscriptionInput[] = [];
  const find = (id: number) => {
    const found = saved.find((s) => s.id === id);
    if (!found) throw new ApiError(404, { error: 'not_found' });
    return found;
  };
  return {
    saved,
    subscriptions,
    list: async () => saved.map((s) => ({ ...s })),
    get: async (id) => ({ ...find(id) }),
    create: async (input) => {
      if (saved.some((s) => s.editable && s.name.toLowerCase() === input.name.toLowerCase())) {
        throw new ApiError(400, { error: 'invalid_fields', fields: { name: 'taken' } });
      }
      const next: SavedSearch = {
        id: Math.max(0, ...saved.map((s) => s.id)) + 1,
        name: input.name,
        description: '',
        query: input.query,
        columns: input.columns,
        owner: { id: 2, name: 'Mira Member' },
        shares: input.shares ?? [],
        starred: false,
        editable: true,
        version: 1,
      };
      saved.push(next);
      return { ...next };
    },
    update: async (id, change) => {
      const found = find(id);
      if (!found.editable) throw new ApiError(403, { error: 'forbidden' });
      Object.assign(found, change, { version: found.version + 1 });
      return { ...found };
    },
    star: async (id, on) => {
      find(id).starred = on;
    },
    subscribe: async (id, input) => {
      find(id);
      subscriptions.push(input);
      return { nextRunAt: '2026-10-30T08:00:00.000Z' };
    },
  };
}
