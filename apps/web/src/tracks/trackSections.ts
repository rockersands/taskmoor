import { createContext, useContext, useEffect, useState } from 'react';
import type { TrackClient, TrackSections } from './client';

/** What was last read per track, so a track's tabs do not wait or jump on each section. */
const known = new Map<string, TrackSections>();
const watchers = new Set<(key: string) => void>();
const id = (key: string) => key.toUpperCase();

/** Says a track's sections may have changed (its board's kind did): open tab bars read them again. */
export function trackSectionsChanged(key: string): void {
  for (const watcher of watchers) watcher(id(key));
}

/**
 * The sections a track has beyond those every track has (ADR-116), for its tab bar. Null until the
 * first answer, so a Kanban track never shows a Backlog tab, even for a moment. It is read again on
 * each change of section, so someone else's change of the board's kind reaches the next page.
 */
export function useLoadedTrackSections(
  trackKey: string,
  client: TrackClient,
  section: string,
): TrackSections | null {
  const [sections, setSections] = useState(() => known.get(id(trackKey)) ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of section reads them again
  useEffect(() => {
    let live = true;
    const read = () =>
      client.sections(trackKey).then(
        (answer) => {
          known.set(id(trackKey), answer);
          if (live) setSections(answer);
        },
        () => {},
      );
    setSections(known.get(id(trackKey)) ?? null);
    void read();
    const watcher = (key: string) => {
      if (key === id(trackKey)) void read();
    };
    watchers.add(watcher);
    return () => {
      live = false;
      watchers.delete(watcher);
    };
  }, [client, trackKey, section]);
  return sections;
}

/** The sections of the track around a page; null outside a track or until they are known. */
export const TrackSectionsContext = createContext<TrackSections | null>(null);
export const useTrackSections = () => useContext(TrackSectionsContext);
