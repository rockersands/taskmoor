import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { type DURATION_UNITS, formatDuration, parseDuration, type WorkingTime } from './duration';

const standard: WorkingTime = { hoursPerDay: 8, daysPerWeek: 5 };
const seconds = (
  text: string,
  time = standard,
  unit: (typeof DURATION_UNITS)[number] = 'minute',
) => {
  const parsed = parseDuration(text, time, unit);
  return parsed.ok ? parsed.seconds : parsed.problem;
};

describe('durations (TIM-001)', () => {
  it('[TIM-001] parses "1w 2d" according to the working-week settings', () => {
    expect(seconds('1w 2d')).toBe((40 + 16) * 3600);
    expect(seconds('1w 2d', { hoursPerDay: 7.5, daysPerWeek: 4 })).toBe((30 + 15) * 3600);
    expect(seconds('1W2D3H30M')).toBe((56 + 3.5) * 3600);
    expect(seconds(' 3h  30m ')).toBe(3.5 * 3600);
    expect(seconds('1.5d')).toBe(12 * 3600);
    expect(seconds('30m 2h')).toBe(2.5 * 3600);
  });

  it('[TIM-001] reads a bare number in the default unit', () => {
    expect(seconds('90')).toBe(90 * 60);
    expect(seconds('2', standard, 'hour')).toBe(7200);
    expect(seconds('1.5', standard, 'day')).toBe(12 * 3600);
    expect(seconds('1', standard, 'week')).toBe(40 * 3600);
  });

  it('[TIM-001] refuses what is not a duration', () => {
    for (const text of ['', ' ', 'h', '2x', '1h 1h', '-1h', '1,5h', '1h30', 'one hour', '1e3h']) {
      expect(seconds(text), text).toBe('invalid');
    }
    expect(seconds('100000000w')).toBe('too_long');
  });

  it('[TIM-001] formats pretty, in days or in hours', () => {
    const value = (56 + 3.5) * 3600;
    expect(formatDuration(value, standard, 'pretty')).toBe('1w 2d 3h 30m');
    expect(formatDuration(value, standard, 'days')).toBe('7.44d');
    expect(formatDuration(value, standard, 'hours')).toBe('59.5h');
    expect(formatDuration(0, standard, 'pretty')).toBe('0m');
    expect(formatDuration(45, standard, 'pretty')).toBe('1m');
  });

  it('[TIM-001] reads back what it writes, to the minute', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 24 }),
        fc.integer({ min: 1, max: 7 }),
        (value, hoursPerDay, daysPerWeek) => {
          const time = { hoursPerDay, daysPerWeek };
          const text = formatDuration(value, time, 'pretty');
          const parsed = parseDuration(text, time, 'minute');
          expect(parsed).toEqual({ ok: true, seconds: Math.round(value / 60) * 60 });
        },
      ),
    );
  });
});
