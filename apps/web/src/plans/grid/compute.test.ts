import { dayOfIso } from '@taskmoor/formula';
import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  applyEdit,
  applyEdits,
  columnProblems,
  computeGrid,
  editOfTicket,
  formulaCell,
  type GridCompute,
  moveRow,
  type RowEdit,
  totalCell,
} from './compute';
import { bigSkeleton, type FixtureRow, skeletonOf } from './fixtures';
import { TREE_FIELDS, treeRows } from './testTrees';
import { buildTree, moveSubtree, visibleRows } from './tree';
import type { StructureColumn } from './types';

const SUM: StructureColumn = { kind: 'total', fn: 'sum', of: 'cf[1]' };
const COLUMNS: StructureColumn[] = [
  { kind: 'ticket', field: 'summary' },
  SUM,
  { kind: 'total', fn: 'min', of: 'due' },
  { kind: 'total', fn: 'max', of: 'originalEstimate' },
  { kind: 'total', fn: 'count' },
  { kind: 'total', fn: 'progress' },
  { kind: 'total', fn: 'sum', of: 'originalEstimate' },
];

/** A row's own value of a ref, as a number (dates as day numbers), or null. */
function own(rows: readonly FixtureRow[], i: number, ref: string): number | null {
  const v = rows[i]?.values?.[ref] ?? null;
  return typeof v === 'string' ? dayOfIso(v) : v;
}

/** The rows below `r` at any depth (`r` = rows.length: every row). */
function below(rows: readonly FixtureRow[], r: number): number[] {
  const out: number[] = [];
  rows.forEach((_, i) => {
    for (let at = rows[i]?.parent as number; ; at = rows[at]?.parent as number) {
      if (at === -1) {
        if (r === rows.length) out.push(i);
        break;
      }
      if (at === r) {
        out.push(i);
        break;
      }
    }
  });
  return out;
}

const childrenOf = (rows: readonly FixtureRow[], r: number) =>
  rows.flatMap((x, i) => ((r === rows.length ? x.parent === -1 : x.parent === r) ? [i] : []));

/** The totals of every row and the last row, comparable with `toEqual`. */
function snapshot(grid: GridCompute) {
  const out: unknown[] = [];
  for (let r = 0; r <= grid.tree.n; r++) {
    out.push([grid.columns.map((_, c) => totalCell(grid, c, r)), grid.hiddenBelow[r]]);
  }
  return out;
}

describe('totals of the Grid (ADR-122 stage 10, "Totals and formulas")', () => {
  it('[PLN-010] (3) on every row with rows below, a sum total equals the sum of its child rows’ values, a leaf’s being its own', () => {
    fc.assert(
      fc.property(treeRows(), (rows) => {
        const grid = computeGrid(skeletonOf(rows, TREE_FIELDS), COLUMNS);
        const n = rows.length;
        for (let r = 0; r <= n; r++) {
          const kids = childrenOf(rows, r);
          if (kids.length === 0) continue;
          const childValues = kids
            .map((c) =>
              childrenOf(rows, c).length > 0
                ? (totalCell(grid, 1, c) as { value: number | null }).value
                : rows[c]?.ticket
                  ? own(rows, c, 'cf[1]')
                  : null,
            )
            .filter((v): v is number => v !== null);
          const cell = totalCell(grid, 1, r);
          expect(cell).toMatchObject({
            kind: 'value',
            value: childValues.length === 0 ? null : childValues.reduce((a, b) => a + b, 0),
          });
        }
      }),
    );
  });

  it('[PLN-010] adds, takes the least and the most of the leaf rows below, never the row’s own value', () => {
    fc.assert(
      fc.property(treeRows(), (rows) => {
        const grid = computeGrid(skeletonOf(rows, TREE_FIELDS), COLUMNS);
        for (let r = 0; r <= rows.length; r++) {
          const leafRow = r < rows.length && childrenOf(rows, r).length === 0;
          const leaves = leafRow
            ? rows[r]?.ticket
              ? [r]
              : []
            : below(rows, r).filter((i) => rows[i]?.ticket && childrenOf(rows, i).length === 0);
          const of = (ref: string) =>
            leaves.map((i) => own(rows, i, ref)).filter((v): v is number => v !== null);
          const numbers = of('cf[1]');
          const days = of('due');
          const seconds = of('originalEstimate');
          expect(totalCell(grid, 1, r)).toEqual({
            kind: 'value',
            type: 'number',
            value: numbers.length ? numbers.reduce((a, b) => a + b, 0) : null,
            valued: numbers.length,
            of: leaves.length,
            leaf: leafRow,
          });
          expect(totalCell(grid, 2, r)).toMatchObject({
            type: 'date',
            value: days.length ? Math.min(...days) : null,
          });
          expect(totalCell(grid, 3, r)).toMatchObject({
            type: 'duration',
            value: seconds.length ? Math.max(...seconds) : null,
          });
        }
      }),
    );
  });

  it('[PLN-010] counts every ticket row below at any depth, and how many are closed', () => {
    fc.assert(
      fc.property(treeRows(), (rows) => {
        const grid = computeGrid(skeletonOf(rows, TREE_FIELDS), COLUMNS);
        for (let r = 0; r <= rows.length; r++) {
          const tickets = below(rows, r).filter((i) => (rows[i]?.ticket ?? 0) > 0);
          expect(totalCell(grid, 4, r)).toEqual({ kind: 'count', count: tickets.length });
          expect(totalCell(grid, 5, r)).toEqual({
            kind: 'progress',
            closed: tickets.filter((i) => rows[i]?.closed).length,
            of: tickets.length,
          });
        }
      }),
    );
  });

  it('[PLN-010] (4) counts hidden tickets beside a total, never in it, and collapsing hides nothing from a total', () => {
    const rows: FixtureRow[] = [
      { ticket: 1, parent: -1, notShown: 4, values: { 'cf[1]': 1 } },
      { ticket: 2, parent: 0, notShown: 1, values: { 'cf[1]': 2 } },
      { ticket: 3, parent: 0, values: { 'cf[1]': null } },
      { ticket: 4, parent: -1, values: { 'cf[1]': 10 } },
    ];
    const s = skeletonOf(rows, TREE_FIELDS);
    const grid = computeGrid(s, COLUMNS);
    expect(totalCell(grid, 1, 0)).toEqual({
      kind: 'value',
      type: 'number',
      value: 2,
      valued: 1,
      of: 2,
      leaf: false,
    });
    expect(grid.hiddenBelow[0]).toBe(5);
    expect(grid.hiddenBelow[4]).toBe(5);
    expect(totalCell(grid, 1, 4)).toMatchObject({ value: 12, valued: 2, of: 3 });
    expect(totalCell(grid, 4, 0)).toEqual({ kind: 'count', count: 2 });
    // Collapsing the top row on the page draws fewer rows; the totals are the same.
    expect([...visibleRows(grid.tree, new Set([0]))]).toEqual([0, 3]);
    expect(snapshot(computeGrid(s, COLUMNS))).toEqual(snapshot(grid));
  });

  it('[PLN-010] totals the rows of a group row, and the last row totals the top rows', () => {
    const rows: FixtureRow[] = [
      { ticket: 0, parent: -1, label: 'Open' },
      { ticket: 1, parent: 0, values: { 'cf[1]': 3 } },
      { ticket: 2, parent: 0, closed: true, values: { 'cf[1]': 4 } },
      { ticket: 0, parent: -1, label: 'No value' },
      { ticket: 3, parent: 3, values: { 'cf[1]': 5 } },
      { ticket: 0, parent: -1, label: 'Empty' },
    ];
    const grid = computeGrid(skeletonOf(rows, TREE_FIELDS), COLUMNS);
    expect(totalCell(grid, 1, 0)).toMatchObject({ value: 7, valued: 2, of: 2 });
    expect(totalCell(grid, 5, 0)).toEqual({ kind: 'progress', closed: 1, of: 2 });
    expect(totalCell(grid, 1, 5)).toMatchObject({ value: null, valued: 0, of: 0, leaf: true });
    expect(totalCell(grid, 1, 6)).toMatchObject({ value: 12, valued: 3, of: 3, leaf: false });
    expect(totalCell(grid, 4, 6)).toEqual({ kind: 'count', count: 3 });
    expect(totalCell(grid, 0, 1)).toBeNull();
  });

  it('[PLN-010] recomputes only the rows above an edit, to the totals of a full computation', () => {
    const edits = fc.array(
      fc.record({
        pick: fc.nat(),
        number: fc.option(fc.integer({ min: -1_000, max: 1_000 })),
        closed: fc.option(fc.boolean()),
      }),
      { minLength: 1, maxLength: 4 },
    );
    fc.assert(
      fc.property(treeRows(), edits, (rows, picks) => {
        const tickets = rows.flatMap((r, i) => (r.ticket > 0 ? [i] : []));
        fc.pre(tickets.length > 0);
        const grid = computeGrid(skeletonOf(rows, TREE_FIELDS), COLUMNS);
        const after = rows.map((r) => ({ ...r, values: { ...r.values } }));
        const list: RowEdit[] = picks.map((p) => {
          const row = tickets[p.pick % tickets.length] as number;
          const target = after[row] as FixtureRow;
          (target.values as Record<string, number | null>)['cf[1]'] = p.number;
          const edit: RowEdit = { row, values: { 'cf[1]': p.number } };
          if (p.closed !== null) {
            target.closed = p.closed;
            edit.closed = p.closed;
          }
          return edit;
        });
        const touched = applyEdits(grid, list);
        expect(snapshot(grid)).toEqual(
          snapshot(computeGrid(skeletonOf(after, TREE_FIELDS), COLUMNS)),
        );
        // The chains above the edited rows, and nothing else.
        const chains = new Set<number>([rows.length]);
        for (const e of list) {
          for (let at = e.row; at !== -1; at = rows[at]?.parent as number) chains.add(at);
        }
        expect(new Set(touched)).toEqual(chains);
        expect(touched.at(-1)).toBe(rows.length);
      }),
    );
  });

  it('[PLN-010] carries the totals through a move and recomputes the rows above both places', () => {
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
          fc.pre(rows.length > 0 && (rows[row]?.ticket ?? 0) > 0);
          const s = skeletonOf(rows, TREE_FIELDS);
          const tree = buildTree(s);
          fc.pre(target === -1 || target < row || target >= (tree.end[row] as number));
          const formula: StructureColumn = {
            kind: 'formula',
            name: 'Children',
            expression: 'count(children)',
            output: 'number',
            decimals: 0,
          };
          const grid = computeGrid(s, [...COLUMNS, formula], tree);
          for (let r = 0; r < rows.length; r++) formulaCell(grid, COLUMNS.length, r);
          const moved = moveRow(grid, row, target);
          const fresh = computeGrid(moveSubtree(s, tree, row, target).skeleton, [
            ...COLUMNS,
            formula,
          ]);
          expect(snapshot(moved)).toEqual(snapshot(fresh));
          for (let r = 0; r < rows.length; r++) {
            expect(formulaCell(moved, COLUMNS.length, r)).toBe(
              formulaCell(fresh, COLUMNS.length, r),
            );
          }
        },
      ),
    );
  });

  it('[PLN-010] skips empty values and says how many of the rows below have one', () => {
    const rows: FixtureRow[] = [
      { ticket: 1, parent: -1, values: { originalEstimate: 7200 } },
      ...[2, 3, 4, 5, 6, 7, 8, 9].map((t, i) => ({
        ticket: t,
        parent: 0,
        values: { originalEstimate: i < 5 ? 3600 : null },
      })),
    ];
    const grid = computeGrid(skeletonOf(rows, TREE_FIELDS), COLUMNS);
    expect(totalCell(grid, 6, 0)).toEqual({
      kind: 'value',
      type: 'duration',
      value: 5 * 3600,
      valued: 5,
      of: 8,
      leaf: false,
    });
  });

  it('[PLN-010] marks a total broken when its field is gone or of the wrong type, and the rest still works', () => {
    const grid = computeGrid(skeletonOf([{ ticket: 1, parent: -1 }], TREE_FIELDS), [
      { kind: 'total', fn: 'sum', of: 'cf[99]' },
      { kind: 'total', fn: 'sum', of: 'due' },
      { kind: 'total', fn: 'min' },
      { kind: 'total', fn: 'count' },
    ]);
    const problems = columnProblems(grid);
    expect(problems.get(0)?.code).toBe('missing_field');
    expect(problems.get(1)?.code).toBe('wrong_type');
    expect(problems.get(2)?.code).toBe('needs_field');
    expect(problems.has(3)).toBe(false);
    expect(totalCell(grid, 0, 0)).toBeNull();
    expect(totalCell(grid, 3, 1)).toEqual({ kind: 'count', count: 1 });
  });

  it('[PLN-010] computes 100,000 rows and recomputes after one edit', () => {
    const s = bigSkeleton(100_000);
    const grid = computeGrid(s, [
      { kind: 'total', fn: 'sum', of: 'originalEstimate' },
      { kind: 'total', fn: 'count' },
      { kind: 'total', fn: 'progress' },
    ]);
    const estimates = s.values.originalEstimate as (number | null)[];
    const all = estimates.reduce<number>((a, b) => a + (b ?? 0), 0);
    expect(totalCell(grid, 0, 100_000)).toMatchObject({ value: all });
    expect(totalCell(grid, 1, 100_000)).toEqual({ kind: 'count', count: 100_000 });
    const last = 99_999;
    const touched = applyEdit(grid, { row: last, values: { originalEstimate: 0 } });
    expect(totalCell(grid, 0, 100_000)).toMatchObject({ value: all - (estimates[last] ?? 0) });
    expect(touched.length).toBeLessThanOrEqual(4);
  });
});

describe('formula columns of the Grid', () => {
  const formula = (expression: string, output: 'number' | 'text' | 'date' = 'number') =>
    ({ kind: 'formula', name: 'F', expression, output, decimals: 0 }) satisfies StructureColumn;

  it('[PLN-010] sum(children.{X}) equals the sum total on trees of depth 1', () => {
    fc.assert(
      fc.property(treeRows(), (all) => {
        // Depth 1: top rows and their leaf child rows only.
        const rows = all.filter((r) => r.parent === -1 || all[r.parent]?.parent === -1);
        const index = new Map(all.map((r, i) => [r, i]));
        const kept = new Map(rows.map((r, i) => [index.get(r) as number, i]));
        const flat = rows.map((r) => ({
          ...r,
          parent: r.parent === -1 ? -1 : (kept.get(r.parent) as number),
        }));
        const grid = computeGrid(skeletonOf(flat, TREE_FIELDS), [
          SUM,
          formula('sum(children.{cf[1]})'),
        ]);
        flat.forEach((r, i) => {
          if (r.ticket === 0 || childrenOf(flat, i).length === 0) return;
          const total = (totalCell(grid, 0, i) as { value: number | null }).value;
          expect(formulaCell(grid, 1, i)).toBe(total ?? 0);
        });
      }),
    );
  });

  it('[PLN-010] reads the row’s values, its child rows in the grid, today and the working week', () => {
    const rows: FixtureRow[] = [
      { ticket: 0, parent: -1, label: 'Open' },
      { ticket: 1, parent: 0, values: { 'cf[1]': 2, due: '2026-11-20', summary: 'Ship it' } },
      { ticket: 2, parent: 1, via: 2, values: { 'cf[1]': 5 } },
      { ticket: 3, parent: 1, values: { 'cf[1]': null } },
    ];
    const fields = [...TREE_FIELDS, { ref: 'summary', type: 'text' as const }];
    const today = dayOfIso('2026-11-14') as number;
    const grid = computeGrid(skeletonOf(rows, fields, { today }), [
      formula('{cf[1]} * 10 + count(children)'),
      formula('daysBetween(today(), {Due})'),
      formula('upper({summary})', 'text'),
      formula('workingDaysUntil({due})'),
      formula('count(children.{cf[1]})'),
    ]);
    expect(formulaCell(grid, 0, 1)).toBe(22);
    expect(formulaCell(grid, 1, 1)).toBe(6);
    expect(formulaCell(grid, 2, 1)).toBe('SHIP IT');
    expect(formulaCell(grid, 3, 1)).toBe(5);
    // A linked row below counts as a child row; an empty value does not count.
    expect(formulaCell(grid, 4, 1)).toBe(1);
    expect(formulaCell(grid, 0, 2)).toBe(50);
    // Group rows and the last row show nothing.
    expect(formulaCell(grid, 0, 0)).toBeNull();
    expect(formulaCell(grid, 0, 4)).toBeNull();
  });

  it('[PLN-010] recomputes a formula of an edited row and of its parent', () => {
    const rows: FixtureRow[] = [
      { ticket: 1, parent: -1, values: { 'cf[1]': 1 } },
      { ticket: 2, parent: 0, values: { 'cf[1]': 2 } },
    ];
    const grid = computeGrid(skeletonOf(rows, TREE_FIELDS), [
      formula('{cf[1]} + sum(children.{cf[1]})'),
    ]);
    expect(formulaCell(grid, 0, 0)).toBe(3);
    expect(formulaCell(grid, 0, 1)).toBe(2);
    applyEdit(grid, { row: 1, values: { 'cf[1]': 40 } });
    expect(formulaCell(grid, 0, 0)).toBe(41);
    expect(formulaCell(grid, 0, 1)).toBe(40);
  });

  it('[PLN-010] shows a broken formula column’s error while the rest of the structure works', () => {
    const grid = computeGrid(skeletonOf([{ ticket: 1, parent: -1 }], TREE_FIELDS), [
      formula('{cf[42]} + 1'),
      formula('{summary} + 1'),
      formula('{cf[1]} +'),
      formula('{cf[1]}', 'date'),
      formula('{cf[1]} + 1'),
      { kind: 'total', fn: 'count' },
    ]);
    const problems = columnProblems(grid);
    expect(problems.get(0)).toMatchObject({ code: 'unknown_field', start: 0 });
    expect(problems.get(1)?.code).toBe('unknown_field');
    expect(problems.get(2)?.code).toBe('unexpected_end');
    expect(problems.get(3)?.code).toBeDefined();
    expect(problems.has(4)).toBe(false);
    expect(formulaCell(grid, 0, 0)).toBeNull();
    expect(formulaCell(grid, 4, 0)).toBeNull();
    expect(totalCell(grid, 5, 1)).toEqual({ kind: 'count', count: 1 });
  });

  it('[PLN-010] gives values as a formula field stores them', () => {
    const rows: FixtureRow[] = [{ ticket: 1, parent: -1, values: { 'cf[1]': 1, due: 20_400 } }];
    const grid = computeGrid(skeletonOf(rows, TREE_FIELDS), [
      formula('{cf[1]} / 3'),
      formula('addDays({due}, 1)', 'date'),
      formula('{cf[1]} / 0'),
    ]);
    expect(formulaCell(grid, 0, 0)).toBe(0.333);
    expect(formulaCell(grid, 1, 0)).toBe('2025-11-09');
    expect(formulaCell(grid, 2, 0)).toBeNull();
  });
});

describe('a saved ticket as a row edit', () => {
  it('[PLN-010] reads the refs the skeleton carries and the closed stage', () => {
    const rows: FixtureRow[] = [{ ticket: 1, parent: -1 }];
    const grid = computeGrid(
      skeletonOf(rows, [...TREE_FIELDS, { ref: 'summary', type: 'text' }]),
      [],
    );
    expect(
      editOfTicket(grid, 0, {
        summary: 'New',
        dueDate: '2026-12-01',
        status: { stage: 'closed' },
        fields: { '1': 8 },
      }),
    ).toEqual({
      row: 0,
      values: { 'cf[1]': 8, due: '2026-12-01', summary: 'New' },
      closed: true,
    });
  });
});
