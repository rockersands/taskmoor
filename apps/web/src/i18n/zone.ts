/**
 * The person's clock (T-280, ADR-010): one time zone per person. It is the zone saved on their
 * account, or the device's when they chose Automatic. Every "today", every day boundary and every
 * time of day the app shows or reads from an input uses it, and the server gets the same zone
 * on every request (`taskmoor-time-zone`), so the timeline's today line, a report's days, a
 * release's overdue and a search's `startOfDay()` all agree, on every device.
 *
 * The session sets the account's zone (`setAccountTimeZone`) as soon as it knows the person, so
 * the pages below read it from their first drawing; the formatting provider gets it as its
 * default zone (`I18nProvider`'s `timeZone`). With Automatic nothing here differs from the
 * device's own clock: the helpers then read the device the way `Date` does.
 */

let account: string | null = null;

/** Whether the browser knows a zone by this name. */
export function knownTimeZone(zone: string | null | undefined): zone is string {
  if (typeof zone !== 'string' || zone === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone saved on the signed-in person's account; null (Automatic, signed out) follows the device. */
export function setAccountTimeZone(zone: string | null | undefined): void {
  account = knownTimeZone(zone) ? zone : null;
}

/** The account's zone when one is saved and the browser knows it; null follows the device. */
export const accountTimeZone = (): string | null => account;

/** The device's own zone; null when the browser has none. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The person's zone: the account's, else the device's; null when neither is known. */
export const personTimeZone = (): string | null => account ?? deviceTimeZone();

/** A wall-clock reading: the calendar day and the time of day. */
export interface WallTime {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();
function formatIn(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formats.set(zone, format);
  }
  return format;
}

/** The wall clock at `at` in `zone`; the device's clock for null. */
function wallIn(at: Date, zone: string | null): WallTime {
  if (zone === null) {
    return {
      year: at.getFullYear(),
      month: at.getMonth() + 1,
      day: at.getDate(),
      hour: at.getHours(),
      minute: at.getMinutes(),
      second: at.getSeconds(),
    };
  }
  const out: Record<string, number> = {};
  for (const part of formatIn(zone).formatToParts(at)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** The wall clock at `at` on the person's clock. */
export const wallTime = (at: Date): WallTime => wallIn(at, account);

/**
 * The instant a wall-clock reading names on the person's clock. A reading the clock passes twice
 * (the hour summer time ends) takes the first; one it skips (the hour summer time starts) lands
 * an hour away, as the device's own clock does.
 */
export function instantOf(wall: Omit<WallTime, 'second'> & { second?: number }): Date {
  const second = wall.second ?? 0;
  if (account === null) {
    const at = new Date(2000, 0, 1);
    at.setFullYear(wall.year, wall.month - 1, wall.day);
    at.setHours(wall.hour, wall.minute, second, 0);
    return at;
  }
  const zone = account;
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, second);
  // How far the zone's clock is ahead of UTC at an instant.
  const offset = (t: number) => {
    const w = wallIn(new Date(t), zone);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - t;
  };
  const guess = offset(asUtc);
  let at = asUtc - guess;
  const settled = offset(at);
  if (settled !== guess) at = asUtc - settled;
  return new Date(at);
}

const two = (n: number) => String(n).padStart(2, '0');

/** The calendar day it is at `at` on the person's clock, as `YYYY-MM-DD`. */
export function personDay(at: Date): string {
  const w = wallTime(at);
  return `${String(w.year).padStart(4, '0')}-${two(w.month)}-${two(w.day)}`;
}

/** An instant as a date-and-time input holds it (`YYYY-MM-DDTHH:mm`), on the person's clock. */
export function localDateTimeText(at: Date): string {
  if (Number.isNaN(at.getTime())) return '';
  const w = wallTime(at);
  return `${String(w.year).padStart(4, '0')}-${two(w.month)}-${two(w.day)}T${two(w.hour)}:${two(w.minute)}`;
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * The instant a date-and-time input's text (`YYYY-MM-DDTHH:mm`, seconds optional) names on the
 * person's clock; null for text that is not one.
 */
export function instantOfLocalText(text: string): Date | null {
  const m = LOCAL_DATE_TIME.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map((v) => Number(v ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const at = instantOf({ year, month, day, hour, minute, second });
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The calendar day `days` after a wall-clock reading's day (before it when negative). */
export function addDaysTo(wall: Pick<WallTime, 'year' | 'month' | 'day'>, days: number) {
  const at = new Date(Date.UTC(2000, 0, 1));
  at.setUTCFullYear(wall.year, wall.month - 1, wall.day + days);
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

/** The day of the week of a wall-clock reading's day: 0 for Sunday to 6 for Saturday. */
export function weekdayOf(wall: Pick<WallTime, 'year' | 'month' | 'day'>): number {
  const at = new Date(Date.UTC(2000, 0, 1));
  at.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  return at.getUTCDay();
}
