const RECENT = 'taskmoor.recentTracks';
/** Enough for the Home page's short list. */
const KEPT = 12;

/** The tracks opened lately in this browser, the latest first; a convenience, never a right. */
export function recentTracks(): string[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(RECENT) ?? '[]');
    return Array.isArray(saved) ? saved.filter((key) => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberTrack(key: string) {
  try {
    window.localStorage.setItem(
      RECENT,
      JSON.stringify([key, ...recentTracks().filter((k) => k !== key)].slice(0, KEPT)),
    );
  } catch {
    // Not kept in this browser: the list falls back to names.
  }
}
