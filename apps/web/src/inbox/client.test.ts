import { describe, expect, it } from 'vitest';
import { FIRST_PAGE_TRACK, SECOND_PAGE_TRACK, stubTwoTrackPages } from '../test/trackPages';
import { inboxClient } from './client';

describe('the inbox’s track filter (T-305)', () => {
  it('[NTF-003] offers every track, past the list’s first page', async () => {
    const asked = stubTwoTrackPages();
    expect(await inboxClient.tracks()).toEqual([FIRST_PAGE_TRACK, SECOND_PAGE_TRACK]);
    expect(asked).toEqual(['/tracks?limit=500', '/tracks?limit=500&after=AAA']);
  });
});
