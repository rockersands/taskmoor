import { describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../test/setup';
import { FIRST_PAGE_TRACK, SECOND_PAGE_TRACK, stubTwoTrackPages } from '../test/trackPages';
import { planClient } from './client';

describe('the sources a plan may take (T-305)', () => {
  it('[PLN-001] offers every track as a source, past the list’s first page', async () => {
    const asked = stubTwoTrackPages({
      '/saved-searches': { savedSearches: [{ id: 7, name: 'Open bugs', owner: 'Ana' }] },
    });
    const options = await planClient.sourceOptions();
    expect(options.tracks).toEqual([FIRST_PAGE_TRACK, SECOND_PAGE_TRACK]);
    expect(options.savedSearches).toEqual([{ id: 7, name: 'Open bugs' }]);
    expect(asked.filter((path) => path.startsWith('/tracks'))).toEqual([
      '/tracks?limit=500',
      '/tracks?limit=500&after=AAA',
    ]);
  });

  it('[PLN-001] offers a track past the first thousand, read 500 at a time', async () => {
    // 1,203 tracks sorted by key, as the server pages them: `limit`, after `after`, `next` the
    // last key while more follow.
    const all = Array.from({ length: 1_203 }, (_, i) => {
      const key = `T${String(i + 1).padStart(4, '0')}`;
      return { id: i + 1, key, name: `Track ${key}` };
    });
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = url.replace(/^\/api\/v1/, '');
        asked.push(path);
        if (path === '/saved-searches') return jsonResponse(200, { savedSearches: [] });
        const params = new URL(url, 'http://x').searchParams;
        const limit = Number(params.get('limit') ?? 100);
        const after = params.get('after');
        const rest = all.filter((t) => after === null || t.key > after);
        const page = rest.slice(0, limit);
        const next = rest.length > limit ? (page[page.length - 1]?.key ?? null) : null;
        return jsonResponse(200, { tracks: page, next });
      }),
    );
    const options = await planClient.sourceOptions();
    expect(options.tracks).toHaveLength(1_203);
    expect(options.tracks.at(-1)).toEqual({ id: 1_203, key: 'T1203', name: 'Track T1203' });
    expect(asked.filter((path) => path.startsWith('/tracks'))).toEqual([
      '/tracks?limit=500',
      '/tracks?limit=500&after=T0500',
      '/tracks?limit=500&after=T1000',
    ]);
  });
});
