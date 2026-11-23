import { type IntlShape, useIntl } from 'react-intl';
import { localDay } from '../timeline/client';

/**
 * A calendar day (`YYYY-MM-DD`: a start, due or release date) as people read it, in their
 * locale: 'Dec 1, 2026', '1 dic 2026' (NFR-006, T-240). It is read on UTC's clock because a
 * calendar day has no time of day: the viewer's own clock would show the day before in the
 * Americas. The one format for days everywhere a person sees one, never the raw `2026-12-01`.
 */
export const dayText = (intl: IntlShape, day: string) =>
  intl.formatDate(`${day}T00:00:00Z`, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

/**
 * A moment (an instant with a time of day: when a ticket was created, a custom date-and-time
 * field's value) as people read it, in their locale and on their own clock: 'Oct 13, 2026, 2:00 AM'
 * (T-240, T-277). The one format for moments a value shows, never the raw ISO timestamp.
 */
export const momentText = (intl: IntlShape, iso: string) =>
  intl.formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The day a moment fell on, on the person's own clock and in the format of `dayText`: 'Oct 13,
 * 2026' (TR-8, PL-10). For a list's Created, Updated and Closed, where the time of day would take
 * the summary's room; the whole moment, `momentText`, stays in the cell's words and its tooltip.
 */
export const momentDayText = (intl: IntlShape, iso: string) =>
  intl.formatDate(iso, { day: 'numeric', month: 'short', year: 'numeric' });

/** Whether a value is an instant the API sends (ISO 8601) that a clock can read. */
export const isInstant = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

/** `dayText` bound to the person's locale. */
export function useDayText() {
  const intl = useIntl();
  return (day: string) => dayText(intl, day);
}

/** Whether a value is a calendar day as the API sends one, `YYYY-MM-DD`. */
export const isCalendarDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * The calendar day a release shipped on: its release date, or else the day its shipping fell on
 * by the person's own clock (as `localDay`, T-272), not UTC's, so the Releases list, the release's
 * page and its report say the same day (T-240).
 */
export const shippedDay = (releaseDate: string | null, shippedAt: string) =>
  releaseDate ?? localDay(new Date(shippedAt));
