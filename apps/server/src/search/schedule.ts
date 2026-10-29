/**
 * When a search subscription is next due (M1-063; QRY-012): daily, weekly or monthly at a time
 * of day, or a five-field cron expression (minute hour day-of-month month day-of-week; `*`,
 * numbers, lists, ranges and steps; day of week 0 or 7 is Sunday), read on the wall clock of a
 * time zone. Like cron, when both day fields are restricted a day matching either runs.
 */
export interface Schedule {
  schedule: 'daily' | 'weekly' | 'monthly' | 'cron';
  hour: number;
  minute: number;
  weekday: number | null;
  dayOfMonth: number | null;
  cron: string | null;
  timeZone: string;
}

export class ScheduleError extends Error {}

interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  daysAny: boolean;
  weekdaysAny: boolean;
}

function field(text: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) throw new ScheduleError(`The ${name} field "${text}" is not understood`);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    let from = min;
    let to = max;
    if (m[1] !== '*') {
      from = Number(m[2]);
      to = m[3] === undefined ? (m[4] === undefined ? from : max) : Number(m[3]);
    }
    if (step < 1 || from < min || to > max || from > to) {
      throw new ScheduleError(`The ${name} field "${text}" is out of range (${min}-${max})`);
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export function parseCron(text: string): CronSpec {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new ScheduleError('A cron expression has five fields: minute hour day month weekday');
  }
  const [mi, h, d, mo, w] = parts as [string, string, string, string, string];
  const weekdays = field(w, 0, 7, 'weekday');
  if (weekdays.has(7)) weekdays.add(0);
  return {
    minutes: field(mi, 0, 59, 'minute'),
    hours: field(h, 0, 23, 'hour'),
    days: field(d, 1, 31, 'day'),
    months: field(mo, 1, 12, 'month'),
    weekdays,
    daysAny: d === '*',
    weekdaysAny: w === '*',
  };
}

export function cronOf(s: Schedule): string {
  switch (s.schedule) {
    case 'daily':
      return `${s.minute} ${s.hour} * * *`;
    case 'weekly':
      return `${s.minute} ${s.hour} * * ${s.weekday ?? 1}`;
    case 'monthly':
      return `${s.minute} ${s.hour} ${s.dayOfMonth ?? 1} * *`;
    case 'cron':
      return s.cron ?? '';
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function wall(at: Date, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    month: Number(part('month')),
    day: Number(part('day')),
    weekday: WEEKDAYS[part('weekday')] ?? 0,
    hour: Number(part('hour')),
    minute: Number(part('minute')),
  };
}

export function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The first minute after `after` that the schedule runs at; null when none within 4 years. */
export function nextRun(s: Schedule, after: Date): Date | null {
  const spec = parseCron(cronOf(s));
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: validTimeZone(s.timeZone) ? s.timeZone : 'UTC',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
  const MINUTE = 60_000;
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const end = after.getTime() + 4 * 366 * 24 * 60 * MINUTE;
  while (t <= end) {
    const w = wall(new Date(t), formatter);
    const dayOk =
      spec.daysAny && spec.weekdaysAny
        ? true
        : spec.daysAny
          ? spec.weekdays.has(w.weekday)
          : spec.weekdaysAny
            ? spec.days.has(w.day)
            : spec.days.has(w.day) || spec.weekdays.has(w.weekday);
    if (!spec.months.has(w.month) || !dayOk) {
      // On to the next local midnight (or near it, across a clock change).
      t += ((23 - w.hour) * 60 + (60 - w.minute)) * MINUTE;
      continue;
    }
    if (!spec.hours.has(w.hour)) {
      t += (60 - w.minute) * MINUTE;
      continue;
    }
    if (!spec.minutes.has(w.minute)) {
      t += MINUTE;
      continue;
    }
    return new Date(t);
  }
  return null;
}
