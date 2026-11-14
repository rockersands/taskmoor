import { describe, expect, it } from 'vitest';
import { FIRST_PAGE_TRACK, SECOND_PAGE_TRACK, stubTwoTrackPages } from '../../test/trackPages';
import { cloneClient } from './client';

describe('the tracks a clone may go to (T-305)', () => {
  it('[CORE-023] offers every track, past the list’s first page', async () => {
    const asked = stubTwoTrackPages();
    expect(await cloneClient.tracks()).toEqual([FIRST_PAGE_TRACK, SECOND_PAGE_TRACK]);
    expect(asked).toEqual(['/tracks?limit=500', '/tracks?limit=500&after=AAA']);
  });
});
