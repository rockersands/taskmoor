import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Puts a dialog and its veil, or the command palette, at the end of the page's body (D3, T-220).
 *
 * A glass surface blurs what is behind it, and an element with a `backdrop-filter` holds every
 * fixed element inside it: the top bar's blur kept the palette's veil to the bar, and a card's
 * kept a dialog opened from it to the card. Rendered here, a fixed surface is placed by the window
 * wherever in the page it was opened from. React still treats it as a child of its opener, so
 * context, events and focus work as before.
 */
export function OverlayLayer({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
