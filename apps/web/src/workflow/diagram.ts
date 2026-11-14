import type { WorkflowDefinition } from './definition';
import { reachableStatuses } from './lint';

/**
 * The diagram of a definition (M1-030, ADR-039 "Implementation (M1-030)"): statuses as boxes in
 * layers by their distance from the initial status, transitions as curves between them. It is
 * laid out from the definition every time, so it never needs saving; x and y in a definition
 * are kept as they are and not read. Pure geometry: the component draws what this returns.
 *
 * - Layer 0 holds the initial status; a status first reached by a transition from layer n
 *   sits in layer n + 1. Statuses entered only by global transitions or not at all share one
 *   last layer, where closed statuses usually end up.
 * - Within a layer, statuses follow the average row of the statuses that lead to them (one
 *   barycentre pass), then their order in the definition.
 * - Forward transitions run left to right between box sides; transitions back to an earlier
 *   layer curve below the boxes; transitions within a layer curve to the right; a self-loop
 *   hangs off a box's lower right corner. Global transitions show as a labelled tab above
 *   their target, so "from any status" never draws a line from every box.
 * - Two or more tabs on one status run side by side from its box's left edge; the gap after a
 *   column widens until its widest row of tabs ends before the next column. A lone tab is
 *   centred over its box with the free room around it, short of any neighbour's tabs, so tabs in
 *   one row never overlap (T-255).
 */
export const NODE_WIDTH = 156;
export const NODE_HEIGHT = 52;
const COLUMN_GAP = 132;
const ROW_GAP = 76;
const MARGIN_X = 24;
const MARGIN_TOP = 64;
export const LABEL_WIDTH = 116;
export const TAB_WIDTH = 140;
/** A lone tab's room: its box and half of the gap on each side, less a margin. */
export const LONE_TAB_WIDTH = NODE_WIDTH + COLUMN_GAP - 24;
const TAB_HEIGHT = 28;
/** Between two tabs side by side, and between one status's tabs and the next one's. */
const TAB_SPACE = 8;
const PARALLEL = 14;

/** How wide a status's row of `count` tabs is when it has two or more. */
const tabRow = (count: number) => count * TAB_WIDTH + (count - 1) * TAB_SPACE;

export interface DiagramNode {
  statusId: number;
  layer: number;
  row: number;
  x: number;
  y: number;
  /** False when no runnable path from the initial status leads here (lint warns). */
  reachable: boolean;
  initial: boolean;
}

export type EdgeKind = 'forward' | 'back' | 'side' | 'self' | 'global';

export interface DiagramEdge {
  key: string;
  transitionId: number;
  kind: EdgeKind;
  /** SVG path data, ending at the target where the arrowhead goes. */
  path: string;
  /** Where the transition's name sits (its centre), on one edge per transition. */
  label: { x: number; y: number; width: number } | null;
}

export interface Diagram {
  width: number;
  height: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

interface Point {
  x: number;
  y: number;
}

const r = (n: number) => Math.round(n * 10) / 10;
const curve = (a: Point, b: Point, c: Point, d: Point) =>
  `M${r(a.x)},${r(a.y)} C${r(b.x)},${r(b.y)} ${r(c.x)},${r(c.y)} ${r(d.x)},${r(d.y)}`;
/** The middle of a cubic curve, where its label goes. */
const middle = (a: Point, b: Point, c: Point, d: Point): Point => ({
  x: r(0.125 * a.x + 0.375 * b.x + 0.375 * c.x + 0.125 * d.x),
  y: r(0.125 * a.y + 0.375 * b.y + 0.375 * c.y + 0.125 * d.y),
});

/** Layers by breadth-first distance over transitions with a source list. */
export function layersOf(definition: WorkflowDefinition): Map<number, number> {
  const ids = definition.statuses.map((s) => s.statusId);
  const known = new Set(ids);
  const layer = new Map<number, number>();
  if (!known.has(definition.initialStatusId)) return layer;
  layer.set(definition.initialStatusId, 0);
  const queue = [definition.initialStatusId];
  while (queue.length > 0) {
    const at = queue.shift() as number;
    for (const t of definition.transitions) {
      if (t.from === 'any' || !t.from.includes(at) || !known.has(t.to) || layer.has(t.to)) continue;
      layer.set(t.to, (layer.get(at) ?? 0) + 1);
      queue.push(t.to);
    }
  }
  const last = ids.some((id) => !layer.has(id)) ? Math.max(0, ...layer.values()) + 1 : 0;
  for (const id of ids) if (!layer.has(id)) layer.set(id, last);
  return layer;
}

export function layoutDiagram(definition: WorkflowDefinition): Diagram {
  const ids = [...new Set(definition.statuses.map((s) => s.statusId))];
  const layers = layersOf(definition);
  const reached = reachableStatuses(definition);
  const columns = Math.max(0, ...layers.values()) + 1;

  // Rows: one barycentre pass, layer by layer, over the statuses leading in from the left.
  const rows = new Map<number, number>();
  for (let l = 0; l < columns; l++) {
    const members = ids.filter((id) => layers.get(id) === l);
    const weight = (id: number) => {
      const before = definition.transitions
        .filter((t) => t.to === id && t.from !== 'any')
        .flatMap((t) => (t.from === 'any' ? [] : t.from))
        .filter((s) => (layers.get(s) ?? l) < l && rows.has(s))
        .map((s) => rows.get(s) as number);
      return before.length > 0 ? before.reduce((a, b) => a + b, 0) / before.length : Infinity;
    };
    const ordered = members
      .map((id, index) => ({ id, index, w: weight(id) }))
      .sort((a, b) => (a.w === b.w ? a.index - b.index : a.w - b.w));
    ordered.forEach((m, row) => {
      rows.set(m.id, row);
    });
  }

  // A status with one global transition gives its tab the room above the box and half of each
  // gap beside it, so "Done (from any status)" is not cut while space is free (AD-5).
  const tabsOn = new Map<number, number>();
  for (const t of definition.transitions) {
    if (t.from === 'any') tabsOn.set(t.to, (tabsOn.get(t.to) ?? 0) + 1);
  }

  // Columns: the gap after one is wide enough for its widest row of tabs to end before the next.
  const columnX: number[] = [];
  for (let l = 0, x = MARGIN_X; l < columns; l++) {
    columnX.push(x);
    const past = ids
      .filter((id) => layers.get(id) === l && (tabsOn.get(id) ?? 0) >= 2)
      .map((id) => tabRow(tabsOn.get(id) ?? 0) - NODE_WIDTH);
    x += NODE_WIDTH + Math.max(COLUMN_GAP, ...past.map((p) => p + 2 * TAB_SPACE));
  }

  const nodes: DiagramNode[] = ids.map((statusId) => {
    const layer = layers.get(statusId) ?? 0;
    const row = rows.get(statusId) ?? 0;
    return {
      statusId,
      layer,
      row,
      x: columnX[layer] ?? MARGIN_X,
      y: MARGIN_TOP + row * (NODE_HEIGHT + ROW_GAP),
      reachable: reached.has(statusId),
      initial: statusId === definition.initialStatusId,
    };
  });
  const at = new Map(nodes.map((n) => [n.statusId, n]));

  const edges: DiagramEdge[] = [];
  // Edges between the same two statuses spread apart, so each stays visible.
  const pairCount = new Map<string, number>();
  const pairIndex = new Map<string, number>();
  for (const t of definition.transitions) {
    if (t.from === 'any') continue;
    for (const from of t.from) {
      const key = `${from}>${t.to}`;
      pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
    }
  }
  const tabs = new Map<number, number>();
  let bottom = 0;
  let right = 0;

  // The rows of two or more tabs, which a lone tab in the same row of boxes must stay clear of.
  const tabRows = nodes
    .filter((n) => (tabsOn.get(n.statusId) ?? 0) >= 2)
    .map((n) => ({ y: n.y, left: n.x, right: n.x + tabRow(tabsOn.get(n.statusId) ?? 0) }));
  /** Half the width a lone tab centred at `x` may take: the free room, short of the rows. */
  const loneHalf = (x: number, y: number) => {
    let half = Math.min(LONE_TAB_WIDTH / 2, x - 4);
    for (const row of tabRows) {
      if (row.y !== y) continue;
      if (row.right <= x) half = Math.min(half, x - row.right - TAB_SPACE);
      else if (row.left >= x) half = Math.min(half, row.left - x - TAB_SPACE);
    }
    return Math.max(TAB_WIDTH / 2, half);
  };

  for (const t of definition.transitions) {
    const target = at.get(t.to);
    if (!target) continue;
    if (t.from === 'any') {
      const index = tabs.get(t.to) ?? 0;
      tabs.set(t.to, index + 1);
      const alone = tabsOn.get(t.to) === 1;
      // Never past the drawing's left edge in the first column, nor into a neighbour's tabs.
      const width = alone ? 2 * loneHalf(target.x + NODE_WIDTH / 2, target.y) : TAB_WIDTH;
      const tab = {
        x: alone
          ? target.x + NODE_WIDTH / 2 - width / 2
          : target.x + index * (TAB_WIDTH + TAB_SPACE),
        y: target.y - TAB_HEIGHT - 18,
      };
      const centre = { x: tab.x + width / 2, y: tab.y + TAB_HEIGHT / 2 };
      const into = Math.min(centre.x, target.x + NODE_WIDTH - 16);
      edges.push({
        key: `${t.id}:any`,
        transitionId: t.id,
        kind: 'global',
        path: `M${r(centre.x)},${r(tab.y + TAB_HEIGHT)} L${r(into)},${r(target.y)}`,
        label: { x: r(centre.x), y: r(centre.y), width },
      });
      right = Math.max(right, tab.x + width);
      continue;
    }
    let labelled = false;
    for (const from of t.from) {
      const source = at.get(from);
      if (!source) continue;
      const key = `${from}>${t.to}`;
      const n = pairCount.get(key) ?? 1;
      const i = pairIndex.get(key) ?? 0;
      pairIndex.set(key, i + 1);
      const offset = (i - (n - 1) / 2) * PARALLEL;
      let points: [Point, Point, Point, Point];
      let kind: EdgeKind;
      if (from === t.to) {
        kind = 'self';
        const s = { x: source.x + NODE_WIDTH - 28 - i * 10, y: source.y + NODE_HEIGHT };
        const e = { x: source.x + NODE_WIDTH, y: source.y + NODE_HEIGHT - 14 - i * 6 };
        const reach = 36 + i * 14;
        points = [s, { x: s.x, y: s.y + reach }, { x: e.x + reach, y: e.y }, e];
      } else if (target.layer > source.layer) {
        kind = 'forward';
        const s = { x: source.x + NODE_WIDTH, y: source.y + NODE_HEIGHT / 2 + offset };
        const e = { x: target.x, y: target.y + NODE_HEIGHT / 2 + offset };
        const dx = (e.x - s.x) / 2;
        points = [s, { x: s.x + dx, y: s.y }, { x: e.x - dx, y: e.y }, e];
      } else if (target.layer === source.layer) {
        kind = 'side';
        const s = { x: source.x + NODE_WIDTH, y: source.y + NODE_HEIGHT / 2 + offset };
        const e = { x: target.x + NODE_WIDTH, y: target.y + NODE_HEIGHT / 2 + offset };
        const reach = 56 + Math.abs(target.row - source.row) * 12;
        points = [s, { x: s.x + reach, y: s.y }, { x: e.x + reach, y: e.y }, e];
      } else {
        kind = 'back';
        const s = { x: source.x + NODE_WIDTH / 2 + 12 + offset, y: source.y + NODE_HEIGHT };
        const e = { x: target.x + NODE_WIDTH / 2 - 12 + offset, y: target.y + NODE_HEIGHT };
        const bulge = 44 + (source.layer - target.layer) * 14 + Math.abs(offset);
        const low = Math.max(s.y, e.y) + bulge;
        points = [s, { x: s.x, y: low }, { x: e.x, y: low }, e];
      }
      const mid = middle(...points);
      edges.push({
        key: `${t.id}:${from}`,
        transitionId: t.id,
        kind,
        path: curve(...points),
        label: labelled ? null : { ...mid, width: LABEL_WIDTH },
      });
      labelled = true;
      for (const p of [...points, mid]) {
        bottom = Math.max(bottom, p.y);
        right = Math.max(right, p.x);
      }
    }
  }

  for (const n of nodes) {
    bottom = Math.max(bottom, n.y + NODE_HEIGHT);
    right = Math.max(right, n.x + NODE_WIDTH);
  }
  for (const e of edges) {
    if (!e.label) continue;
    bottom = Math.max(bottom, e.label.y + 16);
    right = Math.max(right, e.label.x + e.label.width / 2);
  }
  return {
    width: Math.ceil(right + MARGIN_X),
    height: Math.ceil(bottom + MARGIN_X),
    nodes,
    edges,
  };
}
