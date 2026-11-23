import {
  type Compiled,
  compileFormula,
  dayOfIso,
  type EvalInput,
  evaluate,
  type FieldValueType,
  type FormulaErrorCode,
  type OutputType,
  type Program,
  type Resolution,
  type Scalar,
  storedValue,
} from '@taskmoor/formula';
import { buildTree, type GridTree, moveSubtree } from './tree';
import type { GridField, GridSkeleton, StructureColumn } from './types';

/**
 * Totals and formula columns of a plan's Grid, computed in the browser (ADR-122 stage 10,
 * "Totals and formulas"; PLN-010 acceptance 3). One pure module over the skeleton:
 *
 * - A **total** at a row with rows below is computed from its **child rows**: `sum` adds their
 *   totals, `min` and `max` take theirs, and a leaf gives its own value. So at every row a sum
 *   total equals the sum of its child rows' values, by construction. The row's own value is not
 *   added (question 6): it stays in its ticket column.
 * - `count` is every ticket row below, at any depth; `progress` is how many of them are in a
 *   status of the closed stage, out of how many (never a percentage, decisions row 157).
 * - Empty values are skipped and counted: `valued` of `leaves` ("5 of 8 have a value").
 * - Only rows in the skeleton enter a total: hidden tickets are never rows; `hiddenBelow` counts
 *   them (`notShown` of the row and of its rows below) so a total can say "+4 not shown".
 *   Collapsing rows on the page hides nothing from a total.
 * - Group rows total their rows; index `tree.n`, the last row, totals the top rows.
 * - A **formula** column runs per ticket row, reading the row's values, its child rows in the
 *   grid, today and the working week from the skeleton; group rows show nothing. Formula values
 *   are computed when a cell asks and kept until an edit touches them.
 *
 * An edit or a move recomputes only the rows above the changed ones, each from its child rows.
 */

/** The values of one ref, one per row: numbers (NaN for empty) or text. */
type Column =
  | { type: Exclude<FieldValueType, 'text'>; num: Float64Array }
  | { type: 'text'; text: (string | null)[] };

/** Why a total or formula column does not work, while the rest of the structure does. */
export interface ColumnProblem {
  code: FormulaErrorCode | 'missing_field' | 'wrong_type' | 'needs_field';
  message: string;
  /** Where in the expression, for a formula. */
  start?: number;
  end?: number;
}

export type ValueFn = 'sum' | 'min' | 'max';

export type ColumnState =
  /** A ticket column: its cells come from the rows in view, nothing is computed. */
  | { kind: 'ticket'; field: string }
  | {
      kind: 'value';
      fn: ValueFn;
      ref: string;
      type: Exclude<FieldValueType, 'text'>;
      /** Per row and the last row (`n`): the total, NaN when no row below has a value. */
      value: Float64Array;
      /** Leaf rows below (the row itself at a leaf) with a value. */
      valued: Int32Array;
      /** Leaf ticket rows below (the row itself at a leaf). */
      leaves: Int32Array;
    }
  | { kind: 'count'; count: Int32Array }
  | { kind: 'progress'; closed: Int32Array; of: Int32Array }
  | {
      kind: 'formula';
      program: Program;
      output: OutputType;
      decimals: number;
      /** Computed values by row; undefined until a cell asks. */
      cache: (Scalar | undefined)[];
    }
  | { kind: 'broken'; problem: ColumnProblem };

export interface GridCompute {
  /** The skeleton as edited and moved here (its own copy of values and `closed`). */
  skeleton: GridSkeleton;
  tree: GridTree;
  specs: readonly StructureColumn[];
  /** One per column of the structure, in its order. */
  columns: ColumnState[];
  /** Per row and the last row: `notShown` of the row and every row below. */
  hiddenBelow: Int32Array;
  values: Map<string, Column>;
  closed: Uint8Array;
}

/** What a total cell shows. */
export type TotalCell =
  | {
      kind: 'value';
      type: Exclude<FieldValueType, 'text'>;
      value: number | null;
      valued: number;
      of: number;
      /** A leaf's total is its own value. */
      leaf: boolean;
    }
  | { kind: 'count'; count: number }
  | { kind: 'progress'; closed: number; of: number };

const SUM_TYPES: readonly FieldValueType[] = ['number', 'duration'];
const MIN_MAX_TYPES: readonly FieldValueType[] = ['number', 'duration', 'date'];
const VALUE_TYPES: readonly FieldValueType[] = ['number', 'text', 'date', 'duration'];

const CUSTOM_REF = /^cf\[\s*([1-9][0-9]{0,9})\s*\]$/i;

/** A ref as the skeleton writes it: `cf[12]`, or a system id in lower case for matching. */
function refKey(name: string): string {
  const m = CUSTOM_REF.exec(name.trim());
  return m ? `cf[${Number(m[1])}]` : name.trim().toLowerCase();
}

/**
 * Finds the fields a formula column names, among those the skeleton sends: a structure's formula
 * is stored by id (`{cf[12]}`, `{due}`), so a field deleted since is unknown and the column is
 * broken, showing its error while the rest of the structure works.
 */
export function gridResolver(fields: readonly GridField[]): (name: string) => Resolution {
  const byKey = new Map(fields.map((f) => [refKey(f.ref), f]));
  return (name) => {
    const f = byKey.get(refKey(name));
    if (!f) return { problem: 'unknown_field', message: `No field is called ${name}` };
    if (!VALUE_TYPES.includes(f.type)) {
      return { problem: 'unsupported_field', message: `Formulas cannot read ${name} yet` };
    }
    return { id: f.ref, type: f.type };
  };
}

/** Compiles a formula column against the skeleton's fields. */
export function compileColumn(
  fields: readonly GridField[],
  expression: string,
  output: OutputType,
): Compiled {
  return compileFormula(expression, { resolve: gridResolver(fields), output });
}

function readColumn(
  type: FieldValueType,
  raw: readonly (number | string | null)[],
  n: number,
): Column {
  if (type === 'text') {
    return {
      type,
      text: Array.from({ length: n }, (_, i) => {
        const v = raw[i];
        return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
      }),
    };
  }
  const num = new Float64Array(n).fill(Number.NaN);
  for (let i = 0; i < n; i++) num[i] = numberOf(type, raw[i] ?? null);
  return { type, num };
}

/** A value as a number of its type: a day number for a date, seconds for a duration; NaN if empty. */
function numberOf(type: FieldValueType, v: number | string | null): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === 'string' && type === 'date') return dayOfIso(v) ?? Number.NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const x = Number(v);
    return Number.isFinite(x) ? x : Number.NaN;
  }
  return Number.NaN;
}

function columnState(
  spec: StructureColumn,
  n: number,
  values: ReadonlyMap<string, Column>,
  fields: readonly GridField[],
): ColumnState {
  if (spec.kind === 'ticket') return { kind: 'ticket', field: spec.field };
  if (spec.kind === 'formula') {
    const compiled = compileColumn(fields, spec.expression, spec.output);
    if (!compiled.ok) {
      const e = compiled.error;
      return {
        kind: 'broken',
        problem: { code: e.code, message: e.message, start: e.start, end: e.end },
      };
    }
    return {
      kind: 'formula',
      program: compiled.program,
      output: spec.output,
      decimals: spec.decimals,
      cache: new Array(n),
    };
  }
  switch (spec.fn) {
    case 'count':
      return { kind: 'count', count: new Int32Array(n + 1) };
    case 'progress':
      return { kind: 'progress', closed: new Int32Array(n + 1), of: new Int32Array(n + 1) };
    default: {
      if (spec.of === undefined) {
        return {
          kind: 'broken',
          problem: { code: 'needs_field', message: `${spec.fn} needs a field` },
        };
      }
      const column = values.get(refKey(spec.of));
      if (!column) {
        return {
          kind: 'broken',
          problem: { code: 'missing_field', message: `No field is ${spec.of}` },
        };
      }
      const allowed = spec.fn === 'sum' ? SUM_TYPES : MIN_MAX_TYPES;
      if (column.type === 'text' || !allowed.includes(column.type)) {
        return {
          kind: 'broken',
          problem: { code: 'wrong_type', message: `${spec.fn} cannot take a ${column.type} field` },
        };
      }
      return {
        kind: 'value',
        fn: spec.fn,
        ref: spec.of,
        type: column.type,
        value: new Float64Array(n + 1).fill(Number.NaN),
        valued: new Int32Array(n + 1),
        leaves: new Int32Array(n + 1),
      };
    }
  }
}

/** Computes every total of a skeleton's rows, bottom up, in one pass per column. */
export function computeGrid(
  skeleton: GridSkeleton,
  specs: readonly StructureColumn[],
  tree: GridTree = buildTree(skeleton),
): GridCompute {
  const n = tree.n;
  const own: GridSkeleton = {
    ...skeleton,
    rows: { ...skeleton.rows, closed: [...skeleton.rows.closed] },
    values: Object.fromEntries(Object.entries(skeleton.values).map(([k, v]) => [k, [...v]])),
  };
  const values = new Map<string, Column>();
  for (const f of skeleton.fields) {
    if (!VALUE_TYPES.includes(f.type)) continue;
    values.set(refKey(f.ref), readColumn(f.type, own.values[f.ref] ?? [], n));
  }
  const closed = new Uint8Array(n);
  for (let i = 0; i < n; i++) closed[i] = own.rows.closed[i] ? 1 : 0;
  const grid: GridCompute = {
    skeleton: own,
    tree,
    specs,
    columns: specs.map((s) => columnState(s, n, values, skeleton.fields)),
    hiddenBelow: new Int32Array(n + 1),
    values,
    closed,
  };
  for (let i = n - 1; i >= 0; i--) computeAt(grid, i);
  computeAt(grid, n);
  return grid;
}

/** Recomputes one row (or the last row, `n`) from its child rows, which are already computed. */
function computeAt(grid: GridCompute, at: number): void {
  const { tree, closed } = grid;
  const n = tree.n;
  const first = tree.childStart[at] as number;
  const past = tree.childStart[at + 1] as number;
  const kids = tree.children;
  const ticket = tree.isTicket;
  let hidden = at < n ? (grid.skeleton.rows.notShown[at] ?? 0) : 0;
  for (let c = first; c < past; c++) hidden += grid.hiddenBelow[kids[c] as number] as number;
  grid.hiddenBelow[at] = hidden;
  for (const col of grid.columns) {
    switch (col.kind) {
      case 'value': {
        if (first === past) {
          // A leaf gives its own value; a group row with no rows has none.
          const isLeaf = at < n && ticket[at] === 1;
          const own = isLeaf ? ownNumber(grid, col.ref, at) : Number.NaN;
          col.value[at] = own;
          col.valued[at] = Number.isNaN(own) ? 0 : 1;
          col.leaves[at] = isLeaf ? 1 : 0;
          break;
        }
        let acc = Number.NaN;
        let valued = 0;
        let leaves = 0;
        for (let c = first; c < past; c++) {
          const k = kids[c] as number;
          leaves += col.leaves[k] as number;
          const v = col.value[k] as number;
          if (Number.isNaN(v)) continue;
          valued += col.valued[k] as number;
          if (Number.isNaN(acc)) acc = v;
          else if (col.fn === 'sum') acc += v;
          else if (col.fn === 'min' ? v < acc : v > acc) acc = v;
        }
        col.value[at] = acc;
        col.valued[at] = valued;
        col.leaves[at] = leaves;
        break;
      }
      case 'count': {
        let count = 0;
        for (let c = first; c < past; c++) {
          const k = kids[c] as number;
          count += (ticket[k] as number) + (col.count[k] as number);
        }
        col.count[at] = count;
        break;
      }
      case 'progress': {
        let done = 0;
        let of = 0;
        for (let c = first; c < past; c++) {
          const k = kids[c] as number;
          done += (ticket[k] as number) * (closed[k] as number) + (col.closed[k] as number);
          of += (ticket[k] as number) + (col.of[k] as number);
        }
        col.closed[at] = done;
        col.of[at] = of;
        break;
      }
      default:
        break;
    }
  }
}

function ownNumber(grid: GridCompute, ref: string, row: number): number {
  const column = grid.values.get(refKey(ref));
  return column && column.type !== 'text' ? (column.num[row] as number) : Number.NaN;
}

/** A row's own value of a ref, as a formula reads it. */
function scalarAt(grid: GridCompute, ref: string, row: number): Scalar {
  const column = grid.values.get(refKey(ref));
  if (!column) return null;
  if (column.type === 'text') return column.text[row] ?? null;
  const v = column.num[row] as number;
  return Number.isNaN(v) ? null : v;
}

/** A total cell of a row, or of the last row (`tree.n`); null for a column that is not a total. */
export function totalCell(grid: GridCompute, column: number, row: number): TotalCell | null {
  const col = grid.columns[column];
  switch (col?.kind) {
    case 'value': {
      const v = col.value[row] as number;
      return {
        kind: 'value',
        type: col.type,
        value: Number.isNaN(v) ? null : v,
        valued: col.valued[row] as number,
        of: col.leaves[row] as number,
        leaf: row < grid.tree.n && grid.tree.childStart[row] === grid.tree.childStart[row + 1],
      };
    }
    case 'count':
      return { kind: 'count', count: col.count[row] as number };
    case 'progress':
      return { kind: 'progress', closed: col.closed[row] as number, of: col.of[row] as number };
    default:
      return null;
  }
}

/**
 * A formula cell: the value as a formula field would store it (a number at 0.001, whole seconds,
 * `YYYY-MM-DD`, one line of text), or null when empty; group rows and the last row show nothing.
 */
export function formulaCell(
  grid: GridCompute,
  column: number,
  row: number,
): number | string | null {
  const col = grid.columns[column];
  if (col?.kind !== 'formula' || row >= grid.tree.n || grid.tree.isTicket[row] !== 1) return null;
  let value = col.cache[row];
  if (value === undefined) {
    const { tree } = grid;
    const first = tree.childStart[row] as number;
    const past = tree.childStart[row + 1] as number;
    const input: EvalInput = {
      field: (id) => scalarAt(grid, id, row),
      children: (id) => {
        const out: Scalar[] = [];
        for (let c = first; c < past; c++) out.push(scalarAt(grid, id, tree.children[c] as number));
        return out;
      },
      childCount: () => past - first,
      today: grid.skeleton.today,
      workingWeek: grid.skeleton.workingWeek,
    };
    const result = evaluate(col.program, input);
    value = result.ok ? (storedValue(col.output, result.value) ?? null) : null;
    col.cache[row] = value;
  }
  return value as number | string | null;
}

/** The broken total and formula columns, by column index. */
export function columnProblems(grid: GridCompute): Map<number, ColumnProblem> {
  const out = new Map<number, ColumnProblem>();
  grid.columns.forEach((c, i) => {
    if (c.kind === 'broken') out.set(i, c.problem);
  });
  return out;
}

/** A change to one row: new values by ref, and whether its status is now in the closed stage. */
export interface RowEdit {
  row: number;
  values?: Record<string, number | string | null>;
  closed?: boolean;
}

/**
 * Applies saved edits and recomputes only the rows above them, each from its child rows, child
 * rows before parents. Formula values of the edited rows and of their parents are recomputed when
 * next asked (a formula reads its own row and its child rows). Returns the rows whose totals were
 * recomputed, the edited ones first and the last row (`tree.n`) at the end: the page fetches the
 * cells in view among them again, since the server recomputed their stored formula fields.
 */
export function applyEdits(grid: GridCompute, edits: readonly RowEdit[]): number[] {
  const { tree } = grid;
  const n = tree.n;
  const chain = new Set<number>();
  for (const edit of edits) {
    const { row } = edit;
    if (!Number.isInteger(row) || row < 0 || row >= n) throw new RangeError(`No row ${row}`);
    for (const [ref, raw] of Object.entries(edit.values ?? {})) {
      const column = grid.values.get(refKey(ref));
      if (!column) continue;
      const list = grid.skeleton.values[ref];
      if (list) list[row] = raw;
      if (column.type === 'text') {
        column.text[row] = typeof raw === 'string' ? raw : raw === null ? null : String(raw);
      } else {
        column.num[row] = numberOf(column.type, raw);
      }
    }
    if (edit.closed !== undefined) {
      grid.closed[row] = edit.closed ? 1 : 0;
      grid.skeleton.rows.closed[row] = edit.closed;
    }
    forgetFormulas(grid, row);
    for (let at = row; at < n; at = tree.parent[at] as number) chain.add(at);
  }
  // Preorder puts every row after the rows above it: the highest index first is bottom up.
  const order = [...chain].sort((a, b) => b - a);
  for (const at of order) computeAt(grid, at);
  computeAt(grid, n);
  return [...edits.map((e) => e.row), ...order.filter((r) => !edits.some((e) => e.row === r)), n];
}

export const applyEdit = (grid: GridCompute, edit: RowEdit) => applyEdits(grid, [edit]);

/** Formula values that read a row: its own, and its parent's (through `children`). */
function forgetFormulas(grid: GridCompute, row: number) {
  const parent = grid.tree.parent[row] as number;
  for (const col of grid.columns) {
    if (col.kind !== 'formula') continue;
    col.cache[row] = undefined;
    if (parent < grid.tree.n) col.cache[parent] = undefined;
  }
}

/**
 * Moves a row with everything below it under `target` (-1: to the top rows) after the server
 * accepted the move, and recomputes only the rows above its old and its new place. The totals of
 * the rows that moved are unchanged and carried over.
 */
export function moveRow(grid: GridCompute, row: number, target: number): GridCompute {
  const { tree } = grid;
  const n = tree.n;
  const oldParent = tree.parent[row] as number;
  const moved = moveSubtree(grid.skeleton, tree, row, target);
  const from = moved.from;
  const to = new Int32Array(n);
  for (let j = 0; j < n; j++) to[from[j] as number] = j;
  const next = buildTree(moved.skeleton);
  const remapNumbers = <T extends Float64Array | Int32Array>(list: T): T => {
    const out = new (list.constructor as new (length: number) => T)(n + 1);
    for (let j = 0; j < n; j++) out[j] = list[from[j] as number] as number;
    out[n] = list[n] as number;
    return out;
  };
  const values = new Map<string, Column>();
  for (const [key, column] of grid.values) {
    if (column.type === 'text') {
      values.set(key, { type: 'text', text: Array.from(from, (o) => column.text[o] ?? null) });
    } else {
      const num = new Float64Array(n);
      for (let j = 0; j < n; j++) num[j] = column.num[from[j] as number] as number;
      values.set(key, { type: column.type, num });
    }
  }
  const columns: ColumnState[] = grid.columns.map((col) => {
    switch (col.kind) {
      case 'value':
        return {
          ...col,
          value: remapNumbers(col.value),
          valued: remapNumbers(col.valued),
          leaves: remapNumbers(col.leaves),
        };
      case 'count':
        return { ...col, count: remapNumbers(col.count) };
      case 'progress':
        return { ...col, closed: remapNumbers(col.closed), of: remapNumbers(col.of) };
      case 'formula':
        return { ...col, cache: Array.from(from, (o) => col.cache[o]) };
      default:
        return col;
    }
  });
  const closed = new Uint8Array(n);
  for (let j = 0; j < n; j++) closed[j] = grid.closed[from[j] as number] as number;
  const out: GridCompute = {
    skeleton: moved.skeleton,
    tree: next,
    specs: grid.specs,
    columns,
    hiddenBelow: remapNumbers(grid.hiddenBelow),
    values,
    closed,
  };
  const chain = new Set<number>();
  const climb = (start: number) => {
    for (let at = start; at < n; at = next.parent[at] as number) chain.add(at);
  };
  if (oldParent < n) {
    climb(to[oldParent] as number);
    forgetRow(out, to[oldParent] as number);
  }
  const newRow = to[row] as number;
  const newParent = next.parent[newRow] as number;
  if (newParent < n) {
    climb(newParent);
    forgetRow(out, newParent);
  }
  for (const at of [...chain].sort((a, b) => b - a)) computeAt(out, at);
  computeAt(out, n);
  return out;
}

function forgetRow(grid: GridCompute, row: number) {
  for (const col of grid.columns) if (col.kind === 'formula') col.cache[row] = undefined;
}

/** A ticket of the search route's shape, as a row edit reads it after a save. */
export interface SavedTicket {
  summary?: string;
  status?: { stage: 'new' | 'active' | 'closed' };
  fields?: Record<string, unknown>;
  [property: string]: unknown;
}

/** System refs of formulas by the property the ticket answer carries them in. */
const TICKET_PROPERTY: Readonly<Record<string, string>> = {
  summary: 'summary',
  due: 'dueDate',
  start: 'startDate',
  created: 'createdAt',
  updated: 'updatedAt',
  closed: 'closedAt',
  originalestimate: 'originalEstimate',
  remainingestimate: 'remainingEstimate',
  timespent: 'timeSpent',
};

/**
 * The edit a saved ticket makes to its row: the skeleton's refs it carries, and `closed` from its
 * status's stage. A ref the answer does not carry is left as it was.
 */
export function editOfTicket(grid: GridCompute, row: number, ticket: SavedTicket): RowEdit {
  const values: Record<string, number | string | null> = {};
  for (const f of grid.skeleton.fields) {
    const key = refKey(f.ref);
    const custom = CUSTOM_REF.exec(f.ref);
    let raw: unknown;
    let present: boolean;
    if (custom) {
      const id = String(Number(custom[1]));
      present = ticket.fields !== undefined;
      raw = ticket.fields?.[id];
    } else {
      const property = TICKET_PROPERTY[key];
      present = property !== undefined && property in ticket;
      raw = property === undefined ? undefined : ticket[property];
    }
    if (!present) continue;
    values[f.ref] = typeof raw === 'number' || typeof raw === 'string' ? raw : null;
  }
  const edit: RowEdit = { row, values };
  if (ticket.status) edit.closed = ticket.status.stage === 'closed';
  return edit;
}
