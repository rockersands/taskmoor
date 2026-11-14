/**
 * The pure step of a Grid's read (PLN-010; ADR-122 stage 10): a structure's steps applied to the
 * tickets one viewer may see, as rows in preorder.
 *
 * - **Add tickets:** the inserted tickets by rank, then id; one whose parent is also inserted sits
 *   under it. A loop that bad or imported data could make is broken: the first ticket of the loop
 *   in rank order becomes a top row.
 * - **Group by** (0 to 2): the top rows under group rows by a field's value, ordered by label,
 *   "No value" last; a second grouping nests inside the first.
 * - **Add children:** breadth first under every ticket row, down `maxDepth` levels.
 * - **Add linked tickets** (each step in turn): breadth first under every ticket row present at
 *   that point, `depth` levels down.
 *
 * A ticket appears once, where the steps first reach it, in step order, then breadth first by row
 * order; a later reach adds one to the reaching row's `elsewhere`. Hidden tickets are never given
 * here: a row's `notShown` is the hidden children and hidden linked tickets counted for it by the
 * steps that expanded it. Siblings are ordered by rank then id. Past `limit` rows (group rows
 * included) the tree stops and says so (`more`); the rows given are a prefix of the preorder, so
 * every row's parent is among them.
 */

/** A ticket the viewer may see, as the tree needs it. */
export interface TreeTicket {
  id: number;
  /** Its parent when the viewer may see it, else null. */
  parent: number | null;
  rank: string;
  key: string;
  track: number;
  /** Its hierarchy level's rank. */
  level: number;
  /** In the plan's tickets for the viewer, without the page's filters. */
  inPlan: boolean;
  /** In a status of the closed stage. */
  closed: boolean;
}

/** One Group by step: each inserted ticket's value (null for none) and each value's label. */
export interface GroupLevel {
  field: string;
  values: ReadonlyMap<number, string | null>;
  labels: ReadonlyMap<string, string>;
}

/** An expanding step: whom each ticket reaches, and how many hidden tickets it would reach. */
export interface ExpandLevel {
  edges: ReadonlyMap<number, readonly number[]>;
  hidden: ReadonlyMap<number, number>;
  /** Levels the step goes down. */
  depth: number;
}

export interface StructureInput {
  /** Every ticket any step may place, by id. */
  tickets: ReadonlyMap<number, TreeTicket>;
  /** The Add tickets step's tickets, in any order. */
  inserted: readonly number[];
  groups: readonly GroupLevel[];
  /** The Add children step, if the structure has one: parent to children. */
  children: ExpandLevel | null;
  /** The Add linked tickets steps, in order. */
  links: readonly ExpandLevel[];
  /** Rows at most, group rows included. */
  limit: number;
}

/** Where a row came from: 0 inserted, 1 a child, 2 + n the nth links step (from 0). */
export const VIA_INSERTED = 0;
export const VIA_CHILD = 1;
export const VIA_LINKS = 2;

export interface StructureRows {
  /** The ticket's id; 0 for a group row. */
  ticket: number[];
  key: string[];
  /** The parent row's index; -1 at the top. */
  parent: number[];
  depth: number[];
  /** The ticket's hierarchy level rank; 0 for a group row. */
  level: number[];
  /** The ticket's track id; 0 for a group row. */
  track: number[];
  inPlan: boolean[];
  via: number[];
  closed: boolean[];
  notShown: number[];
  elsewhere: number[];
}

export interface StructureGroup {
  row: number;
  field: string;
  /** The value's id; null for "No value". */
  value: string | null;
  /** The value's name; null for "No value". */
  label: string | null;
}

export interface BuiltStructure {
  total: number;
  more: boolean;
  rows: StructureRows;
  groups: StructureGroup[];
}

interface Node {
  ticket: number;
  parent: Node | null;
  kids: Node[];
  via: number;
  notShown: number;
  elsewhere: number;
  group?: { field: string; value: string | null; label: string | null };
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildStructure(input: StructureInput): BuiltStructure {
  const { tickets, limit } = input;
  const byRank = (a: number, b: number) => {
    const p = tickets.get(a) as TreeTicket;
    const q = tickets.get(b) as TreeTicket;
    return compareText(p.rank, q.rank) || a - b;
  };
  const nodeOrder = (a: Node, b: Node) => byRank(a.ticket, b.ticket);
  const placed = new Map<number, Node>();
  let count = 0;
  let more = false;
  const room = () => {
    if (count < limit) return true;
    more = true;
    return false;
  };
  const make = (ticket: number, parent: Node | null, via: number): Node => {
    const node: Node = { ticket, parent, kids: [], via, notShown: 0, elsewhere: 0 };
    if (parent) parent.kids.push(node);
    placed.set(ticket, node);
    count++;
    return node;
  };

  // Add tickets: nested by parent among themselves, loops broken.
  const inserted = [...new Set(input.inserted)].filter((id) => tickets.has(id)).sort(byRank);
  const insertedSet = new Set(inserted);
  const under = new Map<number, number[]>();
  const nestedIn = (id: number) => {
    const p = (tickets.get(id) as TreeTicket).parent;
    return p !== null && p !== id && insertedSet.has(p) ? p : null;
  };
  for (const id of inserted) {
    const p = nestedIn(id);
    if (p !== null) under.set(p, [...(under.get(p) ?? []), id]);
  }
  let top: Node[] = [];
  const grow = (rootId: number) => {
    if (placed.has(rootId) || !room()) return;
    const root = make(rootId, null, VIA_INSERTED);
    top.push(root);
    const stack: Node[] = [root];
    while (stack.length > 0) {
      const node = stack.pop() as Node;
      for (const kid of under.get(node.ticket) ?? []) {
        if (placed.has(kid) || !room()) continue;
        stack.push(make(kid, node, VIA_INSERTED));
      }
    }
  };
  for (const id of inserted) if (nestedIn(id) === null) grow(id);
  // What is left sits in a loop: its first ticket in rank order becomes a top row.
  for (const id of inserted) grow(id);
  top.sort(nodeOrder);

  // Group by: the top rows under group rows, nested.
  const groupOf = (level: GroupLevel, rows: Node[], parent: Node | null): Node[] => {
    const buckets = new Map<string | null, Node[]>();
    for (const row of rows) {
      const v = level.values.get(row.ticket) ?? null;
      buckets.set(v, [...(buckets.get(v) ?? []), row]);
    }
    const values = [...buckets.keys()].sort((a, b) => {
      if (a === null) return b === null ? 0 : 1;
      if (b === null) return -1;
      const la = level.labels.get(a) ?? '';
      const lb = level.labels.get(b) ?? '';
      return (
        la.localeCompare(lb, 'en', { sensitivity: 'base' }) ||
        compareText(la, lb) ||
        compareText(a, b)
      );
    });
    const out: Node[] = [];
    for (const value of values) {
      const node: Node = {
        ticket: 0,
        parent,
        kids: [],
        via: VIA_INSERTED,
        notShown: 0,
        elsewhere: 0,
        group: {
          field: level.field,
          value,
          label: value === null ? null : (level.labels.get(value) ?? ''),
        },
      };
      count++;
      for (const row of buckets.get(value) as Node[]) {
        row.parent = node;
        node.kids.push(row);
      }
      out.push(node);
    }
    return out;
  };
  if (input.groups.length > 0 && top.length > 0) {
    const [first, second] = input.groups as [GroupLevel, GroupLevel | undefined];
    top = groupOf(first, top, null);
    if (second) {
      for (const g of top) g.kids = groupOf(second, g.kids, g);
    }
  }

  const sortKids = (node: Node) => {
    if (node.kids.length > 1 && node.kids[0]?.group === undefined) node.kids.sort(nodeOrder);
  };
  const ticketRows = (): Node[] => {
    const out: Node[] = [];
    const stack = [...top].reverse();
    while (stack.length > 0) {
      const node = stack.pop() as Node;
      sortKids(node);
      if (node.group === undefined) out.push(node);
      for (let i = node.kids.length - 1; i >= 0; i--) stack.push(node.kids[i] as Node);
    }
    return out;
  };

  const expand = (step: ExpandLevel, via: number) => {
    let frontier = ticketRows();
    for (let level = 0; level < step.depth && frontier.length > 0; level++) {
      const next: Node[] = [];
      for (const row of frontier) {
        row.notShown += step.hidden.get(row.ticket) ?? 0;
        const reached = [...new Set(step.edges.get(row.ticket) ?? [])]
          .filter((id) => id !== row.ticket && tickets.has(id))
          .sort(byRank);
        for (const id of reached) {
          const there = placed.get(id);
          if (there) {
            if (there.parent !== row) row.elsewhere++;
            continue;
          }
          if (!room()) continue;
          next.push(make(id, row, via));
        }
      }
      frontier = next;
    }
  };
  if (input.children) expand(input.children, VIA_CHILD);
  input.links.forEach((step, n) => {
    expand(step, VIA_LINKS + n);
  });

  // The rows in preorder, cut at the limit: a prefix keeps every row's parent.
  const rows: StructureRows = {
    ticket: [],
    key: [],
    parent: [],
    depth: [],
    level: [],
    track: [],
    inPlan: [],
    via: [],
    closed: [],
    notShown: [],
    elsewhere: [],
  };
  const groups: StructureGroup[] = [];
  const index = new Map<Node, number>();
  const stack = [...top].reverse();
  while (stack.length > 0) {
    if (rows.ticket.length >= limit) {
      more = true;
      break;
    }
    const node = stack.pop() as Node;
    sortKids(node);
    const at = rows.ticket.length;
    index.set(node, at);
    const parentAt = node.parent ? (index.get(node.parent) as number) : -1;
    rows.parent.push(parentAt);
    rows.depth.push(parentAt === -1 ? 0 : (rows.depth[parentAt] as number) + 1);
    rows.via.push(node.via);
    rows.notShown.push(node.notShown);
    rows.elsewhere.push(node.elsewhere);
    if (node.group) {
      rows.ticket.push(0);
      rows.key.push('');
      rows.level.push(0);
      rows.track.push(0);
      rows.inPlan.push(true);
      rows.closed.push(false);
      groups.push({ row: at, ...node.group });
    } else {
      const t = tickets.get(node.ticket) as TreeTicket;
      rows.ticket.push(t.id);
      rows.key.push(t.key);
      rows.level.push(t.level);
      rows.track.push(t.track);
      rows.inPlan.push(t.inPlan);
      rows.closed.push(t.closed);
    }
    for (let i = node.kids.length - 1; i >= 0; i--) stack.push(node.kids[i] as Node);
  }
  return { total: rows.ticket.length, more, rows, groups };
}
