import { type RefObject, useLayoutEffect, useRef, useState } from 'react';

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
 * It measures again when the strip scrolls, when the strip itself changes size, and when what it
 * holds does (T-275): each element directly inside is watched for size, so a table that grows
 * wider after the first paint (columns added, longer values loaded later) turns the fade on, and
 * an element added directly inside is watched from then on. Content whose own box keeps the
 * strip's width while something deeper overflows it is not seen; a table or a `max-content` grid
 * carries its width. React state changes only when the answer does, never per scroll frame.
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
  const shown = useRef(more);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new contents measure anew
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = () => {
      const now = moreSides(element);
      if (now === shown.current) return;
      shown.current = now;
      setMore(now);
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    const watched = new Set<Element>();
    // The strip and each element directly inside it: a child that grows wider changes the
    // strip's scroll width without changing the strip's own size.
    const watchContents = () => {
      if (!sizes) return;
      for (const child of Array.from(element.children)) {
        if (watched.has(child)) continue;
        watched.add(child);
        sizes.observe(child);
      }
      for (const child of watched) {
        if (child.parentElement === element) continue;
        watched.delete(child);
        sizes.unobserve(child);
      }
    };
    sizes?.observe(element);
    watchContents();
    // Elements added or taken away directly inside: watched or let go, and measured at once.
    const changes =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            watchContents();
            update();
          });
    changes?.observe(element, { childList: true });
    return () => {
      element.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      sizes?.disconnect();
      changes?.disconnect();
    };
  }, [scroller, contents]);
  return more;
}
