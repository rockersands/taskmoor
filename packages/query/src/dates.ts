/**
 * Calendar arithmetic in a person's time zone (M1-038; QRY-006; spec 01b section 1.4): dates
 * and date functions are read on the person's wall clock, so `startOfDay()` is their midnight
 * and `created >= 2026-10-01` starts at their midnight too. Pure: the zone's offsets come from
 * the platform's time zone data (`Intl`), so the same query gives the same instants anywhere.
 */

/** A wall-clock time: month 1 to 12, weekday 0 (Sunday) to 6. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Whether the platform knows a time zone name. */
export function knownTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

const isUtc = (timeZone: string) => timeZone === 'UTC' || timeZone === 'Etc/UTC';

/** The wall clock in `timeZone` at an instant. */
export function wallClock(at: Date, timeZone: string): WallClock {
  if (isUtc(timeZone)) {
    return {
      year: at.getUTCFullYear(),
      month: at.getUTCMonth() + 1,
      day: at.getUTCDate(),
      hour: at.getUTCHours(),
      minute: at.getUTCMinutes(),
      second: at.getUTCSeconds(),
      ms: at.getUTCMilliseconds(),
    };
  }
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(at)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year as number,
    month: parts.month as number,
    day: parts.day as number,
    hour: (parts.hour as number) % 24,
    minute: parts.minute as number,
    second: parts.second as number,
    ms: at.getUTCMilliseconds(),
  };
}

/** The wall clock's numbers read as if they were UTC, normalised (day 32 is the next month). */
const asUtc = (w: WallClock) =>
  Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.ms);

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(at: number, timeZone: string): number {
  return asUtc(wallClock(new Date(at), timeZone)) - at;
}

/**
 * The instant a wall-clock time names in a zone. A time skipped by a clock change reads as the
 * same time on the earlier offset (02:30 on a spring-forward night is 03:30); a repeated one
 * reads as its first occurrence.
 */
export function instantOf(w: WallClock, timeZone: string): Date {
  const wall = asUtc(w);
  if (isUtc(timeZone)) return new Date(wall);
  // The offsets a day either side; a zone changes its clock at most once in between.
  const DAY = 86_400_000;
  const offsets = [...new Set([offsetAt(wall - DAY, timeZone), offsetAt(wall + DAY, timeZone)])];
  const readings = offsets
    .map((o) => wall - o)
    .filter((at) => offsetAt(at, timeZone) === wall - at);
  if (readings.length > 0) return new Date(Math.min(...readings));
  // A gap: the earlier (smaller) offset carries the time past it.
  return new Date(wall - Math.min(...offsets));
}

/** A wall-clock time moved by whole units on the calendar (days stay days across clock changes). */
export function addWall(
  w: WallClock,
  n: number,
  unit: 'y' | 'M' | 'w' | 'd' | 'h' | 'm',
): WallClock {
  const next = { ...w };
  switch (unit) {
    case 'y':
      next.year += n;
      break;
    case 'M':
      next.month += n;
      break;
    case 'w':
      next.day += 7 * n;
      break;
    case 'd':
      next.day += n;
      break;
    case 'h':
      next.hour += n;
      break;
    case 'm':
      next.minute += n;
      break;
  }
  const d = new Date(asUtc(next));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    ms: d.getUTCMilliseconds(),
  };
}

const INCREMENT = /^([+-]?)(\d+)([mhdwMy])$/;

/** An increment such as -1w, +3d or 2M as a count and a unit; undefined when it is none. */
export function parseIncrement(
  text: string,
): { n: number; unit: 'y' | 'M' | 'w' | 'd' | 'h' | 'm' } | undefined {
  const m = INCREMENT.exec(text);
  if (!m) return undefined;
  return {
    n: Number(m[2]) * (m[1] === '-' ? -1 : 1),
    unit: m[3] as 'y' | 'M' | 'w' | 'd' | 'h' | 'm',
  };
}

export type Period = 'day' | 'week' | 'month' | 'year';

export interface CalendarOptions {
  timeZone: string;
  /** The first day of the week, 0 (Sunday) to 6; weeks end the day before. */
  weekStart: number;
}

/** The start of the period holding `now` on the person's wall clock. */
function periodStart(now: Date, period: Period, cal: CalendarOptions): WallClock {
  const w = wallClock(now, cal.timeZone);
  const midnight = { ...w, hour: 0, minute: 0, second: 0, ms: 0 };
  switch (period) {
    case 'day':
      return midnight;
    case 'week': {
      const weekday = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
      return addWall(midnight, -((weekday - cal.weekStart + 7) % 7), 'd');
    }
    case 'month':
      return { ...midnight, day: 1 };
    case 'year':
      return { ...midnight, month: 1, day: 1 };
  }
}

const PERIOD_UNIT: Record<Period, 'd' | 'w' | 'M' | 'y'> = {
  day: 'd',
  week: 'w',
  month: 'M',
  year: 'y',
};

/**
 * `startOfX(increment)` and `endOfX(increment)`: the period's first instant, or its last
 * millisecond, on the person's wall clock, moved by the increment (`startOfMonth(-1M)` is the
 * start of last month, `startOfMonth(+14d)` the 15th of this one). The end is the next
 * period's start moved by the increment, less a millisecond, so `endOfMonth(+1M)` is the end
 * of next month whatever its length.
 */
export function boundary(
  now: Date,
  edge: 'start' | 'end',
  period: Period,
  increment: { n: number; unit: 'y' | 'M' | 'w' | 'd' | 'h' | 'm' } | undefined,
  cal: CalendarOptions,
): Date {
  let wall = periodStart(now, period, cal);
  if (edge === 'end') wall = addWall(wall, 1, PERIOD_UNIT[period]);
  if (increment) wall = addWall(wall, increment.n, increment.unit);
  const at = instantOf(wall, cal.timeZone);
  return edge === 'end' ? new Date(at.getTime() - 1) : at;
}

/** The calendar date (YYYY-MM-DD) an instant falls on in a zone. */
export function localDate(at: Date, timeZone: string): string {
  const w = wallClock(at, timeZone);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}
