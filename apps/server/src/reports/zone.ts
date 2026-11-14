import { knownTimeZone, localDate } from '@taskmoor/query';
import type { FastifyRequest } from 'fastify';

/**
 * The header the web app sends on every request with the browser's time zone (T-272), the same
 * clock its own "today" uses (`localDay()`), so a report's days and the calendar's agree.
 */
export const TIME_ZONE_HEADER = 'taskmoor-time-zone';

const usable = (zone: string | null | undefined): zone is string =>
  typeof zone === 'string' && zone.length > 0 && zone.length <= 64 && knownTimeZone(zone);

/**
 * The time zone whose days a report counts in: the one the request asks for (`?timeZone=`), else
 * the zone the viewer's browser sends, else the zone on their profile, else UTC. The browser's
 * zone comes before the profile's, as it is the one the person's own screens show today in.
 */
export function viewerTimeZone(request: FastifyRequest, asked?: string | null): string {
  if (usable(asked)) return asked;
  const header = request.headers[TIME_ZONE_HEADER];
  const sent = Array.isArray(header) ? header[0] : header;
  if (usable(sent)) return sent;
  const own = request.user?.timeZone;
  if (usable(own)) return own;
  return 'UTC';
}

/**
 * Today as the viewer's own screens say it (T-282): the calendar day now in `viewerTimeZone`,
 * for what turns on whether a day has come (a release overdue, the day a release ships on).
 */
export function viewerDay(request: FastifyRequest, asked?: string | null): string {
  return localDate(new Date(), viewerTimeZone(request, asked));
}

/** Today in UTC, for callers with no viewer. */
export const utcDay = (): string => new Date().toISOString().slice(0, 10);
