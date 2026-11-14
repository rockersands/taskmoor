import { type GridSkeleton, placedByLink, VIA_CHILD, VIA_INSERTED } from './types';

/**
 * The Grid's tree over a skeleton (ADR-122 stage 10, PLN-010): rows are in preorder, so a row's
 * rows below are the run of rows after it, up to `end`. Index `n` stands for the last row, the
 * one that totals the top rows; its children are the rows with parent -1. Everything here is
 * pure, linear, and keeps no reference to the page.
 */
export interface GridTree {
  /** Rows in the skeleton. */
  n: number;
  /** The parent's index; `n` at the top. */
  parent: Int32Array;
  depth: Int32Array;
  /** One past a row's last row below: its rows below are `row + 1` to `end - 1`. */
  end: Int32Array;
  /** Child rows of row `i` (and of `n`, the top) are `children[childStart[i] .. childStart[i + 1]]`. */
  childStart: Int32Array;
  children: Int32Array;
  /** The row's place among its siblings, from 1 (`aria-posinset`). */
  posInSet: Int32Array;
  /** 1 for a ticket row, 0 for a group row. */
  isTicket: Uint8Array;
}

/** A skeleton whose rows are not a tree in preorder. */
export class SkeletonError extends Error {}

/** Builds the tree in one pass over the parents, checking that the rows are in preorder. */
export function buildTree(skeleton: GridSkeleton): GridTree {
  const rows = skeleton.rows;
  const n = rows.ticket.length;
  for (const [name, list] of Object.entries(rows)) {
    if ((list as unknown[]).length !== n) {
      throw new SkeletonError(`rows.${name} has ${(list as unknown[]).length} entries, not ${n}`);
    }
  }
  const parent = new Int32Array(n);
  const depth = new Int32Array(n);
  const counts = new Int32Array(n + 2);
  const isTicket = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = rows.parent[i] as number;
    if (!Number.isInteger(p) || p < -1 || p >= i) {
      throw new SkeletonError(`row ${i} has parent ${p}: a parent comes before its rows`);
    }
    const at = p === -1 ? n : p;
    parent[i] = at;
    depth[i] = p === -1 ? 0 : (depth[p] as number) + 1;
    counts[at + 1] = (counts[at + 1] as number) + 1;
    isTicket[i] = (rows.ticket[i] as number) > 0 ? 1 : 0;
  }
  const childStart = new Int32Array(n + 2);
  for (let i = 1; i <= n + 1; i++) {
    childStart[i] = (childStart[i - 1] as number) + (counts[i] as number);
  }
  const fill = childStart.slice(0, n + 1);
  const children = new Int32Array(n);
  const posInSet = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const at = parent[i] as number;
    const slot = fill[at] as number;
    children[slot] = i;
    posInSet[i] = slot - (childStart[at] as number) + 1;
    fill[at] = slot + 1;
  }
  const size = new Int32Array(n).fill(1);
  for (let i = n - 1; i >= 0; i--) {
    const at = parent[i] as number;
    if (at < n) size[at] = (size[at] as number) + (size[i] as number);
  }
  const end = new Int32Array(n);
  for (let i = 0; i < n; i++) end[i] = i + (size[i] as number);
  // Preorder: each row's first child follows it, each next sibling follows the last one's rows.
  for (let at = 0; at <= n; at++) {
    let next = at === n ? 0 : at + 1;
    for (let c = childStart[at] as number; c < (childStart[at + 1] as number); c++) {
      const child = children[c] as number;
      if (child !== next) throw new SkeletonError(`row ${child} is not in preorder`);
      next = end[child] as number;
    }
    if (next !== (at === n ? n : end[at])) throw new SkeletonError(`rows below ${at} interleave`);
  }
  return { n, parent, depth, end, childStart, children, posInSet, isTicket };
}

export const childCount = (tree: GridTree, row: number) =>
  (tree.childStart[row + 1] as number) - (tree.childStart[row] as number);

export const hasRowsBelow = (tree: GridTree, row: number) => childCount(tree, row) > 0;

/** `aria-setsize`: the number of the row's siblings, itself included. */
export const setSize = (tree: GridTree, row: number) =>
  childCount(tree, tree.parent[row] as number);

/** The rows above a row, nearest first, up to a top row (the last row, `n`, not included). */
export function ancestors(tree: GridTree, row: number): number[] {
  const out: number[] = [];
  for (let at = tree.parent[row] as number; at < tree.n; at = tree.parent[at] as number) {
    out.push(at);
  }
  return out;
}

/**
 * The skeleton rows drawn, in order, with `collapsed` rows' rows below left out: one pass on each
 * expand or collapse, skipping each collapsed run at once.
 */
export function visibleRows(tree: GridTree, collapsed: ReadonlySet<number>): Int32Array {
  if (collapsed.size === 0) return Int32Array.from({ length: tree.n }, (_, i) => i);
  const out = new Int32Array(tree.n);
  let k = 0;
  let i = 0;
  while (i < tree.n) {
    out[k++] = i;
    i = collapsed.has(i) ? (tree.end[i] as number) : i + 1;
  }
  return out.slice(0, k);
}

/** Every row with rows below, for Collapse all. */
export function allCollapsible(tree: GridTree): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < tree.n; i++) if ((tree.end[i] as number) > i + 1) out.add(i);
  return out;
}

/**
 * A row's name that survives a reload, for the collapsed rows kept in this browser
 * (`taskmoor.grid.<planId>.<structureId>`): `t<ticket>` for a ticket row (a ticket appears once),
 * and the group path for a group row (`g<field>=<label>` under its groups).
 */
export function rowKeys(skeleton: GridSkeleton, tree: GridTree): string[] {
  const groupOf = new Map(skeleton.groups.map((g) => [g.row, g]));
  const keys: string[] = new Array(tree.n);
  for (let i = 0; i < tree.n; i++) {
    const ticket = skeleton.rows.ticket[i] as number;
    if (ticket > 0) {
      keys[i] = `t${ticket}`;
      continue;
    }
    const g = groupOf.get(i);
    const own = `g${encodeURIComponent(g?.field ?? '')}=${encodeURIComponent(g?.label ?? String(i))}`;
    const p = tree.parent[i] as number;
    keys[i] = p < tree.n ? `${keys[p]}/${own}` : own;
  }
  return keys;
}

/** The collapsed rows a list of kept keys names; keys of rows no longer there are dropped. */
export function collapsedFromKeys(
  skeleton: GridSkeleton,
  tree: GridTree,
  keys: Iterable<string>,
): Set<number> {
  const wanted = new Set(keys);
  const out = new Set<number>();
  if (wanted.size === 0) return out;
  rowKeys(skeleton, tree).forEach((k, i) => {
    if (wanted.has(k) && (tree.end[i] as number) > i + 1) out.add(i);
  });
  return out;
}

/** Why a row cannot move under a target, in the words of the ticket route, or null. */
export type MoveProblem =
  /** A group row moves nothing and is no parent ("A group is not a parent", question 13). */
  | 'group_row'
  | 'group_target'
  /** Its place comes from a link, not its parent (question 12). */
  | 'placed_by_link'
  /** Under itself or one of its rows below. */
  | 'own_rows'
  /** Already there. */
  | 'same_parent'
  /** `placementProblem` of the ticket route: a parent exactly one level up. */
  | 'wrong_level'
  /** A subticket stays in its parent's track. */
  | 'other_track'
  /** A subticket needs a parent. */
  | 'required';

const SUBTICKET_RANK = -1;

/**
 * Whether a row may move under `target` (a row index, or -1 for Remove from parent), as the page
 * offers it before the server's own checks: the target a ticket row exactly one level up, in the
 * same track for a subticket (`placementProblem`, `routes/tickets.ts`).
 */
export function moveProblem(
  skeleton: GridSkeleton,
  tree: GridTree,
  row: number,
  target: number,
): MoveProblem | null {
  const rows = skeleton.rows;
  if (!tree.isTicket[row]) return 'group_row';
  if (placedByLink(rows.via[row] as number)) return 'placed_by_link';
  const parentRow = tree.parent[row] as number;
  const level = rows.level[row] as number;
  if (target === -1) {
    if (level === SUBTICKET_RANK) return 'required';
    return parentRow === tree.n || !tree.isTicket[parentRow] ? 'same_parent' : null;
  }
  if (!tree.isTicket[target]) return 'group_target';
  if (target >= row && target < (tree.end[row] as number)) return 'own_rows';
  if (target === parentRow) return 'same_parent';
  if ((rows.level[target] as number) !== level + 1) return 'wrong_level';
  if (level === SUBTICKET_RANK && rows.track[target] !== rows.track[row]) return 'other_track';
  return null;
}

/** A skeleton after a move, and for each new row index the old one (`from[new] = old`). */
export interface Moved {
  skeleton: GridSkeleton;
  from: Int32Array;
}

/**
 * Moves a row with everything below it to the end of `target`'s rows (-1: the end of the top
 * rows), keeping preorder; depths follow, and the row is now placed as a child. Its place among
 * new siblings is a guess until the skeleton is read again behind (siblings are by rank, which
 * the browser does not hold). The skeleton given is left unchanged.
 */
export function moveSubtree(
  skeleton: GridSkeleton,
  tree: GridTree,
  row: number,
  target: number,
): Moved {
  const n = tree.n;
  const last = tree.end[row] as number;
  if (target >= row && target < last) throw new RangeError('A row cannot move under its own rows');
  const insertAt = target === -1 ? n : (tree.end[target] as number);
  const from = new Int32Array(n);
  let k = 0;
  const take = (a: number, b: number) => {
    for (let i = a; i < b; i++) from[k++] = i;
  };
  if (insertAt <= row) {
    take(0, insertAt);
    take(row, last);
    take(insertAt, row);
    take(last, n);
  } else {
    take(0, row);
    take(last, insertAt);
    take(row, last);
    take(insertAt, n);
  }
  const to = new Int32Array(n);
  for (let j = 0; j < n; j++) to[from[j] as number] = j;
  const delta =
    (target === -1 ? 0 : (tree.depth[target] as number) + 1) - (tree.depth[row] as number);
  const permute = <T>(list: readonly T[]): T[] => Array.from(from, (old) => list[old] as T);
  const old = skeleton.rows;
  const parent = Array.from(from, (o) => {
    if (o === row) return target === -1 ? -1 : (to[target] as number);
    const p = old.parent[o] as number;
    return p === -1 ? -1 : (to[p] as number);
  });
  const depth = Array.from(from, (o) => {
    const d = tree.depth[o] as number;
    return o >= row && o < last ? d + delta : d;
  });
  const via = permute(old.via);
  via[to[row] as number] = target === -1 ? VIA_INSERTED : VIA_CHILD;
  const values: GridSkeleton['values'] = {};
  for (const [ref, list] of Object.entries(skeleton.values)) values[ref] = permute(list);
  return {
    skeleton: {
      ...skeleton,
      rows: {
        ticket: permute(old.ticket),
        key: permute(old.key),
        parent,
        depth,
        level: permute(old.level),
        track: permute(old.track),
        inPlan: permute(old.inPlan),
        via,
        closed: permute(old.closed),
        notShown: permute(old.notShown),
        elsewhere: permute(old.elsewhere),
      },
      groups: skeleton.groups.map((g) => ({ ...g, row: to[g.row] as number })),
      values,
    },
    from,
  };
}
