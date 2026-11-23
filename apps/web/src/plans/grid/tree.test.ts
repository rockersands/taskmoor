import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { treeRows } from '../../test/gridTrees';
import { bigSkeleton, type FixtureRow, skeletonOf } from './fixtures';
import {
  allCollapsible,
  ancestors,
  buildTree,
  childCount,
  collapsedFromKeys,
  moveProblem,
  moveSubtree,
  rowKeys,
  SkeletonError,
  setSize,
  visibleRows,
} from './tree';

/** Whether row `a` is above row `b` (strictly), by the parents. */
function above(parent: readonly number[], a: number, b: number): boolean {
  for (let at = parent[b] as number; at !== -1; at = parent[at] as number)
    if (at === a) return true;
  return false;
}

describe('the Grid tree (ADR-122 stage 10)', () => {
  it('[PLN-010] reads rows in preorder: children, sizes and places among siblings', () => {
    const s = skeletonOf([
      { ticket: 1, parent: -1 },
      { ticket: 2, parent: 0 },
      { ticket: 3, parent: 1 },
      { ticket: 4, parent: 0 },
      { ticket: 5, parent: -1 },
    ]);
    const t = buildTree(s);
    expect(t.n).toBe(5);
    expect([...t.end]).toEqual([4, 3, 3, 4, 5]);
    expect([...t.depth]).toEqual([0, 1, 2, 1, 0]);
    expect(childCount(t, 0)).toBe(2);
    expect(childCount(t, t.n)).toBe(2);
    expect([...t.posInSet]).toEqual([1, 1, 1, 2, 2]);
    expect(setSize(t, 3)).toBe(2);
    expect(ancestors(t, 2)).toEqual([1, 0]);
    expect(t.parent[0]).toBe(t.n);
  });

  it('[PLN-010] refuses rows that are not a tree in preorder', () => {
    const bad = skeletonOf([
      { ticket: 1, parent: -1 },
      { ticket: 2, parent: -1 },
      { ticket: 3, parent: 0 },
    ]);
    expect(() => buildTree(bad)).toThrow(SkeletonError);
    const later = skeletonOf([{ ticket: 1, parent: -1 }]);
    later.rows.parent[0] = 0;
    expect(() => buildTree(later)).toThrow(SkeletonError);
    const short = skeletonOf([{ ticket: 1, parent: -1 }]);
    short.rows.key = [];
    expect(() => buildTree(short)).toThrow(/rows.key/);
  });

  it('[PLN-010] shows a row exactly when no row above it is collapsed, in order', () => {
    fc.assert(
      fc.property(
        treeRows().chain((rows) => fc.tuple(fc.constant(rows), fc.subarray(rows.map((_, i) => i)))),
        ([rows, picked]) => {
          const s = skeletonOf(rows);
          const t = buildTree(s);
          const collapsed = new Set(picked);
          const expected = rows
            .map((_, i) => i)
            .filter((i) => ![...collapsed].some((c) => above(s.rows.parent, c, i)));
          expect([...visibleRows(t, collapsed)]).toEqual(expected);
        },
      ),
    );
  });

  it('[PLN-010] opens with every row expanded and collapses all to the top rows', () => {
    const s = skeletonOf([
      { ticket: 0, parent: -1, label: 'Open' },
      { ticket: 1, parent: 0 },
      { ticket: 2, parent: 1 },
      { ticket: 3, parent: -1 },
    ]);
    const t = buildTree(s);
    expect([...visibleRows(t, new Set())]).toEqual([0, 1, 2, 3]);
    expect([...allCollapsible(t)]).toEqual([0, 1]);
    expect([...visibleRows(t, allCollapsible(t))]).toEqual([0, 3]);
  });

  it('[PLN-010] keeps collapsed rows by keys that survive a new read', () => {
    const rows: FixtureRow[] = [
      { ticket: 0, parent: -1, label: 'In progress' },
      { ticket: 7, parent: 0 },
      { ticket: 8, parent: 1 },
      { ticket: 0, parent: -1, label: 'Done / later' },
      { ticket: 9, parent: 3 },
    ];
    const first = skeletonOf(rows);
    const keys = rowKeys(first, buildTree(first));
    expect(keys[1]).toBe('t7');
    expect(keys[3]).toBe('gstatus=Done%20%2F%20later');
    // Read again with a row added at the front: the same rows stay collapsed.
    const again = skeletonOf([
      { ticket: 0, parent: -1, label: 'Blocked' },
      { ticket: 5, parent: 0 },
      ...rows.map((r) => ({ ...r, parent: r.parent === -1 ? -1 : r.parent + 2 })),
    ]);
    const kept = collapsedFromKeys(again, buildTree(again), [
      keys[1] as string,
      keys[3] as string,
      't99',
    ]);
    expect([...kept].sort()).toEqual([3, 5]);
  });

  it('[PLN-010] offers a move only under a ticket row one level up, in the track for a subticket', () => {
    const s = skeletonOf([
      { ticket: 0, parent: -1 },
      { ticket: 1, parent: 0, level: 1, track: 1 },
      { ticket: 2, parent: 1, level: 0, track: 1 },
      { ticket: 3, parent: 2, level: -1, track: 1 },
      { ticket: 4, parent: 1, level: 0, track: 2 },
      { ticket: 5, parent: 1, level: 0, track: 1, via: 2 },
      { ticket: 6, parent: -1, level: 1, track: 2 },
    ]);
    const t = buildTree(s);
    expect(moveProblem(s, t, 0, 6)).toBe('group_row');
    expect(moveProblem(s, t, 2, 0)).toBe('group_target');
    expect(moveProblem(s, t, 5, 6)).toBe('placed_by_link');
    expect(moveProblem(s, t, 1, 3)).toBe('own_rows');
    expect(moveProblem(s, t, 2, 1)).toBe('same_parent');
    expect(moveProblem(s, t, 2, 4)).toBe('wrong_level');
    expect(moveProblem(s, t, 3, 4)).toBe('other_track');
    expect(moveProblem(s, t, 3, -1)).toBe('required');
    expect(moveProblem(s, t, 6, -1)).toBe('same_parent');
    expect(moveProblem(s, t, 2, 6)).toBeNull();
    expect(moveProblem(s, t, 2, -1)).toBeNull();
    expect(moveProblem(s, t, 4, 6)).toBeNull();
  });

  it('[PLN-010] moves a row with everything below it and keeps preorder', () => {
    fc.assert(
      fc.property(
        treeRows(30).chain((rows) =>
          fc.tuple(
            fc.constant(rows),
            fc.nat({ max: Math.max(0, rows.length - 1) }),
            fc.integer({ min: -1, max: Math.max(0, rows.length - 1) }),
          ),
        ),
        ([rows, row, target]) => {
          fc.pre(rows.length > 0);
          const s = skeletonOf(rows, [{ ref: 'cf[1]', type: 'number' }]);
          const t = buildTree(s);
          fc.pre(target === -1 || target < row || target >= (t.end[row] as number));
          const { skeleton: moved, from } = moveSubtree(s, t, row, target);
          const m = buildTree(moved);
          const to = new Map([...from].map((o, j) => [o, j]));
          const at = to.get(row) as number;
          // The same rows, each once; the moved rows together, under the target.
          expect([...moved.rows.ticket].sort()).toEqual([...s.rows.ticket].sort());
          expect((m.end[at] as number) - at).toBe((t.end[row] as number) - row);
          expect(moved.rows.parent[at]).toBe(target === -1 ? -1 : to.get(target));
          expect(m.depth[at]).toBe(
            target === -1 ? 0 : (m.depth[to.get(target) as number] as number) + 1,
          );
          for (let o = 0; o < t.n; o++) {
            if (o === row) continue;
            const p = s.rows.parent[o] as number;
            expect(moved.rows.parent[to.get(o) as number]).toBe(p === -1 ? -1 : to.get(p));
            expect(moved.rows.depth[to.get(o) as number]).toBe(m.depth[to.get(o) as number]);
          }
          expect(s).toEqual(skeletonOf(rows, [{ ref: 'cf[1]', type: 'number' }]));
        },
      ),
    );
  });

  it('[PLN-010] draws a window of a 100,000-row structure from its tree in one pass', () => {
    const s = bigSkeleton(100_000);
    const t = buildTree(s);
    expect(t.n).toBe(100_000);
    const shown = visibleRows(t, allCollapsible(t));
    expect(shown.length).toBe(Math.ceil(100_000 / 21));
  });
});
