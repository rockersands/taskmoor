import { api } from '../api/client';

/** A ticket as the home page lists it. */
export interface HomeTicket {
  id: number;
  key: string;
  summary: string;
  status: { name: string; stage: 'new' | 'active' | 'closed' };
  track: { key: string; name: string };
  updatedAt: string;
}

/** The endpoints the home page uses. Stories and tests pass their own. */
export interface HomeClient {
  assigned: () => Promise<HomeTicket[]>;
  recent: () => Promise<HomeTicket[]>;
  followed: () => Promise<HomeTicket[]>;
}

/** Open tickets assigned to the person, the most recently changed first (AGL-019). */
export const ASSIGNED_QUERY = 'assignee = currentUser() AND stage != closed ORDER BY updated DESC';

export const homeClient: HomeClient = {
  assigned: async () =>
    (
      await api<{ tickets: HomeTicket[] }>(
        `/search?q=${encodeURIComponent(ASSIGNED_QUERY)}&limit=20&count=false`,
      )
    ).tickets,
  recent: async () => (await api<{ tickets: HomeTicket[] }>('/me/recent-tickets?limit=20')).tickets,
  followed: async () =>
    (await api<{ tickets: HomeTicket[] }>('/me/followed-tickets?limit=20')).tickets,
};
