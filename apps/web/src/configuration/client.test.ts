import { describe, expect, it } from 'vitest';
import { FIRST_PAGE_TRACK, SECOND_PAGE_TRACK, stubTwoTrackPages } from '../test/trackPages';
import { configurationClient } from './client';
import { trackSetsClient } from './trackSetsClient';

describe('the administrators’ lists of tracks (T-305)', () => {
  it('[CORE-001] lists every track, archived ones too, past the list’s first page', async () => {
    const asked = stubTwoTrackPages();
    expect(await configurationClient.tracks()).toEqual([FIRST_PAGE_TRACK, SECOND_PAGE_TRACK]);
    expect(asked).toEqual([
      '/tracks?archived=include&limit=500',
      '/tracks?archived=include&limit=500&after=AAA',
    ]);
  });

  it('[IAM-010] lists every track whose sets can be changed, past the list’s first page', async () => {
    const asked = stubTwoTrackPages();
    expect(await trackSetsClient.tracks()).toEqual([FIRST_PAGE_TRACK, SECOND_PAGE_TRACK]);
    expect(asked).toEqual(['/tracks?limit=500', '/tracks?limit=500&after=AAA']);
  });
});
