import { describe, expect, it } from 'vitest';
import { FIRST_PAGE_TRACK, SECOND_PAGE_TRACK, stubTwoTrackPages } from '../test/trackPages';
import { explainClient } from './visibilityClient';

describe('the permission explainer’s track choices (T-305)', () => {
  it('[IAM-012] offers every track, past the list’s first page', async () => {
    const asked = stubTwoTrackPages();
    expect(await explainClient.tracks()).toEqual([FIRST_PAGE_TRACK, SECOND_PAGE_TRACK]);
    expect(asked).toEqual(['/tracks?limit=500', '/tracks?limit=500&after=AAA']);
  });
});
