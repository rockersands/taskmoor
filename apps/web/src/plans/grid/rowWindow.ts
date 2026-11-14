import { type RefObject, useCallback, useLayoutEffect, useState } from 'react';

/**
 * The rows a long list draws (ADR-122 stage 10, "The pages"): only those in view, with some to
 * spare on either side, and padding above and below standing for the rest, on the Timeline's
 * pattern (fixed rows, an overscan of 20). The Grid's 100,000 rows scroll as a few dozen. The row
 * holding focus stays drawn while scrolled out of view, so keyboard focus never drops to the page.
 * The Timeline keeps its own (`TimelineView.tsx`); this one is the Grid's.
 */

/** A row's height: a touch target (44 px). */
export const GRID_ROW = 44;
export const GRID_OVERSCAN = 20;

export interface RowWindow {
  /** The first row drawn in the run, and one past the last. */
  first: number;
  last: number;
  /** The row kept drawn outside the run (the focused one), or -1. */
  pinned: number;
  /** Space above and below the rows drawn, in pixels. */
  before: number;
  after: number;
}

export interface RowWindowInput {
  count: number;
  /** How far the list is scrolled from its first row, in pixels. */
  top: number;
  /** How tall the view is; at least 20 rows' worth is drawn when it cannot be measured. */
  height: number;
  rowHeight?: number;
  overscan?: number;
  /** The focused row, kept drawn; -1 for none. */
  keep?: number;
}

/** The window over `count` rows of a fixed height: pure, for the hook and its tests. */
export function rowWindow({
  count,
  top,
  height,
  rowHeight = GRID_ROW,
  overscan = GRID_OVERSCAN,
  keep = -1,
}: RowWindowInput): RowWindow {
  const view = Math.max(height, rowHeight * 20);
  const at = Math.max(0, Math.min(top, Math.max(0, count * rowHeight - view)));
  const first = Math.max(0, Math.min(count, Math.floor(at / rowHeight) - overscan));
  const last = Math.max(first, Math.min(count, Math.ceil((at + view) / rowHeight) + overscan));
  const pinned = keep >= 0 && keep < count && (keep < first || keep >= last) ? keep : -1;
  // A row pinned above or below the run takes one row's place in that padding, so the list keeps
  // its height and every other row its place.
  const before = (first - (pinned >= 0 && pinned < first ? 1 : 0)) * rowHeight;
  const after = (count - last - (pinned >= last ? 1 : 0)) * rowHeight;
  return { first, last, pinned, before, after };
}

export interface UseRowWindow extends RowWindow {
  /** Scrolls so a row shows, and draws it at once (it need not wait for the scroll event). */
  scrollToRow: (index: number) => void;
}

/**
 * The window of a scrolling element's rows. `offset` is the space above the first row inside the
 * element (a sticky header row). Scrolling is read once a frame.
 */
export function useRowWindow(
  scroller: RefObject<HTMLElement | null>,
  count: number,
  {
    rowHeight = GRID_ROW,
    overscan = GRID_OVERSCAN,
    keep = -1,
    offset = 0,
  }: { rowHeight?: number; overscan?: number; keep?: number; offset?: number } = {},
): UseRowWindow {
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => {
      setTop(Math.max(0, el.scrollTop - offset));
      setHeight(el.clientHeight);
    };
    read();
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    el.addEventListener('scroll', later, { passive: true });
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    resized?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', later);
      resized?.disconnect();
    };
  }, [scroller, offset]);
  const scrollToRow = useCallback(
    (index: number) => {
      const el = scroller.current;
      if (!el) return;
      const view = Math.max(el.clientHeight - offset, rowHeight);
      const rowTop = index * rowHeight;
      const shown = Math.max(0, el.scrollTop - offset);
      let next = shown;
      if (rowTop < shown) next = rowTop;
      else if (rowTop + rowHeight > shown + view) next = rowTop + rowHeight - view;
      if (next !== shown) el.scrollTop = next + offset;
      setTop(next);
    },
    [scroller, rowHeight, offset],
  );
  return {
    ...rowWindow({ count, top, height: height - offset, rowHeight, overscan, keep }),
    scrollToRow,
  };
}
