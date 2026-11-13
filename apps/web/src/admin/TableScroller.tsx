import type { ReactNode } from 'react';

/**
 * A wide table's sideways scroller. It can take the keyboard's focus and is named after its table,
 * so someone without a mouse reaches what does not fit (AD-3; axe scrollable-region-focusable).
 */
export function TableScroller({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must take focus to scroll by keyboard
    <section className="api-usage-table-wrap" tabIndex={0} aria-label={label}>
      {children}
    </section>
  );
}
