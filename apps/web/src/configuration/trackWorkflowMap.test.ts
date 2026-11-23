import { describe, expect, it } from 'vitest';
import { stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { configurationClient } from './client';

describe('a local-mode track’s own workflow map (T-322)', () => {
  it('[WF-001] [IAM-030] reads the track’s map with the types it offers, and the workflows it may name', async () => {
    const map = {
      id: 21,
      name: 'OPS workflows',
      description: '',
      isDefault: false,
      trackId: 4,
      defaultWorkflow: { id: 1, name: 'Default workflow' },
      entries: [],
      tracks: [{ id: 4, key: 'OPS', name: 'Operations' }],
    };
    const ticketTypes = [
      { ticketType: { id: 6, name: 'Task' }, workflow: { id: 1, name: 'Default workflow' } },
    ];
    const calls = stubBackend({
      'GET /tracks/4/workflow-map': () => jsonResponse(200, { workflowMap: map, ticketTypes }),
      'GET /workflows?trackId=4': () =>
        jsonResponse(200, {
          workflows: [
            { id: 1, name: 'Default workflow', isDefault: true, trackId: null, trackCount: 3 },
            { id: 3, name: 'Runbook flow', isDefault: false, trackId: 4, trackCount: 1 },
          ],
        }),
    });
    expect(await configurationClient.trackWorkflowMap(4)).toEqual({
      workflowMap: map,
      ticketTypes,
    });
    expect(await configurationClient.trackWorkflows(4)).toEqual([
      { id: 1, name: 'Default workflow', trackId: null },
      { id: 3, name: 'Runbook flow', trackId: 4 },
    ]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /tracks/4/workflow-map',
      'GET /workflows?trackId=4',
    ]);
  });
});
