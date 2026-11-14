import { describe, expect, it } from 'vitest';
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
});
