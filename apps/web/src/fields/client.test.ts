import { describe, expect, it } from 'vitest';
import { stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { fieldsClient, trackFieldsClient } from './client';

const OPS = { id: 4, key: 'OPS', name: 'Operations' };
const GROUPS = [
  { id: 21, name: 'Reviewers', description: '', memberCount: 3, childCount: 0 },
  { id: 22, name: 'Release reviewers', description: '', memberCount: 1, childCount: 0 },
];

describe('the groups a group field’s default names (T-322)', () => {
  it('[CORE-009] reads the site’s list, which site and configuration administrators may always read', async () => {
    const calls = stubBackend({
      'GET /groups?query=rev': () => jsonResponse(200, { groups: GROUPS }),
    });
    const found = [
      { id: 21, name: 'Reviewers' },
      { id: 22, name: 'Release reviewers' },
    ];
    expect(await fieldsClient.findGroups(31, 'rev')).toEqual(found);
    // An administrator on a track's own page keeps it.
    expect(await trackFieldsClient(fieldsClient, OPS, true).findGroups(31, 'rev')).toEqual(found);
    expect(calls.map((c) => c.path)).toEqual(['/groups?query=rev', '/groups?query=rev']);
  });

  it('[CORE-009] [IAM-030] finds them through the field for someone who only runs the track', async () => {
    const calls = stubBackend({
      'GET /fields/31/groups?q=rev&limit=8': () =>
        jsonResponse(200, { groups: [{ id: 21, name: 'Reviewers' }] }),
    });
    expect(await trackFieldsClient(fieldsClient, OPS, false).findGroups(31, 'rev')).toEqual([
      { id: 21, name: 'Reviewers' },
    ]);
    expect(calls.map((c) => c.path)).toEqual(['/fields/31/groups?q=rev&limit=8']);
  });
});
