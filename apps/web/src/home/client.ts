import { api } from '../api/client';
import { recentTracks } from '../tracks/recentTracks';

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
 * loading on its own. This is the first page, by key.
 */
export const HOME_TRACKS_PATH = '/tracks?member=true&limit=500';

/** How many keys the track list takes in `keys`; this browser keeps fewer. */
const KEYS_ASKED = 50;
/** A key the track list accepts (the import rule): anything else stored here is left out. */
const TRACK_KEY = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;

/**
 * Those of the tracks opened lately in this browser that the person belongs to, however late
 * their keys sort among the person's tracks: the first page alone may not hold them.
 */
export const recentHomeTracksPath = (keys: readonly string[]) =>
  `/tracks?member=true&keys=${keys.join(',')}`;

const tracksOf = (answer: { tracks?: HomeTrack[] }) =>
  Array.isArray(answer.tracks) ? answer.tracks : [];

/**
 * Home's tracks: those opened lately that the person belongs to, asked for by key, and the first
 * page of the rest, each once. The page sorts them.
 */
export const homeTracks = async (
  recent: readonly string[] = recentTracks(),
): Promise<HomeTrack[]> => {
  const keys = [...new Set(recent.filter((key) => TRACK_KEY.test(key)))].slice(0, KEYS_ASKED);
  const [opened, first] = await Promise.all([
    keys.length > 0
      ? api<{ tracks?: HomeTrack[] }>(recentHomeTracksPath(keys))
      : Promise.resolve({}),
    api<{ tracks?: HomeTrack[] }>(HOME_TRACKS_PATH),
  ]);
  const seen = new Set<number>();
  const all: HomeTrack[] = [];
  for (const track of [...tracksOf(opened), ...tracksOf(first)]) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    all.push(track);
  }
  return all;
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
