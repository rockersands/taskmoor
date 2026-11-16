import { describe, expect, it } from 'vitest';
import { stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
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

describe('the status mapping calls (T-320)', () => {
  const impact = { ticketCount: 0, lostStatuses: [], targetWorkflows: [] };

  it('[WF-001] previews a track’s switch, to the default map too, and a map’s change', async () => {
    const calls = stubBackend({
      'GET /tracks/3/workflow-map/impact?workflowMapId=default': () =>
        jsonResponse(200, { impact }),
      'GET /tracks/3/workflow-map/impact?workflowMapId=22': () => jsonResponse(200, { impact }),
      'POST /workflow-maps/22/impact': () => jsonResponse(200, { impact }),
    });
    expect(await configurationClient.trackMapImpact(3, 'default')).toEqual(impact);
    expect(await configurationClient.trackMapImpact(3, 22)).toEqual(impact);
    const change = { defaultWorkflowId: 2, entries: [{ ticketTypeId: 5, workflowId: 1 }] };
    expect(await configurationClient.workflowMapImpact(22, change)).toEqual(impact);
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: '/workflow-maps/22/impact',
      body: change,
    });
  });

  it('[WF-001] switches a track’s map with a mapping, and says what moves', async () => {
    const moving = { id: 9, status: 'running', total: 600, migrated: 500 };
    const calls = stubBackend({
      'PATCH /tracks/3': (body) =>
        jsonResponse(200, {
          track: { id: 3 },
          ...((body as { typeStatusMapping?: unknown }).typeStatusMapping
            ? { statusMigration: moving }
            : {}),
        }),
      'GET /workflow-migrations/9': () =>
        jsonResponse(200, { statusMigration: { ...moving, status: 'done', migrated: 600 } }),
    });
    expect(await configurationClient.switchWorkflowMap(3, null)).toEqual({
      track: { id: 3 },
      statusMigration: null,
    });
    const mapping = { '5': { '3': 11 } };
    expect(await configurationClient.switchWorkflowMap(3, 22, mapping)).toEqual({
      track: { id: 3 },
      statusMigration: moving,
    });
    expect(calls.map((c) => c.body)).toEqual([
      { workflowMapId: null },
      { workflowMapId: 22, typeStatusMapping: mapping },
    ]);
    expect(await configurationClient.statusMigration(9)).toMatchObject({ status: 'done' });
  });

  it('[WF-001] saves a map, with no migration when no ticket moves', async () => {
    stubBackend({
      'PATCH /workflow-maps/22': () => jsonResponse(200, { workflowMap: { id: 22 } }),
    });
    expect(await configurationClient.updateWorkflowMap(22, { defaultWorkflowId: 2 })).toEqual({
      workflowMap: { id: 22 },
      statusMigration: null,
    });
  });
});
