import { ApiError, api } from '../api/client';
import { type DraftMark, type Refusal, refusalOf } from '../timeline/client';
import type { ReleaseMarker } from '../timeline/markers';

/** A ticket with a start or due day in the range shown (M1-049; AGL-017). */
export interface CalendarTicket {
  id: number;
  key: string;
  summary: string;
  type: string;
  stage: 'new' | 'active' | 'closed';
  start: string | null;
  due: string | null;
  /** On a plan read in a scenario: the ticket's drafts, its days above being the drafted ones. */
  draft?: DraftMark;
}

/** `GET /api/v1/tracks/:keyOrId/calendar?from=&to=`. */
export interface CalendarData {
  track: { id: number; key: string; name: string };
  tickets: CalendarTicket[];
  sprints: { id: number; name: string; state: string; start: string; end: string }[];
  releases: ReleaseMarker[];
  truncated: boolean;
}

export type Moved = { ok: true } | Refusal;

export interface CalendarClient {
  calendar(trackKey: string, from: string, to: string): Promise<CalendarData>;
  /** New days for a ticket through the ticket route; only the days given change. */
  move(
    ticketKey: string,
    days: { startDate?: string | null; dueDate?: string | null },
  ): Promise<Moved>;
}

export const calendarClient: CalendarClient = {
  calendar: (trackKey, from, to) =>
    api<CalendarData>(
      `/tracks/${encodeURIComponent(trackKey)}/calendar?${new URLSearchParams({ from, to }).toString()}`,
    ),
  move: async (ticketKey, days) => {
    try {
      await api(`/tickets/${encodeURIComponent(ticketKey)}`, { method: 'PATCH', body: days });
      return { ok: true };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return refusalOf(error);
    }
  },
};
