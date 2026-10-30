import { describe, expect, it } from 'vitest';
import { periodStart, periodsBetween } from './general';

describe('report periods (M1-062)', () => {
  it('[RPT-002] starts weeks on Monday and months on the first, across a year', () => {
    // Sunday 11 October 2026 belongs to the week of Monday the 5th.
    expect(periodStart('2026-10-11', 'week')).toBe('2026-10-05');
    expect(periodStart('2026-10-05', 'week')).toBe('2026-10-05');
    expect(periodStart('2027-01-01', 'week')).toBe('2026-12-28');
    expect(periodStart('2026-10-29', 'month')).toBe('2026-10-01');
    expect(periodStart('2026-10-29', 'day')).toBe('2026-10-29');
    expect(periodsBetween('2026-12-20', '2027-01-10', 'month')).toEqual([
      '2026-12-01',
      '2027-01-01',
    ]);
    expect(periodsBetween('2026-12-24', '2027-01-06', 'week')).toEqual([
      '2026-12-21',
      '2026-12-28',
      '2027-01-04',
    ]);
    expect(periodsBetween('2026-10-30', '2026-11-01', 'day')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
  });
});
