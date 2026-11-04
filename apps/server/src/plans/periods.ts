/**
 * A plan's periods (T-089b; PLN-005; ADR-122 stage 3): every N weeks from an anchor day (any day;
 * periods repeat from it both ways), or each calendar month. Days are calendar days as
 * `YYYY-MM-DD`, counted in UTC, so no time zone moves a ticket's due day into another period.
 */
export type PeriodSetting = { kind: 'weeks'; weeks: number; anchor: string } | { kind: 'month' };

/** One period: its first and last day, both included. */
export interface Period {
  start: string;
  end: string;
}

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of a `YYYY-MM-DD` day. */
export function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

/** The `YYYY-MM-DD` of a day number. */
export function isoDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** The period that holds `day`. */
export function periodHolding(setting: PeriodSetting, day: string): Period {
  if (setting.kind === 'month') {
    const [y, m] = day.split('-').map(Number) as [number, number];
    const start = Date.UTC(y, m - 1, 1) / DAY_MS;
    const next = Date.UTC(y, m, 1) / DAY_MS;
    return { start: isoDay(start), end: isoDay(next - 1) };
  }
  const length = setting.weeks * 7;
  const anchor = dayNumber(setting.anchor);
  const start = anchor + Math.floor((dayNumber(day) - anchor) / length) * length;
  return { start: isoDay(start), end: isoDay(start + length - 1) };
}

/** `count` periods in a row, from the one that holds `day`. */
export function periodsFrom(setting: PeriodSetting, day: string, count: number): Period[] {
  const out: Period[] = [];
  let at = day;
  for (let i = 0; i < count; i++) {
    const period = periodHolding(setting, at);
    out.push(period);
    at = isoDay(dayNumber(period.end) + 1);
  }
  return out;
}

/** The first day of the period `count` periods before the one that holds `day`. */
export function periodsBefore(setting: PeriodSetting, day: string, count: number): string {
  let start = periodHolding(setting, day).start;
  for (let i = 0; i < count; i++)
    start = periodHolding(setting, isoDay(dayNumber(start) - 1)).start;
  return start;
}

/** Whether `day` is the first day of one of the periods. */
export function isPeriodStart(setting: PeriodSetting, day: string): boolean {
  return periodHolding(setting, day).start === day;
}

/** Whether two settings make the same periods: an anchor moved by whole periods changes none. */
export function samePeriods(a: PeriodSetting, b: PeriodSetting): boolean {
  if (a.kind === 'month' || b.kind === 'month') return a.kind === b.kind;
  return a.weeks === b.weeks && (dayNumber(a.anchor) - dayNumber(b.anchor)) % (a.weeks * 7) === 0;
}
