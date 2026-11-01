/**
 * The Jira-compatible document format ("ADF" in Atlassian's documentation): a JSON tree of
 * typed nodes with attributes, marks on text, and a version number on the root. These types
 * describe the shape as published; the product adds nothing to it.
 */
export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  version?: number;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: AdfMark[];
  text?: string;
}

export function adfDoc(content: AdfNode[]): AdfNode {
  return { version: 1, type: 'doc', content };
}

/** Number of nodes in the tree, root included. */
export function countNodes(node: AdfNode): number {
  return 1 + (node.content?.reduce((n, child) => n + countNodes(child), 0) ?? 0);
}

/**
 * A comparable form: marks sorted by type, adjacent text runs with the same marks merged, empty
 * attribute objects dropped, undefined values removed. The format gives mark order and run
 * boundaries no meaning; the editor stores marks in schema order and merges equal runs.
 */
export function canonicalAdf(node: AdfNode): AdfNode {
  const out: AdfNode = { type: node.type };
  if (node.version !== undefined) out.version = node.version;
  if (node.text !== undefined) out.text = node.text;
  const attrs = cleanAttrs(node.attrs);
  if (attrs) out.attrs = attrs;
  if (node.marks && node.marks.length > 0) {
    out.marks = node.marks
      .map((m) => {
        const a = cleanAttrs(m.attrs);
        return a ? { type: m.type, attrs: a } : { type: m.type };
      })
      .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  }
  if (node.content) out.content = mergeTextRuns(node.content.map(canonicalAdf));
  return out;
}

function mergeTextRuns(nodes: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (
      last?.type === 'text' &&
      n.type === 'text' &&
      JSON.stringify(last.marks ?? []) === JSON.stringify(n.marks ?? [])
    ) {
      last.text = (last.text ?? '') + (n.text ?? '');
    } else {
      out.push(n);
    }
  }
  return out;
}

function cleanAttrs(
  attrs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!attrs) return undefined;
  const entries = Object.entries(attrs).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([k, v]) => [k, clone(v)]));
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** How deep a document may nest, in the format or stored (M1-118; real documents stay under 20). */
export const MAX_DOCUMENT_DEPTH = 128;

/**
 * The widest or tallest a table cell may span. Writers lay spans out as cells, so a span of
 * `1e308` made the Markdown writer allocate until the process died (M1-118, `pnpm fuzz adf`).
 */
export const MAX_TABLE_SPAN = 1000;

const TABLE_CELLS = new Set(['tableCell', 'tableHeader']);

/** Why a cell's `colspan` or `rowspan` cannot be laid out, or null. */
function spanProblem(
  type: string,
  attrs: Record<string, unknown> | null | undefined,
): string | null {
  if (!TABLE_CELLS.has(type) || !attrs) return null;
  for (const key of ['colspan', 'rowspan']) {
    const v = attrs[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_TABLE_SPAN) {
      return `a ${key} that is not a whole number from 1 to ${MAX_TABLE_SPAN}`;
    }
  }
  return null;
}

/** A span as writers lay it out: a whole number from 1 to `MAX_TABLE_SPAN`. */
export function layoutSpan(value: unknown): number {
  const n = Math.trunc(Number(value ?? 1));
  return Number.isFinite(n) ? Math.min(MAX_TABLE_SPAN, Math.max(1, n)) : 1;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Why a value is not a well-formed tree in the Jira-compatible format, or null: every node an
 * object with a string `type`; `attrs` an object; `marks` a list of objects with a string
 * `type` and object `attrs`; `content` a list of nodes; `text` a string; no deeper than
 * `MAX_DOCUMENT_DEPTH`. Readers and writers rely on that shape, so a document that breaks it is
 * refused at the door rather than failing later on every read (M1-118, found by
 * `pnpm fuzz adf`). Walks without recursion, so a deep tree cannot exhaust the stack.
 */
export function adfShapeProblem(root: unknown): string | null {
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (depth > MAX_DOCUMENT_DEPTH) return `nested deeper than ${MAX_DOCUMENT_DEPTH}`;
    if (!isPlainObject(node)) return 'a node that is not an object';
    if (typeof node.type !== 'string') return 'a node without a type';
    if (node.attrs !== undefined && node.attrs !== null && !isPlainObject(node.attrs)) {
      return `attributes of ${node.type} that are not an object`;
    }
    const span = spanProblem(node.type, node.attrs as Record<string, unknown> | undefined);
    if (span) return span;
    if (node.text !== undefined && typeof node.text !== 'string') {
      return `text of ${node.type} that is not a string`;
    }
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) return `marks of ${node.type} that are not a list`;
      for (const m of node.marks) {
        if (!isPlainObject(m) || typeof m.type !== 'string') return 'a mark without a type';
        if (m.attrs !== undefined && m.attrs !== null && !isPlainObject(m.attrs)) {
          return `attributes of a ${m.type} mark that are not an object`;
        }
      }
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) return `content of ${node.type} that is not a list`;
      for (const child of node.content) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return null;
}

/**
 * The same for a stored document (the editor's JSON): its nodes, plus the other format's
 * attributes it keeps (`adfAttrs`, the whole node of an `unknownBlock` or `unknownInline`, an
 * `unknownMark`'s attributes), which the writers read back. Null when well formed.
 */
export function docShapeProblem(root: unknown): string | null {
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 1 }];
  const keptAttrs = (attrs: Record<string, unknown>, what: string): string | null => {
    const kept = attrs.adfAttrs;
    if (kept !== undefined && kept !== null && !isPlainObject(kept)) {
      return `kept attributes of ${what} that are not an object`;
    }
    return null;
  };
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (depth > MAX_DOCUMENT_DEPTH) return `nested deeper than ${MAX_DOCUMENT_DEPTH}`;
    if (!isPlainObject(node) || typeof node.type !== 'string') return 'a node without a type';
    if (node.attrs !== undefined && node.attrs !== null) {
      if (!isPlainObject(node.attrs)) return `attributes of ${node.type} that are not an object`;
      const problem = keptAttrs(node.attrs, node.type) ?? spanProblem(node.type, node.attrs);
      if (problem) return problem;
      if (node.type === 'unknownBlock' || node.type === 'unknownInline') {
        const kept = adfShapeProblem(node.attrs.adf);
        if (kept) return `the kept ${node.type}: ${kept}`;
      }
    }
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) return `marks of ${node.type} that are not a list`;
      for (const m of node.marks) {
        if (!isPlainObject(m) || typeof m.type !== 'string') return 'a mark without a type';
        if (m.attrs === undefined || m.attrs === null) continue;
        if (!isPlainObject(m.attrs)) return `attributes of a ${m.type} mark that are not an object`;
        const problem = keptAttrs(m.attrs, `a ${m.type} mark`);
        if (problem) return problem;
        const inner = m.attrs.attrs;
        if (
          m.type === 'unknownMark' &&
          inner !== undefined &&
          inner !== null &&
          !isPlainObject(inner)
        ) {
          return 'kept attributes of an unknown mark that are not an object';
        }
      }
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) return `content of ${node.type} that is not a list`;
      for (const child of node.content) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return null;
}
