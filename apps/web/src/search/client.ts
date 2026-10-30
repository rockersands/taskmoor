import { API_BASE, api } from '../api/client';

interface Named {
  id?: number;
  name: string;
}

/**
 * A ticket as search lists it (`GET /api/v1/search`, the whole ticket view): the properties
 * the results list shows by default are typed; the other columns read the rest by name.
 */
export interface SearchTicket {
  id: number;
  key: string;
  summary: string;
  status: { name: string; stage: 'new' | 'active' | 'closed' };
  ticketType: { name: string };
  assignee: Named | null;
  priority?: Named | null;
  labels?: string[];
  /** Custom field values by field id, as REST shows them. */
  fields?: Record<string, unknown>;
  version?: number;
  updatedAt: string;
  [property: string]: unknown;
}

export interface SearchPage {
  tickets: SearchTicket[];
  next: string | null;
  /**
   * Exact up to 10,000; beyond, an estimate within 10% (`approximate`), or a lower bound when
   * neither is set.
   */
  total?: { count: number; exact: boolean; approximate?: boolean };
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

/** A custom field the person may see, for suggestions and columns. */
export interface SearchField {
  id: number;
  name: string;
  type: string;
  multiple?: boolean;
}

/** The endpoints the search page uses. Stories and tests pass their own. */
export interface SearchClient {
  search: (q: string, cursor?: string) => Promise<SearchPage>;
  check: (q: string) => Promise<CheckResult>;
  tracks: () => Promise<{ key: string; name: string }[]>;
  /** Custom fields the person may see, for suggestions and columns. */
  fields: () => Promise<SearchField[]>;
  /** Changes a ticket through the ticket route (M1-042, inline edit); the ticket as it is now. */
  edit: (id: number, change: object) => Promise<SearchTicket>;
  /** Priorities, for editing a priority cell. */
  priorities: () => Promise<{ id: number; name: string }[]>;
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
    (await api<{ fields: SearchField[] }>('/fields')).fields.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      multiple: f.multiple ?? false,
    })),
  edit: async (id, change) =>
    (await api<{ ticket: SearchTicket }>(`/tickets/${id}`, { method: 'PATCH', body: change }))
      .ticket,
  priorities: async () =>
    (await api<{ priorities: { id: number; name: string }[] }>('/priorities')).priorities,
};

/** The address of an export of a query's results in the given columns (QRY-015). */
export function exportUrl(q: string, format: 'csv' | 'json', columns: readonly string[]): string {
  const params = new URLSearchParams({ q, format, columns: ['key', ...columns].join(',') });
  return `${API_BASE}/search/export?${params}`;
}
