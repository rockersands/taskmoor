import { describe, expect, it } from 'vitest';
import { stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { FIRST_PAGE_TRACK, SECOND_PAGE_TRACK, stubTwoTrackPages } from '../test/trackPages';
import { fieldName, permissionsClient } from './client';
import { explainClient, visibilityClient } from './visibilityClient';

describe('the permission explainer’s track choices (T-305)', () => {
  it('[IAM-012] offers every track, past the list’s first page', async () => {
    const asked = stubTwoTrackPages();
    expect(await explainClient.tracks()).toEqual([FIRST_PAGE_TRACK, SECOND_PAGE_TRACK]);
    expect(asked).toEqual(['/tracks?limit=500', '/tracks?limit=500&after=AAA']);
  });
});

describe('the fields a field grantee names (T-320)', () => {
  it('[IAM-010] [IAM-011] offers the user and group fields by key and name, and nothing else', async () => {
    stubBackend({
      'GET /fields': () =>
        jsonResponse(200, {
          fields: [
            { id: 31, name: 'Reviewer', type: 'user', trackId: null },
            { id: 32, name: 'Approving team', type: 'group', trackId: null },
            { id: 33, name: 'Shop contact', type: 'user', trackId: 3 },
            { id: 34, name: 'Region', type: 'select', trackId: null },
          ],
        }),
    });
    const expected = [
      { key: 'cf[31]', name: 'Reviewer', type: 'user', trackId: null },
      { key: 'cf[32]', name: 'Approving team', type: 'group', trackId: null },
      { key: 'cf[33]', name: 'Shop contact', type: 'user', trackId: 3 },
    ];
    expect(await permissionsClient.fields()).toEqual(expected);
    expect(await visibilityClient.fields()).toEqual(expected);
    expect(fieldName(expected as never, 'cf[32]')).toBe('Approving team');
    // A field that is gone keeps its key, the only name left.
    expect(fieldName(expected as never, 'cf[99]')).toBe('cf[99]');
  });
});
