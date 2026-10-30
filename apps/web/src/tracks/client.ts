import { api } from '../api/client';

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
}

export const trackClient: TrackClient = {
  summary: (key) => api<TrackSummary>(`/tracks/${encodeURIComponent(key)}/summary`),
};
