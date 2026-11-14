import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../test/setup';
import { savedSearchClient } from './savedClient';

const saved = (id: number, name: string) => ({
  id,
  name,
  description: '',
  query: 'track = SHOP',
  columns: null,
  owner: { id: 1, name: 'Ana' },
  shares: [],
  starred: false,
  editable: true,
  version: 1,
});

describe('the saved searches the bar offers (T-310)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[QRY-011] reads every page of them, not the first 500 alone', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(url.replace(/^\/api\/v1/, ''));
        const after = new URL(url, 'http://x').searchParams.get('after');
        return after === null
          ? jsonResponse(200, { savedSearches: [saved(4, 'Alpha')], next: 'after-4' })
          : jsonResponse(200, { savedSearches: [saved(2, 'Zulu')], next: null });
      }),
    );
    expect((await savedSearchClient.list()).map((s) => s.name)).toEqual(['Alpha', 'Zulu']);
    expect(asked).toEqual(['/saved-searches', '/saved-searches?after=after-4']);
  });
});
