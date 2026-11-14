import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackScopeClient } from '../sets/trackScope';
import { jsonResponse } from '../test/setup';
import { trackPeopleClient } from '../trackpeople/client';

/**
 * `GET /me/managed-tracks` in two pages (T-310): the first holds AAA and says the list goes on,
 * the page after it holds ZZZ. Returns the paths asked, without the API base, in order.
 */
function stubTwoPages(): string[] {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.replace(/^\/api\/v1/, '');
      asked.push(path);
      const after = new URL(url, 'http://x').searchParams.get('after');
      return after === null
        ? jsonResponse(200, {
            tracks: [{ id: 1, key: 'AAA', name: 'Alpha', mode: 'local' }],
            next: 'cursor-after-AAA',
          })
        : jsonResponse(200, {
            tracks: [{ id: 2, key: 'ZZZ', name: 'Zulu', mode: 'local' }],
            next: null,
          });
    }),
  );
  return asked;
}

describe('every track a person runs (T-310)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[IAM-030] the Tracks you run page reads every page, not the first 500 alone', async () => {
    const asked = stubTwoPages();
    expect((await trackPeopleClient.managedTracks()).map((t) => t.key)).toEqual(['AAA', 'ZZZ']);
    expect(asked).toEqual(['/me/managed-tracks', '/me/managed-tracks?after=cursor-after-AAA']);
  });

  it('[IAM-030] the pages of sets offer a track past the first page that the person runs', async () => {
    const asked = stubTwoPages();
    expect((await trackScopeClient.managedTracks()).map((t) => t.key)).toEqual(['AAA', 'ZZZ']);
    expect(asked).toEqual(['/me/managed-tracks', '/me/managed-tracks?after=cursor-after-AAA']);
  });
});
