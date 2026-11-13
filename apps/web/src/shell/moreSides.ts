import { type RefObject, useLayoutEffect, useState } from 'react';

/** Which ends of a sideways scroller have more beyond them, for the fade that says so. */
export type MoreSides = 'none' | 'start' | 'end' | 'both';

export function moreSides(scroller: HTMLElement): MoreSides {
  const before = scroller.scrollLeft > 1;
  const after = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
  return before && after ? 'both' : before ? 'start' : after ? 'end' : 'none';
}

/**
 * Keeps `data-more` on a sideways scroller current: which of its ends hide more, so a fade can say
 * so (the page-review faults TR-4, TR-23 and D17). Returns the value for the first paint. The one
 * helper for every such scroller: a track's tab bar, Account's sections, a board, a report table.
 *
 * The fade itself is each stylesheet's, and lifts while focus is in the strip, so a focus ring is
 * never faded out: `:not(:focus-within)` on the tab bar, the board and report tables, and
 * `:not(:has(:focus-visible))` on Account's sections, whose link keeps focus after a tap and so
 * keeps its fade until the keyboard is used (design.test.ts holds both).
 */
export function useMoreSides(
  scroller: RefObject<HTMLElement | null>,
  /** Changes whenever what the scroller holds may have changed width. */
  contents: unknown,
): MoreSides {
  const [more, setMore] = useState<MoreSides>('none');
  // biome-ignore lint/correctness/useExhaustiveDependencies: new contents measure anew
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = () => setMore(moreSides(element));
    update();
    element.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [scroller, contents]);
  return more;
}
