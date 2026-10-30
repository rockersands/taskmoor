import { ApiError, api } from '../api/client';

/** A ticket on a track's timeline (M1-048; AGL-015). Dates are calendar days (YYYY-MM-DD). */
export interface TimelineItem {
  id: number;
  key: string;
  summary: string;
  type: string;
  level: { rank: number; kind: string };
  parentId: number | null;
  status: { name: string; stage: 'new' | 'active' | 'closed' };
  start: string | null;
  due: string | null;
  /** Where the dates come from: the ticket itself or its sprint; null for none. */
  dated: 'own' | 'sprint' | null;
  /** For a ticket with children: their span and how many of them are closed. */
  rollup: { start: string | null; due: string | null; total: number; closed: number } | null;
}

/** `GET /api/v1/tracks/:keyOrId/timeline`. */
export interface Timeline {
  track: { id: number; key: string; name: string };
  items: TimelineItem[];
  /** Blocking links between listed tickets: `from` blocks `to`. */
  links: { from: number; to: number }[];
  markers: {
    sprints: { id: number; name: string; state: string; start: string; end: string }[];
    releases: { id: number; name: string; date: string; shipped: boolean }[];
  };
  truncated: boolean;
}

export type Rescheduled = { ok: true } | { ok: false; code: string };

export interface TimelineClient {
  timeline(trackKey: string): Promise<Timeline>;
  /** New start and due days for a ticket (null clears one), through the ticket route. */
  reschedule(
    ticketKey: string,
    dates: { startDate: string | null; dueDate: string | null },
  ): Promise<Rescheduled>;
}

export const timelineClient: TimelineClient = {
  timeline: (trackKey) => api<Timeline>(`/tracks/${encodeURIComponent(trackKey)}/timeline`),
  reschedule: async (ticketKey, dates) => {
    try {
      await api(`/tickets/${encodeURIComponent(ticketKey)}`, { method: 'PATCH', body: dates });
      return { ok: true };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { ok: false, code: error.code ?? String(error.status) };
    }
  },
};

/** Calendar days as whole numbers, so bars and drags add and subtract days exactly. */
export const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
};
export const isoDay = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);
