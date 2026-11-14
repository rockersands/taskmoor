import { api } from './client';
import { everyPage } from './pages';

/**
 * Every track `GET /tracks` gives the viewer, following its pages (500 a page, by key). A picker
 * that read one page alone left out every track past it (T-305): with more than 100 tracks, the
 * create dialog could not choose the rest. `query` adds filters, such as `archived=include`.
 */
export function everyTrack<T>(query = ''): Promise<T[]> {
  return everyPage<T, string>(async (after) => {
    const params = new URLSearchParams(query);
    params.set('limit', '500');
    if (after !== null) params.set('after', after);
    const page: { tracks: T[]; next?: string | null } = await api(`/tracks?${params}`);
    return { items: page.tracks, next: page.next };
  });
}
