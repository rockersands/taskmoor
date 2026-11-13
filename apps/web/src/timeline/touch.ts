import { COMPACT_QUERY, useMediaQuery } from '../shell/useMediaQuery';

/** A finger, not a mouse, points at the page. */
export const COARSE_QUERY = '(pointer: coarse)';

/**
 * Whether the page speaks of fingers rather than keys (D6): on a phone's width or under a touch
 * screen's pointer, the Timeline and the Calendar hide their keyboard instructions and say, in
 * the Tracks page's manner, what a finger can do.
 */
export function useTouchWording(): boolean {
  const compact = useMediaQuery(COMPACT_QUERY);
  const coarse = useMediaQuery(COARSE_QUERY);
  return compact || coarse;
}
