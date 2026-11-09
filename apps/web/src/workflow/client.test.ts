import { describe, expect, it } from 'vitest';
import { stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { workflowsClient } from './client';
import type { WorkflowDefinition } from './definition';

describe('the workflows client (M1-030)', () => {
  it('[WF-008] saves a draft as the editor shows it, so a free move deleted on purpose stays deleted', async () => {
    // Waiting (7) was added in the editor, which gave it a free move; the administrator deleted it.
    const definition: WorkflowDefinition = {
      initialStatusId: 1,
      statuses: [{ statusId: 1 }, { statusId: 7 }],
      transitions: [{ id: 1, name: 'New', from: 'any', to: 1 }],
    };
    const calls = stubBackend({
      'PUT /workflows/5/draft': () => jsonResponse(200, { workflow: { id: 5 } }),
    });
    await workflowsClient.saveDraft(5, definition);
    expect(calls).toEqual([
      {
        method: 'PUT',
        path: '/workflows/5/draft',
        body: { definition, transitionsAsSent: true },
      },
    ]);
  });
});
