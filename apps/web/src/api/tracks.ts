import { api } from './client';

/** Tracks a picker holds at most, a backstop against a list that never ends. */
const MOST = 10_000;

/**
 * Every track `GET /tracks` gives the viewer, following its pages (500 a page, by key). A picker
 * that read one page alone left out every track past it (T-305): with more than 100 tracks, the
 * create dialog could not choose the rest. `query` adds filters, such as `archived=include`.
 */
export async function everyTrack<T>(query = ''): Promise<T[]> {
  const all: T[] = [];
  let after: string | null = null;
  do {
    const params = new URLSearchParams(query);
    params.set('limit', '500');
    if (after !== null) params.set('after', after);
    const page: { tracks: T[]; next?: string | null } = await api(`/tracks?${params}`);
    all.push(...page.tracks);
    after = page.next ?? null;
  } while (after !== null && all.length < MOST);
  return all;
}
