import { describe, expect, it } from 'vitest';
import { ticketsOf } from './TypeSetForm';

describe('the tickets the dropped types of a type set hold (CORE-005 (2), T-320)', () => {
  it('[CORE-005] (2) counts the types of one refusal', () => {
    expect(ticketsOf([{ typeIds: [5, 6], tickets: 9 }], [5, 6])).toBe(9);
  });

  it('[CORE-005] (2) counts every type refused so far, once the counts tell each part', () => {
    // Bug and Task refused together; then Task alone, once Bug had a target.
    const refusals = [
      { typeIds: [5, 6], tickets: 9 },
      { typeIds: [6], tickets: 2 },
    ];
    expect(ticketsOf(refusals, [5, 6])).toBe(9);
    expect(ticketsOf(refusals, [5])).toBe(7);
    expect(ticketsOf(refusals, [6])).toBe(2);
  });

  it('[CORE-005] (2) adds a type refused later to those refused before', () => {
    const refusals = [
      { typeIds: [5], tickets: 7 },
      { typeIds: [6], tickets: 2 },
    ];
    expect(ticketsOf(refusals, [5, 6])).toBe(9);
  });

  it('[CORE-005] (2) the newest refusal naming every type not known counts them', () => {
    const refusals = [
      { typeIds: [5, 6], tickets: 9 },
      { typeIds: [5, 6, 7], tickets: 12 },
    ];
    expect(ticketsOf(refusals, [5, 6, 7])).toBe(12);
    expect(ticketsOf(refusals, [5, 6])).toBe(9);
  });

  it('[CORE-005] (2) says nothing when the counts do not tell', () => {
    // Task was ticked again: how many of the 9 are Bug's is not known.
    expect(ticketsOf([{ typeIds: [5, 6], tickets: 9 }], [5])).toBeNull();
  });

  it('[CORE-005] (2) counts nothing for no types', () => {
    expect(ticketsOf([], [])).toBe(0);
  });
});
