import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  cardRulesInput,
  columnInput,
  enteredColumn,
  sharedStatus,
  wipState,
  withIds,
} from './model';

describe('board configuration (M1-043)', () => {
  it('[AGL-003] is over above the maximum and under below the minimum', () => {
    expect(wipState({ min: null, max: 3 }, 4)).toBe('over');
    expect(wipState({ min: null, max: 3 }, 3)).toBeNull();
    expect(wipState({ min: 2, max: null }, 1)).toBe('under');
    expect(wipState({ min: 2, max: 5 }, 2)).toBeNull();
    expect(wipState({ min: null, max: null }, 1000)).toBeNull();
    expect(columnInput.safeParse({ name: 'Doing', min: 4, max: 3 }).success).toBe(false);
  });

  it('[AGL-002] finds a status mapped to two columns', () => {
    expect(sharedStatus([{ statusIds: [1, 2] }, { statusIds: [3] }])).toBeNull();
    expect(sharedStatus([{ statusIds: [1, 2] }, { statusIds: [3, 2] }])).toBe(2);
  });

  it('[AGL-004] gives items without an id the first free one, and refuses duplicates', () => {
    expect(withIds([{ id: 'c2' }, {}, {}], 'c')?.map((c) => c.id)).toEqual(['c2', 'c1', 'c3']);
    expect(withIds([{ id: 'x' }, { id: 'x' }], 'c')).toBeNull();
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.constantFrom('c1', 'c2', 'c5', 'k'), { nil: undefined })),
        (ids) => {
          const given = ids.filter((i) => i !== undefined);
          const result = withIds(
            ids.map((id) => (id === undefined ? {} : { id })),
            'c',
          );
          if (new Set(given).size !== given.length) return result === null;
          const out = (result ?? []).map((r) => r.id);
          return new Set(out).size === out.length && out.length === ids.length;
        },
      ),
    );
  });

  it('[AGL-006] allows up to 10 extra card fields', () => {
    const fields = (n: number) => Array.from({ length: n }, (_, i) => `cf[${i + 1}]`);
    expect(cardRulesInput.safeParse({ colourBy: 'none', fields: fields(10) }).success).toBe(true);
    expect(cardRulesInput.safeParse({ colourBy: 'none', fields: fields(11) }).success).toBe(false);
    expect(cardRulesInput.safeParse({ colourBy: 'none', fields: ['summary'] }).success).toBe(false);
  });

  it('[AGL-006] counts days in column from the last change that came from another column', () => {
    const columnOf = (s: number) => ({ 1: 'todo', 2: 'doing', 3: 'doing', 4: 'done' })[s] ?? null;
    const created = new Date('2026-10-01T00:00:00Z');
    const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, '0')}T00:00:00Z`);
    expect(enteredColumn(columnOf, 1, created, [])).toEqual(created);
    expect(
      enteredColumn(columnOf, 3, created, [
        { from: 1, to: 2, at: at(5) },
        { from: 2, to: 3, at: at(9) },
      ]),
    ).toEqual(at(5));
    // Back and forth: the latest entry counts.
    expect(
      enteredColumn(columnOf, 2, created, [
        { from: 1, to: 2, at: at(3) },
        { from: 2, to: 4, at: at(4) },
        { from: 4, to: 2, at: at(8) },
      ]),
    ).toEqual(at(8));
  });
});
