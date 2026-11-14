import { api } from './client';
import { everyPage } from './pages';

/**
 * Every track `GET /me/managed-tracks` says the person runs, following its pages (500 a page, by
 * key). A reader of the first page alone left out every track past the 500th (T-310): someone
 * who runs more could not reach those tracks' Manage pages or their own sets.
 */
export function everyManagedTrack<T>(): Promise<T[]> {
  return everyPage<T, string>(async (after) => {
    const path =
      after === null
        ? '/me/managed-tracks'
        : `/me/managed-tracks?${new URLSearchParams({ after })}`;
    const page: { tracks: T[]; next?: string | null } = await api(path);
    return { items: page.tracks, next: page.next };
  });
}
