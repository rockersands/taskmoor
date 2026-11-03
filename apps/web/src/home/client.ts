import { api } from '../api/client';

/** A ticket as the home page lists it. */
export interface HomeTicket {
  id: number;
  key: string;
  summary: string;
  ticketType?: { name: string; icon?: string | null };
  priority?: { name: string; level?: number } | null;
  status: { name: string; stage: 'new' | 'active' | 'closed' };
  track: { key: string; name: string };
  updatedAt: string;
}

/** A track as the home page lists it (ADR-114). */
export interface HomeTrack {
  id: number;
  key: string;
  name: string;
  type: string;
}

/**
 * The tracks the person belongs to (T-194): a role given to them or to a group they are in, a
 * track they own, or one their team works on. The server decides; a track they only see, open to
 * everyone or as an administrator, is not among them. A separate call, so each list keeps
 * loading on its own.
 */
export const HOME_TRACKS_PATH = '/tracks?member=true&limit=500';

export const homeTracks = async (): Promise<HomeTrack[]> => {
  const answer = await api<{ tracks?: HomeTrack[] }>(HOME_TRACKS_PATH);
  return Array.isArray(answer.tracks) ? answer.tracks : [];
};

/** The endpoints the home page uses. Stories and tests pass their own. */
export interface HomeClient {
  assigned: () => Promise<HomeTicket[]>;
  recent: () => Promise<HomeTicket[]>;
  followed: () => Promise<HomeTicket[]>;
}

/** Open tickets assigned to the person, the most recently changed first (AGL-019). */
export const ASSIGNED_QUERY = 'assignee = currentUser() AND stage != closed ORDER BY updated DESC';

/** A list from an answer; an answer without one reads as empty. */
const listOf = (answer: { tickets?: HomeTicket[] }) =>
  Array.isArray(answer.tickets) ? answer.tickets : [];

export const homeClient: HomeClient = {
  assigned: async () =>
    listOf(
      await api<{ tickets?: HomeTicket[] }>(
        `/search?q=${encodeURIComponent(ASSIGNED_QUERY)}&limit=20&count=false`,
      ),
    ),
  recent: async () => listOf(await api<{ tickets?: HomeTicket[] }>('/me/recent-tickets?limit=20')),
  followed: async () =>
    listOf(await api<{ tickets?: HomeTicket[] }>('/me/followed-tickets?limit=20')),
};
