import { ApiError, api } from '../api/client';
import type { ReleaseMarker } from './markers';

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
  /**
   * Dependencies between listed tickets: `from` finishes first and `to` waits for it. On a plan,
   * also the link types it chose and whether both are in the same sprint (PLN-013).
   */
  links: { from: number; to: number; linkTypeId?: number; sameSprint?: boolean }[];
  markers: {
    sprints: { id: number; name: string; state: string; start: string; end: string }[];
    releases: ReleaseMarker[];
  };
  truncated: boolean;
}

/**
 * Why the ticket route refused new dates: its code, the permission it names, and whether a status
 * or field lock refused them (WF-007), which a missing permission does not.
 */
export interface Refusal {
  ok: false;
  code: string;
  permission?: string;
  locked?: boolean;
}

export type Rescheduled = { ok: true } | Refusal;

/** A refusal as the ticket route's answer says it. */
export function refusalOf(error: ApiError): Refusal {
  const body = (error.body ?? {}) as { permission?: unknown; locks?: unknown };
  return {
    ok: false,
    code: error.code ?? String(error.status),
    ...(typeof body.permission === 'string' ? { permission: body.permission } : {}),
    ...(Array.isArray(body.locks) ? { locked: true } : {}),
  };
}

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
      return refusalOf(error);
    }
  },
};

/** Calendar days as whole numbers, so bars and drags add and subtract days exactly. */
export const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
};
export const isoDay = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);
/**
 * The calendar day it is at `at` on the person's own clock, as `YYYY-MM-DD`. Start and due dates
 * are calendar days, so "today" is the local day, not UTC's: in the Americas UTC is already
 * tomorrow every evening, and the today line, the month first shown and a new date would be a
 * day ahead.
 */
export const localDay = (at: Date) =>
  `${String(at.getFullYear()).padStart(4, '0')}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
