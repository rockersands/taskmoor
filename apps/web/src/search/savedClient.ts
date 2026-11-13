import { api } from '../api/client';

/** Who a saved search is shared with (QRY-011); none is private. */
export type SavedSearchShare =
  | { scope: 'user'; userId: number; userName?: string }
  | { scope: 'group'; groupId: number; groupName?: string }
  | { scope: 'track'; trackId: number; trackKey?: string; roleId?: number | null }
  | { scope: 'any_user' }
  | { scope: 'public' };

/** A saved search as `GET /api/v1/saved-searches` lists it (M1-063). */
export interface SavedSearch {
  id: number;
  name: string;
  description: string;
  query: string;
  columns: string[] | null;
  /** Why a query an import brought does not run here (M1-094); absent or null otherwise. */
  importProblem?: string | null;
  owner: { id: number; name: string };
  shares: SavedSearchShare[];
  starred: boolean;
  editable: boolean;
  version: number;
}

export interface SubscriptionInput {
  schedule: 'daily' | 'weekly' | 'monthly';
  hour: number;
  weekday?: number;
  dayOfMonth?: number;
  onlyIfResults: boolean;
}

/** The saved-search endpoints the search page uses. Stories and tests pass their own. */
export interface SavedSearchClient {
  list: () => Promise<SavedSearch[]>;
  get: (id: number) => Promise<SavedSearch>;
  create: (input: {
    name: string;
    query: string;
    columns: string[] | null;
    shares?: SavedSearchShare[];
  }) => Promise<SavedSearch>;
  update: (
    id: number,
    change: { query?: string; columns?: string[] | null; shares?: SavedSearchShare[] },
  ) => Promise<SavedSearch>;
  star: (id: number, on: boolean) => Promise<void>;
  subscribe: (id: number, input: SubscriptionInput) => Promise<{ nextRunAt: string }>;
  /** Whether this person gets the saved search by email (PL-32); unknown without it. */
  subscribedTo?: (id: number, userId: number) => Promise<boolean>;
}

/** A share as the API takes it back: without the names it shows. */
const bare = (s: SavedSearchShare): SavedSearchShare =>
  s.scope === 'user'
    ? { scope: s.scope, userId: s.userId }
    : s.scope === 'group'
      ? { scope: s.scope, groupId: s.groupId }
      : s.scope === 'track'
        ? { scope: s.scope, trackId: s.trackId, roleId: s.roleId ?? null }
        : { scope: s.scope };

export const savedSearchClient: SavedSearchClient = {
  list: async () => (await api<{ savedSearches: SavedSearch[] }>('/saved-searches')).savedSearches,
  get: async (id) => (await api<{ savedSearch: SavedSearch }>(`/saved-searches/${id}`)).savedSearch,
  create: async (input) =>
    (
      await api<{ savedSearch: SavedSearch }>('/saved-searches', {
        method: 'POST',
        body: { ...input, ...(input.shares ? { shares: input.shares.map(bare) } : {}) },
      })
    ).savedSearch,
  update: async (id, change) =>
    (
      await api<{ savedSearch: SavedSearch }>(`/saved-searches/${id}`, {
        method: 'PATCH',
        body: { ...change, ...(change.shares ? { shares: change.shares.map(bare) } : {}) },
      })
    ).savedSearch,
  star: async (id, on) => {
    await api(`/saved-searches/${id}/star`, { method: on ? 'PUT' : 'DELETE' });
  },
  subscribe: async (id, input) =>
    (
      await api<{ subscription: { nextRunAt: string } }>(`/saved-searches/${id}/subscriptions`, {
        method: 'POST',
        body: input,
      })
    ).subscription,
  subscribedTo: async (id, userId) =>
    (
      await api<{ subscriptions: { recipient: { userId?: number } }[] }>(
        `/saved-searches/${id}/subscriptions`,
      )
    ).subscriptions.some((s) => s.recipient.userId === userId),
};

/** The saved search in the address, `#/search?savedSearch=12`, or null. */
export function savedSearchFromHash(hash: string): number | null {
  const query = hash.split('?')[1] ?? '';
  const value = new URLSearchParams(query).get('savedSearch');
  return value && /^\d{1,10}$/.test(value) ? Number(value) : null;
}
