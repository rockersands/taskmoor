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
    expect(await visibilityClient.fields(null)).toEqual(expected);
    expect(fieldName(expected as never, 'cf[32]')).toBe('Approving team');
    // A field that is gone keeps its key, the only name left.
    expect(fieldName(expected as never, 'cf[99]')).toBe('cf[99]');
  });
});

describe('a local-mode track’s own visibility policies (T-322)', () => {
  const OPS = {
    id: 4,
    key: 'OPS',
    name: 'Operations',
    mode: 'local' as const,
    archived: false,
    typeSetId: 30,
    fieldRuleSetId: null,
    layoutSetId: null,
  };

  it('[IAM-011] [IAM-030] reads, makes and uses the track’s own policies, with the lists its runners may read', async () => {
    const calls = stubBackend({
      'GET /visibility-policies?trackId=4': () => jsonResponse(200, { visibilityPolicies: [] }),
      'POST /visibility-policies': () => jsonResponse(201, { visibilityPolicy: { id: 9 } }),
      'PATCH /tracks/4': () => jsonResponse(200, { track: { id: 4 } }),
      'GET /tracks/4/roles': () =>
        jsonResponse(200, {
          roles: [{ id: 7, name: 'Administrators', runsTrack: true, givable: true }],
        }),
      'GET /people/mentionable?track=OPS&limit=8&q=ola': () =>
        jsonResponse(200, { people: [{ id: 9, name: 'Ola Night' }] }),
      'GET /fields?trackId=4': () =>
        jsonResponse(200, {
          fields: [
            { id: 31, name: 'Reviewer', type: 'user', trackId: null },
            { id: 44, name: 'On call', type: 'user', trackId: 4 },
            { id: 45, name: 'Shift', type: 'select', trackId: 4 },
          ],
        }),
      'GET /groups': () => jsonResponse(403, { error: 'forbidden' }),
    });
    expect(await visibilityClient.policies(4)).toEqual([]);
    await visibilityClient.createPolicy({ name: 'Night desk', trackId: 4 });
    await visibilityClient.chooseFor(4, 9);
    expect(calls.slice(1, 3)).toEqual([
      {
        method: 'POST',
        path: '/visibility-policies',
        body: { name: 'Night desk', trackId: 4 },
      },
      { method: 'PATCH', path: '/tracks/4', body: { visibilityPolicyId: 9 } },
    ]);
    expect(await visibilityClient.roles(OPS)).toEqual([{ id: 7, name: 'Administrators' }]);
    expect(await visibilityClient.findPeople('ola', OPS)).toEqual([{ id: 9, name: 'Ola Night' }]);
    expect(await visibilityClient.fields(OPS)).toEqual([
      { key: 'cf[31]', name: 'Reviewer', type: 'user', trackId: null },
      { key: 'cf[44]', name: 'On call', type: 'user', trackId: 4 },
    ]);
    // Groups are listed for administrators only: someone who runs the track gets none.
    expect(await visibilityClient.groups()).toEqual([]);
  });
});
