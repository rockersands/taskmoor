import type { SearchClient, SearchTicket } from './client';

const ticket = (id: number, key: string, summary: string, stage: 'new' | 'active' | 'closed') =>
  ({
    id,
    key,
    summary,
    status: { name: stage === 'new' ? 'New' : stage === 'active' ? 'Active' : 'Closed', stage },
    ticketType: { name: 'Bug' },
    assignee: stage === 'new' ? null : { name: 'Kalo Moana' },
    updatedAt: '2026-10-29T08:00:00Z',
  }) satisfies SearchTicket;

export const TICKETS: SearchTicket[] = [
  ticket(41, 'SHOP-41', 'Refunds fail for expired cards', 'active'),
  ticket(44, 'SHOP-44', 'Receipts show the wrong currency', 'new'),
  ticket(12, 'OPS-12', 'Rotate the payment keys', 'closed'),
];

export interface FakeSearchClient extends SearchClient {
  queries: string[];
}

/**
 * An in-memory backend: a query naming `nope` is refused at that word, as the backend's check
 * would; results come two at a time.
 */
export function fakeSearchClient(): FakeSearchClient {
  const queries: string[] = [];
  return {
    queries,
    search: async (q, cursor) => {
      queries.push(q);
      const from = cursor ? Number(cursor) : 0;
      const tickets = TICKETS.slice(from, from + 2);
      return {
        tickets,
        next: from + 2 < TICKETS.length ? String(from + 2) : null,
        ...(cursor ? {} : { total: { count: TICKETS.length, exact: true } }),
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
    fields: async () => [{ id: 40, name: 'Customer' }],
  };
}
