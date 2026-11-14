import { describe, expect, it } from 'vitest';
import { draftCalls } from './drafting';
import type { DraftInput, ScenarioClient } from './scenarioClient';

/** The stage 1 seam in a scenario (T-089e; ADR-122 stage 6), against a client that keeps what it is sent. */
function calls() {
  const sent: DraftInput[][] = [];
  const client = {
    draft: async (_planId: number, _sid: number, changes: DraftInput[]) => {
      sent.push(changes);
      return { ok: true, value: {} };
    },
  } as unknown as ScenarioClient;
  const seam = draftCalls(
    12,
    { id: 2, name: 'Faster', main: false, drafts: 1, notShown: 0, editable: true },
    client,
    (key) => (key === 'SHOP-2' ? 2 : undefined),
  );
  return { seam, sent };
}

describe('drafting from a view (PLN-002)', () => {
  it('[PLN-002] undoes a ticket’s draft of its team alone by writing its team now back', async () => {
    const { seam, sent } = calls();
    const outcome = await seam.undo({
      key: 'SHOP-2',
      draft: { fields: { '5': { now: 7 } }, stale: false },
    });
    expect(outcome).toEqual({ ok: true });
    expect(sent).toEqual([[{ ticketId: 2, fields: { '5': 7 } }]]);
  });

  it('[PLN-002] undoes drafted days and a drafted team together', async () => {
    const { seam, sent } = calls();
    await seam.undo({
      key: 'SHOP-2',
      draft: { dueDate: { now: '2026-11-10' }, fields: { '5': { now: null } }, stale: true },
    });
    expect(sent).toEqual([[{ ticketId: 2, dueDate: '2026-11-10', fields: { '5': null } }]]);
  });
});
