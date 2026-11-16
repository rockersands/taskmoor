import type { CsvSeparator } from '@taskmoor/webconfig';
import { API_BASE, api } from '../api/client';
import { everyTrack } from '../api/tracks';
import { loadSubticketProgress, type SubticketProgress } from '../tickets/tools/client';
import type { ChoiceField } from './basic';

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

/** A track the person sees. */
export interface SearchTrack {
  id?: number;
  key: string;
  name: string;
}

/** At most this many tracks are asked for their releases and areas, one request each. */
const MAX_OPTION_TRACKS = 20;

/** The endpoints the search page uses. Stories and tests pass their own. */
export interface SearchClient {
  search: (q: string, cursor?: string) => Promise<SearchPage>;
  /** How far along the tickets under these results are (CORE-032); left out, rows show none. */
  subticketProgress?: (ids: number[]) => Promise<Record<string, SubticketProgress>>;
  check: (q: string) => Promise<CheckResult>;
  tracks: () => Promise<SearchTrack[]>;
  /**
   * The values the basic mode offers for a field: what the person may see, from the routes the
   * rest of the app uses. `typed` narrows those read as someone types; `chosen` are the tracks
   * picked on the form. Null means there are too many tracks to ask: pick some first.
   */
  choiceOptions: (
    field: ChoiceField,
    scope: { typed: string; chosen: readonly SearchTrack[]; all: readonly SearchTrack[] },
  ) => Promise<string[] | null>;
  /** Custom fields the person may see, for suggestions and columns. */
  fields: () => Promise<SearchField[]>;
  /** Changes a ticket through the ticket route (M1-042, inline edit); the ticket as it is now. */
  edit: (id: number, change: object) => Promise<SearchTicket>;
  /** Priorities, for editing a priority cell. */
  priorities: () => Promise<{ id: number; name: string; level?: number }[]>;
}

const uniqueNames = (lists: readonly { name: string }[][]) => [
  ...new Set(lists.flat().map((item) => item.name)),
];

async function choiceOptions(
  field: ChoiceField,
  { typed, chosen, all }: Parameters<SearchClient['choiceOptions']>[1],
): Promise<string[] | null> {
  const withIds = (tracks: readonly SearchTrack[]) =>
    tracks.flatMap((track) => (track.id === undefined ? [] : [track.id]));
  switch (field) {
    case 'priority':
      return (await api<{ priorities: { name: string }[] }>('/priorities')).priorities.map(
        (p) => p.name,
      );
    case 'type': {
      // The shared types, and each chosen track's own.
      const ids = withIds(chosen);
      const paths =
        ids.length > 0 ? ids.map((id) => `/ticket-types?trackId=${id}`) : ['/ticket-types'];
      const lists = await Promise.all(
        paths.map(async (p) => (await api<{ ticketTypes: { name: string }[] }>(p)).ticketTypes),
      );
      return uniqueNames(lists);
    }
    case 'labels': {
      const q = encodeURIComponent(typed.trim());
      return (await api<{ labels: string[] }>(`/labels?limit=50&q=${q}`)).labels;
    }
    case 'requester':
    case 'creator': {
      // Anyone the person may browse; a track is only what the route needs to ask.
      const track = chosen[0] ?? all[0];
      if (!track) return [];
      const q = encodeURIComponent(typed.trim());
      const path = `/people/mentionable?track=${encodeURIComponent(track.key)}&limit=20&q=${q}`;
      return uniqueNames([(await api<{ people: { name: string }[] }>(path)).people]);
    }
    case 'targetRelease':
    case 'foundInRelease':
    case 'area': {
      const scope = chosen.length > 0 ? chosen : all;
      if (scope.length > MAX_OPTION_TRACKS) return null;
      const lists = await Promise.all(
        withIds(scope).map(async (id) =>
          field === 'area'
            ? (await api<{ areas: { name: string }[] }>(`/tracks/${id}/areas`)).areas
            : (await api<{ releases: { name: string }[] }>(`/tracks/${id}/releases`)).releases,
        ),
      );
      return uniqueNames(lists);
    }
  }
}

export const searchClient: SearchClient = {
  subticketProgress: loadSubticketProgress,
  search: (q, cursor) =>
    api<SearchPage>('/search', {
      method: 'POST',
      body: { q, limit: 50, ...(cursor ? { cursor } : {}) },
    }),
  check: (q) => api<CheckResult>(`/search/check?q=${encodeURIComponent(q)}`),
  tracks: () => everyTrack<SearchTrack>(),
  choiceOptions,
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
    (await api<{ priorities: { id: number; name: string; level?: number }[] }>('/priorities'))
      .priorities,
};

/**
 * The address of an export of a query's results in the given columns (QRY-015). A CSV file in
 * the semicolon style says so; the comma is the server's default, so its address is as before
 * (T-263).
 */
export function exportUrl(
  q: string,
  format: 'csv' | 'json',
  columns: readonly string[],
  separator: CsvSeparator = 'comma',
): string {
  const params = new URLSearchParams({ q, format, columns: ['key', ...columns].join(',') });
  if (format === 'csv' && separator === 'semicolon') params.set('separator', separator);
  return `${API_BASE}/search/export?${params}`;
}
