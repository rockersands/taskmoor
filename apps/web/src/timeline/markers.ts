import type { useT } from '../i18n/I18nProvider';

/** A release as the Timeline and the Calendar receive it; a plan's say which it is lined up with. */
export interface ReleaseMarker {
  id: number;
  name: string;
  date: string;
  shipped: boolean;
  /** The release across tracks it is in (PLN-007); only a plan's views send it. */
  crossTrack?: { id: number; name: string; date: string | null } | null;
}

/** One diamond: a release, or the linked releases that share their release across tracks' day. */
export interface DrawnRelease {
  key: string;
  date: string;
  name: string;
  /** How many linked releases it stands for; 0 for a release of its own. */
  count: number;
  /** A linked release on another day than its release across tracks: it keeps its own marker. */
  outOfStep: boolean;
}

/**
 * Linked releases on their release across tracks' day become one marker named for it, with how
 * many they are; those on another day keep their own, marked in words (ADR-122 stage 4). A shipped
 * release is on the day it shipped and reads as what it is, so it is never out of step.
 */
export function drawnReleases(releases: readonly ReleaseMarker[]): DrawnRelease[] {
  const together = new Map<string, DrawnRelease>();
  const out: DrawnRelease[] = [];
  for (const r of releases) {
    const cross = r.crossTrack;
    if (cross && cross.date === r.date) {
      const key = `c${cross.id}`;
      const drawn = together.get(key);
      if (drawn) drawn.count++;
      else {
        const made = { key, date: r.date, name: cross.name, count: 1, outOfStep: false };
        together.set(key, made);
        out.push(made);
      }
      continue;
    }
    out.push({
      key: `r${r.id}`,
      date: r.date,
      name: r.name,
      count: 0,
      outOfStep: Boolean(cross?.date) && !r.shipped,
    });
  }
  return out;
}

/** What a marker says, in words: never by colour alone. */
export function releaseMarkerText(t: ReturnType<typeof useT>, r: DrawnRelease): string {
  if (r.count > 0) return t('timeline.release.together', { name: r.name, count: r.count });
  return r.outOfStep ? t('timeline.release.outOfStep', { name: r.name }) : r.name;
}
