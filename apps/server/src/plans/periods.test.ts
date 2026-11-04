import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  dayNumber,
  isoDay,
  isPeriodStart,
  type PeriodSetting,
  periodHolding,
  periodsBefore,
  periodsFrom,
  samePeriods,
  weekThursday,
} from './periods';

const TWO_WEEKS: PeriodSetting = { kind: 'weeks', weeks: 2, anchor: '2027-03-01' };
const MONTHS: PeriodSetting = { kind: 'month' };

/** A plan's periods (T-089b; PLN-005; ADR-122 stage 3). */
describe('a plan’s periods (PLN-005)', () => {
  it('[PLN-005] repeats weeks from the anchor both ways, and takes calendar months', () => {
    expect(periodHolding(TWO_WEEKS, '2027-03-14')).toEqual({
      start: '2027-03-01',
      end: '2027-03-14',
    });
    expect(periodHolding(TWO_WEEKS, '2027-02-28')).toEqual({
      start: '2027-02-15',
      end: '2027-02-28',
    });
    expect(periodHolding(MONTHS, '2028-02-10')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(periodsFrom(MONTHS, '2027-12-31', 2)).toEqual([
      { start: '2027-12-01', end: '2027-12-31' },
      { start: '2028-01-01', end: '2028-01-31' },
    ]);
    expect(periodsBefore(MONTHS, '2027-03-15', 2)).toBe('2027-01-01');
    expect(periodsBefore(TWO_WEEKS, '2027-03-15', 3)).toBe('2027-02-01');
    expect(isPeriodStart(TWO_WEEKS, '2027-03-15')).toBe(true);
    expect(isPeriodStart(TWO_WEEKS, '2027-03-08')).toBe(false);
  });

  it('[PLN-005] treats an anchor moved by whole periods as the same periods', () => {
    expect(samePeriods(TWO_WEEKS, { ...TWO_WEEKS, anchor: '2026-12-21' })).toBe(true);
    expect(samePeriods(TWO_WEEKS, { ...TWO_WEEKS, anchor: '2027-03-08' })).toBe(false);
    expect(samePeriods(TWO_WEEKS, { ...TWO_WEEKS, weeks: 4 })).toBe(false);
    expect(samePeriods(TWO_WEEKS, MONTHS)).toBe(false);
    expect(samePeriods(MONTHS, MONTHS)).toBe(true);
  });

  it('[PLN-005] puts every day in exactly one period, back to back', () => {
    const settings = fc.oneof(
      fc.constant<PeriodSetting>(MONTHS),
      fc
        .record({
          weeks: fc.integer({ min: 1, max: 6 }),
          anchor: fc.integer({ min: 0, max: 40_000 }),
        })
        .map((x): PeriodSetting => ({ kind: 'weeks', weeks: x.weeks, anchor: isoDay(x.anchor) })),
    );
    fc.assert(
      fc.property(settings, fc.integer({ min: 0, max: 40_000 }), (setting, n) => {
        const day = isoDay(n);
        const period = periodHolding(setting, day);
        expect(period.start <= day && day <= period.end).toBe(true);
        expect(isPeriodStart(setting, period.start)).toBe(true);
        // The next period starts the day after this one ends.
        const [, next] = periodsFrom(setting, day, 2);
        expect(dayNumber(next?.start as string)).toBe(dayNumber(period.end) + 1);
      }),
    );
  });

  it('[PLN-009] gives every day of a week, Monday to Sunday, the same Thursday', () => {
    expect(
      ['2027-03-08', '2027-03-10', '2027-03-11', '2027-03-14'].map((d) => weekThursday(d)),
    ).toEqual(['2027-03-11', '2027-03-11', '2027-03-11', '2027-03-11']);
    expect(weekThursday('2027-03-15')).toBe('2027-03-18');
    // A week across two months and two years: Thursday 2026-12-31.
    expect(weekThursday('2027-01-03')).toBe('2026-12-31');
    expect(weekThursday('1969-12-29')).toBe('1970-01-01');
  });

  it('[PLN-009] puts a week in the period that holds most of its days, whatever the periods', () => {
    const settings = fc.oneof(
      fc.constant<PeriodSetting>(MONTHS),
      fc
        .record({
          weeks: fc.integer({ min: 1, max: 6 }),
          anchor: fc.integer({ min: 0, max: 40_000 }),
        })
        .map((x): PeriodSetting => ({ kind: 'weeks', weeks: x.weeks, anchor: isoDay(x.anchor) })),
    );
    fc.assert(
      fc.property(settings, fc.integer({ min: 0, max: 40_000 }), (setting, n) => {
        const thursday = weekThursday(isoDay(n));
        const monday = dayNumber(thursday) - 3;
        // Every day of the week names the same Thursday, and `day` is one of them.
        expect(n >= monday && n <= monday + 6).toBe(true);
        for (let d = monday; d <= monday + 6; d++) expect(weekThursday(isoDay(d))).toBe(thursday);
        const period = periodHolding(setting, thursday);
        const inside = Array.from({ length: 7 }, (_, i) => monday + i).filter(
          (d) => d >= dayNumber(period.start) && d <= dayNumber(period.end),
        );
        expect(inside.length).toBeGreaterThanOrEqual(4);
      }),
    );
  });
});
