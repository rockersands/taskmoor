import { vi } from 'vitest';
import { jsonResponse } from './setup';

/** The first page's track and the one only the second page holds. */
export const FIRST_PAGE_TRACK = { id: 1, key: 'AAA', name: 'Alpha' };
export const SECOND_PAGE_TRACK = { id: 2, key: 'ZZZ', name: 'Zulu' };

/**
 * `GET /tracks` in two pages, whatever the page size asked (T-305): the first page holds AAA and
 * says the list goes on, the page after AAA holds ZZZ. A reader that stops at the first page
 * misses ZZZ. `others` answers other paths with 200 and the body given. Returns the paths asked,
 * without the API base, in order.
 */
export function stubTwoTrackPages(others: Record<string, unknown> = {}): string[] {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.replace(/^\/api\/v1/, '');
      asked.push(path);
      if (path in others) return jsonResponse(200, others[path]);
      if (!path.startsWith('/tracks?') && path !== '/tracks') {
        return jsonResponse(404, { error: 'not_found' });
      }
      const after = new URL(url, 'http://x').searchParams.get('after');
      return after === null
        ? jsonResponse(200, { tracks: [FIRST_PAGE_TRACK], next: 'AAA' })
        : jsonResponse(200, { tracks: [SECOND_PAGE_TRACK], next: null });
    }),
  );
  return asked;
}
