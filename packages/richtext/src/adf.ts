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

/**
 * The new blocks' values (NTF-014). Neither reaches a URL or the DOM as markup: a ticket reference
 * holds a key and an attachment reference a file name, which readers look up on the ticket.
 */
export const TICKET_KEY = /^[A-Za-z][A-Za-z0-9_]{0,99}-[0-9]{1,18}$/;
export const MAX_TITLE_LENGTH = 255;
export const MAX_ATTACHMENT_NAME = 255;
/** The most columns a layout may hold, as the Jira-compatible format lays them out. */
export const MAX_COLUMNS = 6;
/** Text with no control characters, within a length. */
const plainLine = (v: unknown, max: number): boolean =>
  typeof v === 'string' &&
  v.length <= max &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  !/[\u0000-\u001f\u007f]/.test(v);
export const isExpandTitle = (v: unknown): v is string => plainLine(v, MAX_TITLE_LENGTH);

/**
 * A section title as the document may hold it (NTF-014): one line, with control characters and
 * runs of white space read as one space, within the length. Markdown and pasted HTML both read a
 * title through it, so a title like `Step<tab>1` is never refused on save.
 */
export function expandTitleLine(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it replaces
      .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
      .trim()
      .slice(0, MAX_TITLE_LENGTH)
      .trimEnd()
  );
}

export const isAttachmentName = (v: unknown): v is string =>
  plainLine(v, MAX_ATTACHMENT_NAME) && (v as string).trim() !== '';

/**
 * What tells two files of one name apart (ADR-120, TT-4): the first hexadecimal digits of the
 * file's SHA-256. A clone and an import keep a file's bytes, so they keep it too; it is no id and
 * no address. The picker writes `DIGEST_LENGTH` digits; a longer one, up to the whole, reads too.
 */
export const DIGEST_LENGTH = 16;
const DIGEST = /^[0-9a-f]{8,64}$/;
export const isAttachmentDigest = (v: unknown): v is string =>
  typeof v === 'string' && DIGEST.test(v);

/**
 * A column's width as a layout shows it (ADR-120, TT-2): a percentage above 0 and up to 100. The
 * other format may hold others, which are kept for export and not shown.
 */
export function shownColumnWidth(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100 ? v : null;
}

/**
 * The tracks a layout's columns take, as a value for its `--rt-columns` property, or null when
 * any column has no width a layout shows (then they are equal). Built from numbers only, so a
 * document can put nothing else into a style.
 */
export function columnTracks(widths: readonly unknown[]): string | null {
  const shown = widths.map(shownColumnWidth);
  if (shown.length === 0 || shown.some((w) => w === null)) return null;
  return shown.map((w) => `minmax(0, ${Number((w as number).toFixed(4))}fr)`).join(' ');
}

/** Why a new block's attributes are not what it may hold, or null. */
function blockValueProblem(type: string, attrs: Record<string, unknown>): string | null {
  switch (type) {
    case 'ticketRef':
      return typeof attrs.key === 'string' && TICKET_KEY.test(attrs.key)
        ? null
        : 'a ticket reference without a ticket key';
    case 'attachmentRef':
      if (!isAttachmentName(attrs.name)) return 'an attachment reference without a file name';
      return attrs.digest === undefined || attrs.digest === null || isAttachmentDigest(attrs.digest)
        ? null
        : 'an attachment reference whose digest is not hexadecimal digits';
    case 'column':
      return attrs.width === undefined || attrs.width === null || typeof attrs.width === 'number'
        ? null
        : 'a column whose width is not a number';
    case 'expand':
      return attrs.title === undefined || attrs.title === null || isExpandTitle(attrs.title)
        ? null
        : 'a collapsible section with a title that is not a line of text';
    default:
      return null;
  }
}

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
 * `unknownMark`'s attributes, an `attachmentRef`'s media node), which the writers read back.
 * Null when well formed.
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
    if (
      (node.type === 'ticketRef' || node.type === 'attachmentRef') &&
      !isPlainObject(node.attrs)
    ) {
      return blockValueProblem(node.type, {});
    }
    if (node.attrs !== undefined && node.attrs !== null) {
      if (!isPlainObject(node.attrs)) return `attributes of ${node.type} that are not an object`;
      const problem =
        keptAttrs(node.attrs, node.type) ??
        spanProblem(node.type, node.attrs) ??
        blockValueProblem(node.type, node.attrs);
      if (problem) return problem;
      if (node.type === 'unknownBlock' || node.type === 'unknownInline') {
        const kept = adfShapeProblem(node.attrs.adf);
        if (kept) return `the kept ${node.type}: ${kept}`;
      }
      const media = node.type === 'attachmentRef' ? node.attrs.adfMedia : undefined;
      if (media !== undefined && media !== null) {
        const kept = adfShapeProblem(media);
        if (kept) return `the kept media of an attachment reference: ${kept}`;
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
