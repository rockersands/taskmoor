import { api } from '../api/client';
import type { Board } from '../boards/client';

/** One number of a track's summary and the query that finds its tickets (M1-064). */
export interface SummaryItem {
  id: string;
  /** A stage, priority, type or person; null for none. */
  name: string | null;
  query: string;
  count: number;
  /** False when the count reached the search's cap. */
  exact: boolean;
}

export interface TrackSummary {
  track: { id: number; key: string; name: string };
  overview: SummaryItem[];
  stages: SummaryItem[];
  priorities: SummaryItem[];
  types: SummaryItem[];
  assignees: SummaryItem[];
}

export interface TrackClient {
  summary(key: string): Promise<TrackSummary>;
  /** The tracks the person can see. */
  list(): Promise<TrackListItem[]>;
  /** The track's one board, made the first time anyone opens it (ADR-116). */
  board(key: string): Promise<Board>;
  /** The files and web links on the track's tickets the person may see. */
  files(key: string): Promise<TrackFiles>;
}

export interface TrackFiles {
  attachments: {
    id: number;
    name: string;
    size: number;
    createdAt: string;
    ticket: { key: string; summary: string };
  }[];
  links: { id: number; url: string; title: string; ticket: { key: string; summary: string } }[];
  truncated: boolean;
}

/** A track in the directory and the sidebar. */
export interface TrackListItem {
  key: string;
  name: string;
  owner: { id: number; name: string } | null;
}

export const trackClient: TrackClient = {
  summary: (key) => api<TrackSummary>(`/tracks/${encodeURIComponent(key)}/summary`),
  list: async () =>
    (await api<{ tracks: TrackListItem[] }>('/tracks?limit=200')).tracks.filter((t) => t.key),
  files: (key) => api<TrackFiles>(`/tracks/${encodeURIComponent(key)}/files`),
  board: async (key) =>
    (await api<{ board: Board }>(`/tracks/${encodeURIComponent(key)}/board`)).board,
};
