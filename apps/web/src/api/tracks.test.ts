import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../test/setup';
import { everyTrack } from './tracks';

describe('every track a picker offers (T-305)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[CORE-001] follows the list’s pages, so a track past the first page can be chosen', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const after = new URL(url, 'http://x').searchParams.get('after');
        return after === null
          ? jsonResponse(200, { tracks: [{ key: 'AAA' }, { key: 'BBB' }], next: 'BBB' })
          : jsonResponse(200, { tracks: [{ key: 'ZZZ' }], next: null });
      }),
    );
    expect(await everyTrack<{ key: string }>('archived=include')).toEqual([
      { key: 'AAA' },
      { key: 'BBB' },
      { key: 'ZZZ' },
    ]);
    expect(urls.map((u) => u.slice(u.indexOf('?')))).toEqual([
      '?archived=include&limit=500',
      '?archived=include&limit=500&after=BBB',
    ]);
  });
});
