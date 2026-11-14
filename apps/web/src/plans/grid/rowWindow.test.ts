import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { GRID_OVERSCAN, GRID_ROW, rowWindow } from './rowWindow';

describe('the Grid’s row window (ADR-122 stage 10)', () => {
  it('[PLN-010] draws the rows in view with 20 to spare on each side, padding for the rest', () => {
    const w = rowWindow({ count: 100_000, top: 1_000 * GRID_ROW, height: 10 * GRID_ROW });
    expect(w.first).toBe(1_000 - GRID_OVERSCAN);
    // At least 20 rows' worth is drawn, whatever the measured height.
    expect(w.last).toBe(1_000 + 20 + GRID_OVERSCAN);
    expect(w.before).toBe(w.first * GRID_ROW);
    expect(w.after).toBe((100_000 - w.last) * GRID_ROW);
    expect(w.pinned).toBe(-1);
  });

  it('[PLN-010] reaches the last row, and keeps a focused row drawn out of view', () => {
    const end = rowWindow({ count: 100_000, top: 99_999 * GRID_ROW, height: 600 });
    expect(end.last).toBe(100_000);
    expect(end.after).toBe(0);
    const kept = rowWindow({ count: 100_000, top: 50_000 * GRID_ROW, height: 600, keep: 3 });
    expect(kept.pinned).toBe(3);
    // The pinned row stands for one row of the padding above.
    expect(kept.before).toBe((kept.first - 1) * GRID_ROW);
    const below = rowWindow({ count: 100_000, top: 0, height: 600, keep: 99_000 });
    expect(below.pinned).toBe(99_000);
    expect(below.after).toBe((100_000 - below.last - 1) * GRID_ROW);
  });

  it('[PLN-010] always keeps the list’s height and draws a run inside it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 3_000 }),
        fc.integer({ min: -1, max: 200_000 }),
        (count, top, height, keep) => {
          const w = rowWindow({ count, top, height, keep });
          expect(w.first).toBeGreaterThanOrEqual(0);
          expect(w.first).toBeLessThanOrEqual(w.last);
          expect(w.last).toBeLessThanOrEqual(count);
          expect(w.last - w.first).toBeLessThanOrEqual(Math.max(20, height / GRID_ROW) + 42);
          const drawn = w.last - w.first + (w.pinned >= 0 ? 1 : 0);
          expect(w.before + w.after + drawn * GRID_ROW).toBe(count * GRID_ROW);
        },
      ),
    );
  });
});
