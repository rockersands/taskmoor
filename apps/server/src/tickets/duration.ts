/**
 * Durations as people write them (M1-019; TIM-001 (2); spec 03 section 3): "1w 2d 3h 30m",
 * "1.5h", "90m", or a bare number in the default unit. A week and a day are working weeks
 * and days, from the workspace's time tracking settings, so "1w" is 40 hours with the default
 * 5 days of 8 hours. Values are kept in whole seconds.
 */
export interface WorkingTime {
  hoursPerDay: number;
  daysPerWeek: number;
}

export const DURATION_UNITS = ['week', 'day', 'hour', 'minute'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];
export const DISPLAY_FORMATS = ['pretty', 'days', 'hours'] as const;
export type DisplayFormat = (typeof DISPLAY_FORMATS)[number];

/** The longest duration kept: the largest value an integer column holds, in seconds. */
export const MAX_DURATION_SECONDS = 2_147_483_647;

const LETTERS: Record<string, DurationUnit> = { w: 'week', d: 'day', h: 'hour', m: 'minute' };

/** Seconds in one unit under these working-time settings. */
export function unitSeconds(unit: DurationUnit, time: WorkingTime): number {
  switch (unit) {
    case 'minute':
      return 60;
    case 'hour':
      return 3600;
    case 'day':
      return time.hoursPerDay * 3600;
    case 'week':
      return time.daysPerWeek * time.hoursPerDay * 3600;
  }
}

export type DurationProblem = 'invalid' | 'too_long';

/**
 * Seconds in a duration: units w, d, h and m in any case, each at most once, with or without
 * spaces between them, and decimal amounts ("1.5d"); a bare number takes `defaultUnit`.
 */
export function parseDuration(
  text: string,
  time: WorkingTime,
  defaultUnit: DurationUnit,
): { ok: true; seconds: number } | { ok: false; problem: DurationProblem } {
  const input = text.trim().toLowerCase();
  if (input === '') return { ok: false, problem: 'invalid' };
  let total = 0;
  if (/^\d+(\.\d+)?$/.test(input)) {
    total = Number(input) * unitSeconds(defaultUnit, time);
  } else {
    const seen = new Set<string>();
    const part = /\s*(\d+(?:\.\d+)?)\s*([wdhm])\s*/y;
    let at = 0;
    while (at < input.length) {
      part.lastIndex = at;
      const match = part.exec(input);
      if (!match) return { ok: false, problem: 'invalid' };
      const [, amount, letter] = match as unknown as [string, string, string];
      if (seen.has(letter)) return { ok: false, problem: 'invalid' };
      seen.add(letter);
      total += Number(amount) * unitSeconds(LETTERS[letter] as DurationUnit, time);
      at = part.lastIndex;
    }
  }
  const seconds = Math.round(total);
  if (!Number.isFinite(total) || seconds > MAX_DURATION_SECONDS) {
    return { ok: false, problem: 'too_long' };
  }
  return { ok: true, seconds };
}

const trim = (n: number) => String(Math.round(n * 100) / 100);

/**
 * A duration for display: "1w 2d 3h 30m" (pretty, whole minutes), or a decimal number of days
 * or hours. Zero reads "0m".
 */
export function formatDuration(seconds: number, time: WorkingTime, format: DisplayFormat): string {
  if (format === 'days') return `${trim(seconds / unitSeconds('day', time))}d`;
  if (format === 'hours') return `${trim(seconds / 3600)}h`;
  let rest = Math.round(seconds / 60) * 60;
  const parts: string[] = [];
  for (const unit of DURATION_UNITS) {
    const size = unitSeconds(unit, time);
    const amount = unit === 'minute' ? rest / 60 : Math.floor(rest / size);
    if (amount > 0) {
      parts.push(`${unit === 'minute' ? Math.round(amount) : amount}${unit[0]}`);
      rest -= unit === 'minute' ? rest : amount * size;
    }
  }
  return parts.length === 0 ? '0m' : parts.join(' ');
}
