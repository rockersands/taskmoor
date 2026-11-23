import { fc } from '@taskmoor/testkit/property';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GRID_OVERSCAN, GRID_ROW, rowWindow, useRowWindow } from './rowWindow';

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

  it('[PLN-010] scrolls a row clear of the sticky header above and the footer below', () => {
    // A view of 440 px: the header covers its top 50, the "All rows" footer its last 44.
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientHeight', { value: 440 });
    const scroller = { current: el };
    const { result } = renderHook(() =>
      useRowWindow(scroller, 100, { offset: 50, bottom: GRID_ROW }),
    );
    // Row 6 ends at 50 + 7 * 44 = 358, above the footer at 396: no scroll.
    act(() => result.current.scrollToRow(6));
    expect(el.scrollTop).toBe(0);
    // Row 7 ends at 402: scrolled up 6 px, it ends where the footer starts.
    act(() => result.current.scrollToRow(7));
    expect(el.scrollTop).toBe(6);
    // Back up to row 0: it starts right under the header.
    act(() => result.current.scrollToRow(0));
    expect(el.scrollTop).toBe(0);
    // Row 50 from the top: 50 + 51 * 44 - (440 - 44) = 1898.
    act(() => result.current.scrollToRow(50));
    expect(el.scrollTop).toBe(50 + 51 * GRID_ROW - (440 - GRID_ROW));
  });
});
