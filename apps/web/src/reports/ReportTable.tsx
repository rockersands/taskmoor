import { type ReactNode, useRef } from 'react';
import { useMoreSides } from '../tracks/TrackLayout';

/**
 * A report's table in a region of its own that scrolls sideways when the card is narrower than the
 * table: reached by keyboard to scroll it, and faded at the edge past which more columns wait, so
 * a cut column reads as "more this way" (the page-review fault TR-12; D2's cue).
 */
export function ReportTable({ label, children }: { label: string; children: ReactNode }) {
  const region = useRef<HTMLElement>(null);
  const more = useMoreSides(region, children);
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
    <section ref={region} className="report-table" data-more={more} aria-label={label} tabIndex={0}>
      {children}
    </section>
  );
}
