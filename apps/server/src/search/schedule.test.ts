import { describe, expect, it } from 'vitest';
import { nextRun, parseCron, type Schedule, ScheduleError } from './schedule';

const base: Schedule = {
  schedule: 'daily',
  hour: 8,
  minute: 0,
  weekday: null,
  dayOfMonth: null,
  cron: null,
  timeZone: 'UTC',
};

/** Search subscription schedules (M1-063; QRY-012). */
describe('subscription schedules', () => {
  it('[QRY-012] runs daily at a time of day, on the wall clock of the time zone', () => {
    const after = new Date('2026-10-29T10:00:00Z');
    expect(nextRun(base, after)?.toISOString()).toBe('2026-10-30T08:00:00.000Z');
    expect(nextRun({ ...base, hour: 11, minute: 15 }, after)?.toISOString()).toBe(
      '2026-10-29T11:15:00.000Z',
    );
    // 08:00 in Berlin is 07:00 UTC in winter time (from 25 October 2026).
    expect(nextRun({ ...base, timeZone: 'Europe/Berlin' }, after)?.toISOString()).toBe(
      '2026-10-30T07:00:00.000Z',
    );
  });

  it('[QRY-012] runs weekly on a weekday and monthly on a day', () => {
    const after = new Date('2026-10-29T10:00:00Z'); // a Thursday
    expect(nextRun({ ...base, schedule: 'weekly', weekday: 1 }, after)?.toISOString()).toBe(
      '2026-11-02T08:00:00.000Z',
    );
    expect(
      nextRun({ ...base, schedule: 'monthly', dayOfMonth: 1, hour: 6 }, after)?.toISOString(),
    ).toBe('2026-11-01T06:00:00.000Z');
  });

  it('[QRY-012] runs a cron expression with lists, ranges and steps', () => {
    const after = new Date('2026-10-30T23:50:00Z'); // a Friday
    const cron = (expr: string, tz = 'UTC') =>
      nextRun({ ...base, schedule: 'cron', cron: expr, timeZone: tz }, after)?.toISOString();
    expect(cron('30 6 * * 1-5')).toBe('2026-11-02T06:30:00.000Z');
    expect(cron('*/20 * * * *')).toBe('2026-10-31T00:00:00.000Z');
    expect(cron('0 9,17 * * 0')).toBe('2026-11-01T09:00:00.000Z');
    expect(cron('0 0 1 1 *')).toBe('2027-01-01T00:00:00.000Z');
    // Either day field matches when both are restricted, as in cron.
    expect(cron('0 12 15 * 6')).toBe('2026-10-31T12:00:00.000Z');
    expect(cron('0 12 * * *', 'America/New_York')).toBe('2026-10-31T16:00:00.000Z');
  });

  it('[QRY-012] refuses a cron expression it does not understand', () => {
    for (const bad of ['* * * *', '61 * * * *', '0 24 * * *', 'a b c d e', '5-1 * * * *']) {
      expect(() => parseCron(bad), bad).toThrow(ScheduleError);
    }
    // February 30th never comes.
    expect(
      nextRun({ ...base, schedule: 'cron', cron: '0 0 30 2 *' }, new Date('2026-01-01T00:00:00Z')),
    ).toBeNull();
  });
});
