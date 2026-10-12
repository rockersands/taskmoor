import { useSyncExternalStore } from 'react';

/** Below this width the sidebar turns into a drawer. Desktop is the primary layout. */
export const COMPACT_QUERY = '(max-width: 767px)';

/** Tracks a CSS media query and re-renders when it starts or stops matching. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
