import { knownTimeZone, localDate } from '@taskmoor/query';
import type { FastifyRequest } from 'fastify';

/**
 * The header the web app sends on every request with the person's time zone (T-272, T-280): the
 * zone saved on their account, or the device's when they chose Automatic. It is the same clock
 * the app's own "today" uses (`localDay()`), so a report's days and the calendar's agree.
 */
export const TIME_ZONE_HEADER = 'taskmoor-time-zone';

const usable = (zone: string | null | undefined): zone is string =>
  typeof zone === 'string' && zone.length > 0 && zone.length <= 64 && knownTimeZone(zone);

/**
 * The person's time zone for this request (T-280, ADR-010): one clock per person. In order: the
 * zone the request asks for by name (`?timeZone=`, someone asked for it), else the zone saved on
 * the account, else the device's zone the app sends in the header (an account on Automatic),
 * else UTC. The account comes before the header so the rule holds even for a client that sends
 * only its device's zone; an API caller with neither gets UTC.
 */
export function viewerTimeZone(request: FastifyRequest, asked?: string | null): string {
  if (usable(asked)) return asked;
  const own = request.user?.timeZone;
  if (usable(own)) return own;
  const header = request.headers[TIME_ZONE_HEADER];
  const sent = Array.isArray(header) ? header[0] : header;
  if (usable(sent)) return sent;
  return 'UTC';
}

/**
 * Today as the person's own screens say it (T-282, T-280): the calendar day now in
 * `viewerTimeZone`, for what turns on whether a day has come (a release overdue, the day a
 * release ships on) and for the first day a plan's periods start from when none is given.
 */
export function viewerDay(request: FastifyRequest, asked?: string | null): string {
  return localDate(new Date(), viewerTimeZone(request, asked));
}

/** Today in UTC, for callers with no viewer. */
export const utcDay = (): string => new Date().toISOString().slice(0, 10);
