import { dayNumber, isoDay } from '../timeline/client';
import type { CalendarClient, CalendarData, CalendarTicket } from './client';

/**
 * A track's calendar in memory for stories and tests (M1-049): November 2026 with a ticket due
 * on the 10th that started on the 4th, one due on the 12th, one closed on the 3rd, a sprint from
 * the 9th to the 20th and a release on the 21st. Moves change the tickets as the server would;
 * `refuse` answers as for someone who may not schedule, and `more` adds tickets after these.
 */
export const calendarTicket = (
  id: number,
  summary: string,
  extra: Partial<CalendarTicket>,
): CalendarTicket => ({
  id,
  key: `CAL-${id}`,
  summary,
  type: 'Feature',
  stage: 'new',
  start: null,
  due: null,
  ...extra,
});

export function fakeCalendarClient(
  options: { refuse?: boolean; more?: CalendarTicket[] } = {},
): CalendarClient & { tickets: () => CalendarTicket[] } {
  let tickets: CalendarTicket[] = [
    calendarTicket(1, 'Build the site', { start: '2026-11-04', due: '2026-11-10' }),
    calendarTicket(2, 'Press kit', { due: '2026-11-12' }),
    calendarTicket(3, 'Book the venue', { due: '2026-11-03', stage: 'closed' }),
    ...(options.more ?? []),
  ];
  return {
    tickets: () => tickets,
    calendar: async (_key, from, to): Promise<CalendarData> => ({
      track: { id: 1, key: 'CAL', name: 'Launch' },
      tickets: structuredClone(
        tickets.filter((t) =>
          [t.start, t.due].some(
            (d) => d !== null && dayNumber(d) >= dayNumber(from) && dayNumber(d) <= dayNumber(to),
          ),
        ),
      ),
      sprints: [
        { id: 9, name: 'Launch Sprint 1', state: 'active', start: '2026-11-09', end: '2026-11-20' },
      ],
      releases: [{ id: 7, name: 'Launch', date: '2026-11-21', shipped: false }],
      truncated: false,
    }),
    move: async (key, days) => {
      if (options.refuse) return { ok: false, code: 'forbidden' };
      tickets = tickets.map((t) =>
        t.key === key
          ? {
              ...t,
              ...('startDate' in days ? { start: days.startDate ?? null } : {}),
              ...('dueDate' in days ? { due: days.dueDate ?? null } : {}),
            }
          : t,
      );
      return { ok: true };
    },
  };
}

/** A day of November 2026 as the grid shows it. */
export const novemberDay = (n: number) => isoDay(dayNumber('2026-11-01') + n - 1);
