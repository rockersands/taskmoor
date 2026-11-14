import { describe, expect, it } from 'vitest';
import { freeMoveEffects, freeTransition, freeTransitions } from './free-moving';

/** The free move into a status (the user's decision of 2026-11-04; WF-008; ADR-116). */
const CLEAR = [{ type: 'clear-field', field: 'close-reason' }];
const SETS = (id: number) => [
  { type: 'update-system-field', field: 'close-reason', value: String(id) },
];
const STATUSES = [
  { id: 1, name: 'New', stage: 'new' },
  { id: 2, name: 'Active', stage: 'active' },
  { id: 3, name: 'Closed', stage: 'closed' },
] as const;

describe('the free move into a status (WF-008)', () => {
  it('[WF-008] a closing status sets the reason free moves close with, and any other clears it', () => {
    expect(freeTransitions(STATUSES, 9)).toEqual([
      { id: 1, name: 'New', from: 'any', to: 1, effects: CLEAR },
      { id: 2, name: 'Active', from: 'any', to: 2, effects: CLEAR },
      { id: 3, name: 'Closed', from: 'any', to: 3, effects: SETS(9) },
    ]);
    // Numbered apart from its status when asked, as a column's path is.
    expect(freeTransition(3, 'Done', true, 9, 12)).toEqual({
      id: 12,
      name: 'Done',
      from: 'any',
      to: 3,
      effects: SETS(9),
    });
  });

  it('[WF-008] with no reason to close with, the others still clear it, and a closing status gets no free move rather than one that closes with none', () => {
    expect(freeTransitions(STATUSES, null)).toEqual([
      { id: 1, name: 'New', from: 'any', to: 1, effects: CLEAR },
      { id: 2, name: 'Active', from: 'any', to: 2, effects: CLEAR },
    ]);
    expect(freeTransition(2, 'Active', false, null)).toEqual({
      id: 2,
      name: 'Active',
      from: 'any',
      to: 2,
      effects: CLEAR,
    });
  });

  it('[WF-008] a free move that closes is never made without the reason it closes with, by its types (T-249)', () => {
    // A closing move with no reason would clear the reason as it closes: neither call compiles.
    // @ts-expect-error a closing free move needs its reason
    const closesWithNone = () => freeMoveEffects(true, null);
    // @ts-expect-error a closing free move needs its reason
    const intoClosedWithNone = () => freeTransition(3, 'Closed', true, null);
    expect([typeof closesWithNone, typeof intoClosedWithNone]).toEqual(['function', 'function']);
    expect(freeMoveEffects(true, 9)).toEqual(SETS(9));
    expect(freeMoveEffects(false, 9)).toEqual(CLEAR);
    expect(freeMoveEffects(false)).toEqual(CLEAR);
  });
});
