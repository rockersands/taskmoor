import { api } from '../api/client';

/** A ticket as search lists it (`GET /api/v1/search`). */
export interface SearchTicket {
  id: number;
  key: string;
  summary: string;
  status: { name: string; stage: 'new' | 'active' | 'closed' };
  ticketType: { name: string };
  assignee: { name: string } | null;
  updatedAt: string;
}

export interface SearchPage {
  tickets: SearchTicket[];
  next: string | null;
  total?: { count: number; exact: boolean };
}

/** What the backend says of a query before it runs (`GET /api/v1/search/check`). */
export type CheckResult =
  | { ok: true }
  | {
      ok: false;
      error: {
        message: string;
        position: number;
        length: number;
        expected?: string[];
      };
    };

/** The endpoints the search page uses. Stories and tests pass their own. */
export interface SearchClient {
  search: (q: string, cursor?: string) => Promise<SearchPage>;
  check: (q: string) => Promise<CheckResult>;
  tracks: () => Promise<{ key: string; name: string }[]>;
  /** Custom fields the person may see, for suggestions. */
  fields: () => Promise<{ id: number; name: string }[]>;
}

export const searchClient: SearchClient = {
  search: (q, cursor) =>
    api<SearchPage>('/search', {
      method: 'POST',
      body: { q, limit: 50, ...(cursor ? { cursor } : {}) },
    }),
  check: (q) => api<CheckResult>(`/search/check?q=${encodeURIComponent(q)}`),
  tracks: async () =>
    (await api<{ tracks: { key: string; name: string }[] }>('/tracks?limit=200')).tracks,
  fields: async () =>
    (await api<{ fields: { id: number; name: string }[] }>('/fields')).fields.map((f) => ({
      id: f.id,
      name: f.name,
    })),
};
