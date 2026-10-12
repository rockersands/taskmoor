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
