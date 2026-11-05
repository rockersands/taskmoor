import { describe, expect, it } from 'vitest';
import { followingStage, statusesWantingFreeMove } from './free-moving';
import type { WorkflowDefinition } from './model';

/** Free moves that follow a status's stage (T-209) and the ones a saved draft gets (T-210). */
const CLEAR = [{ type: 'clear-field' as const, field: 'close-reason' }];
const SETS = (id: number) => [
  { type: 'update-system-field' as const, field: 'close-reason' as const, value: String(id) },
];

const free: WorkflowDefinition = {
  initialStatusId: 1,
  statuses: [{ statusId: 1 }, { statusId: 2 }, { statusId: 3 }],
  transitions: [
    { id: 1, name: 'New', from: 'any', to: 1, effects: CLEAR },
    { id: 2, name: 'Review', from: 'any', to: 2, effects: CLEAR },
    { id: 3, name: 'Closed', from: 'any', to: 3, effects: SETS(9) },
  ],
};

describe('free moves follow a status stage (WF-008)', () => {
  it('[WF-008] a free move into a status made closed-stage sets the reason, and clears it when it leaves', () => {
    const closing = followingStage(free, 2, true, 9);
    expect(closing?.transitions[1]?.effects).toEqual(SETS(9));
    expect(closing?.transitions.filter((t) => t.id !== 2)).toEqual(
      free.transitions.filter((t) => t.id !== 2),
    );
    const opening = followingStage(free, 3, false, 9);
    expect(opening?.transitions[2]?.effects).toEqual(CLEAR);
  });

  it('[WF-008] nothing changes without a reason, on a board, or where someone chose otherwise', () => {
    expect(followingStage(free, 2, true, null)).toBeNull();
    expect(followingStage(free, 3, false, null)).toBeNull();
    // Already what the stage asks: nothing to do.
    expect(followingStage(free, 3, true, 9)).toBeNull();
    expect(followingStage(free, 1, false, 9)).toBeNull();
    // Another reason someone chose stays, in whichever stage.
    expect(followingStage(free, 3, false, 8)).toBeNull();
    expect(
      followingStage({ ...free, board: { boardId: 1, columns: [1, 2, 3] } }, 2, true, 9),
    ).toBeNull();
    const ruled = {
      ...free,
      transitions: free.transitions.map((t) =>
        t.id === 2 ? { ...t, checks: [{ type: 'field-required' as const, field: 'assignee' }] } : t,
      ),
    };
    expect(followingStage(ruled, 2, true, 9)).toBeNull();
    expect(
      followingStage({ ...free, rules: { '2': [] } }, 2, true, 9)?.transitions[1]?.effects,
    ).toEqual(SETS(9));
    expect(
      followingStage(
        { ...free, rules: { '2': [{ type: 'assign', to: { user: '1' } }] } } as never,
        2,
        true,
        9,
      ),
    ).toBeNull();
    const more = {
      ...free,
      transitions: free.transitions.map((t) =>
        t.id === 2 ? { ...t, effects: [...CLEAR, { type: 'assign-to-current-user' as const }] } : t,
      ),
    };
    expect(followingStage(more, 2, true, 9)).toBeNull();
    const step = {
      ...free,
      transitions: free.transitions.map((t) => (t.id === 2 ? { ...t, from: [1] } : t)),
    };
    expect(followingStage(step, 2, true, 9)).toBeNull();
  });
});

describe('free moves a saved draft gets (WF-008)', () => {
  const added = { ...free, statuses: [...free.statuses, { statusId: 4 }] };

  it('[WF-008] a status the draft adds to a free-moving workflow, and every status of an empty one', () => {
    expect(statusesWantingFreeMove(free, added)).toEqual([4]);
    expect(statusesWantingFreeMove(free, { ...added, transitions: [] })).toEqual([1, 2, 3, 4]);
    expect(statusesWantingFreeMove({ ...free, transitions: [] }, added)).toEqual([4]);
    const reachedOnlyOne = { ...added, transitions: [free.transitions[0] as never] };
    expect(statusesWantingFreeMove({ ...free, transitions: [] }, reachedOnlyOne)).toEqual([
      2, 3, 4,
    ]);
  });

  it('[WF-008] none where someone drew the steps, kept a status out on purpose or added a rule', () => {
    expect(statusesWantingFreeMove(free, free)).toEqual([]);
    const without = { ...free, transitions: free.transitions.filter((t) => t.id !== 2) };
    expect(statusesWantingFreeMove(free, without)).toEqual([]);
    const drawn = {
      ...added,
      transitions: [...free.transitions, { id: 4, name: 'In', from: [1], to: 4 }],
    };
    expect(statusesWantingFreeMove(free, drawn)).toEqual([]);
    const ruledDraft = {
      ...added,
      transitions: free.transitions.map((t) => (t.id === 1 ? { ...t, layout: ['assignee'] } : t)),
    };
    expect(statusesWantingFreeMove(free, ruledDraft)).toEqual([]);
    const ruledBase: WorkflowDefinition = {
      ...free,
      transitions: [{ id: 1, name: 'New', from: 'any', to: 1, guards: { type: 'only-assignee' } }],
    };
    expect(statusesWantingFreeMove(ruledBase, added)).toEqual([]);
  });
});
