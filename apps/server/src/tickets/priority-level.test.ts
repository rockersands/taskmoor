import { describe, expect, it } from 'vitest';
import { priorityLevel } from './priority-level';

const levels = (total: number) =>
  Array.from({ length: total }, (_, i) => priorityLevel(i + 1, total));

describe('a priority’s icon from its place in the order', () => {
  it('[CORE-014] stretches a list of any length over the six levels', () => {
    expect(levels(1)).toEqual([4]);
    expect(levels(2)).toEqual([1, 6]);
    expect(levels(4)).toEqual([1, 3, 4, 6]);
    expect(levels(5)).toEqual([1, 2, 4, 5, 6]);
    expect(levels(6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(levels(11)).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  });

  it('[CORE-014] stays within the six levels whatever it is given', () => {
    expect(priorityLevel(0, 5)).toBe(1);
    expect(priorityLevel(9, 5)).toBe(6);
  });
});
