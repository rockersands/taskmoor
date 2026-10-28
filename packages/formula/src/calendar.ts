/**
 * Days as numbers (days since 1970-01-01, in UTC) and working days (CORE-011 (2)). A working
 * week is seven flags, Monday first; the server builds it from the workspace's time tracking
 * setting (`workingWeek`).
 */
const MS_PER_DAY = 86_400_000;

/** 1000-01-01 and 9999-12-31: the dates a field can hold (as custom date fields). */
export const FIRST_DAY = -354_285;
export const LAST_DAY = 2_932_896;

export const isDay = (d: number) => Number.isInteger(d) && d >= FIRST_DAY && d <= LAST_DAY;

/** The day of an ISO date (`2026-10-28`) or instant, or null when it is not one. */
export function dayOfIso(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (text.length > 10) {
    // An instant: its UTC day.
    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    const day = Math.floor(at / MS_PER_DAY);
    return isDay(day) ? day : null;
  }
  const at = Date.UTC(y, mo - 1, d);
  const back = new Date(at);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  const day = Math.round(at / MS_PER_DAY);
  return isDay(day) ? day : null;
}

/** The day of a date-time. */
export function dayOfDate(at: Date): number {
  return Math.floor(at.getTime() / MS_PER_DAY);
}

/** `YYYY-MM-DD` of a day. */
export function isoOfDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Year, month (1 to 12), day of month and ISO weekday (1 Monday to 7 Sunday) of a day. */
export function partsOfDay(day: number): {
  year: number;
  month: number;
  day: number;
  weekday: number;
} {
  const at = new Date(day * MS_PER_DAY);
  return {
    year: at.getUTCFullYear(),
    month: at.getUTCMonth() + 1,
    day: at.getUTCDate(),
    weekday: weekdayIndex(day) + 1,
  };
}

/** 0 for Monday to 6 for Sunday; 1970-01-01 was a Thursday. */
export const weekdayIndex = (day: number) => (((day + 3) % 7) + 7) % 7;

/** The usual week: Monday to Friday. */
export const MONDAY_TO_FRIDAY: readonly boolean[] = [true, true, true, true, true, false, false];

/**
 * The working week of a time tracking setting's days per week (TIM-001; 0.01 to 7): Monday and
 * the days after it, as many as the setting rounds up to, so 5 is Monday to Friday and 4.5
 * counts Friday too.
 */
export function workingWeek(daysPerWeek: number): boolean[] {
  const n = Math.min(7, Math.max(1, Math.ceil(daysPerWeek - 1e-9)));
  return Array.from({ length: 7 }, (_, i) => i < n);
}

/** Working days on or before `day`, counted from a Monday far back (only differences matter). */
function workingUpTo(day: number, week: readonly boolean[]): number {
  const perWeek = week.filter(Boolean).length;
  // 1970-01-05 (day 4) was a Monday.
  const from = day - 4;
  // The remainder first: from a huge `from`, `floor(from / 7) * 7` is off by far more than a
  // week, and the loop below would never end.
  const rest = ((from % 7) + 7) % 7;
  const weeks = (from - rest) / 7;
  let n = weeks * perWeek;
  for (let i = 0; i <= rest; i++) if (week[i]) n++;
  return n;
}

/**
 * Working days from `a` to `b`: those after `a` up to and including `b`, negative when `b` is
 * before `a`. Friday to Monday is 1 in a Monday-to-Friday week.
 */
export function workingDaysBetween(a: number, b: number, week: readonly boolean[]): number {
  return workingUpTo(b, week) - workingUpTo(a, week);
}

/**
 * Working days from today until `due` (CORE-011 (2)): those after today up to and including the
 * due date. A due date that has passed counts the working days from it up to today as
 * negative, and at least -1, so any past due date reads as overdue, even one on a weekend.
 */
export function workingDaysUntil(due: number, today: number, week: readonly boolean[]): number {
  if (due >= today) return workingDaysBetween(today, due, week);
  return -Math.max(1, workingDaysBetween(due - 1, today - 1, week));
}
