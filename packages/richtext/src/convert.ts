import type { Node as PmNode } from '@tiptap/pm/model';
import {
  type AdfMark,
  type AdfNode,
  adfShapeProblem,
  isAttachmentDigest,
  isAttachmentName,
  isExpandTitle,
  isSafeColor,
  MAX_COLUMNS,
  TICKET_KEY,
} from './adf';
import { schema } from './schema';

/** ProseMirror's JSON form, which the schema can parse. */
export interface PmJson {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmJson[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

type Attrs = Record<string, unknown>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** How a file of the ticket reads in the other format: a media node of this collection. */
const ATTACHMENT_COLLECTION = 'taskmoor-attachments';
/** How a ticket reference reads there: a card with the ticket's address (`/browse/` resolves). */
const TICKET_ADDRESS = /^\/browse\/([^/?#]+)$/;

/** The layout a section holds, when it is one the editor can edit; else it is kept whole. */
function columnsOf(node: AdfNode): AdfNode[] | null {
  const columns = node.content ?? [];
  if (columns.length === 0 || columns.length > MAX_COLUMNS) return null;
  const fits = columns.every(
    (c) =>
      c.type === 'layoutColumn' &&
      (c.content ?? []).length > 0 &&
      (c.attrs?.width === undefined || typeof c.attrs.width === 'number'),
  );
  return fits ? columns : null;
}

/**
 * The media node a file of the ticket is written as, when it holds nothing else: its name as the
 * id and, when the reference says which of two files of one name, its `digest` (TT-4).
 */
const fileMedia = (id: unknown, digest: unknown): AdfNode => ({
  type: 'media',
  attrs: {
    type: 'file',
    id,
    collection: ATTACHMENT_COLLECTION,
    ...(isAttachmentDigest(digest) ? { digest } : {}),
  },
});

/**
 * The file a media wrapper names, when it is a file of the ticket; else it is kept whole. A
 * media node with more than the file (a size, alt text, marks) is kept too, for the export. A
 * `digest` that is not one (hexadecimal digits) is one of those other attributes.
 */
function attachmentOf(
  node: AdfNode,
): { name: string; digest: string | null; media: AdfNode | null } | null {
  const [only, ...rest] = node.content ?? [];
  if (!only || rest.length > 0 || only.type !== 'media') return null;
  const { type, id, collection, digest, ...more } = only.attrs ?? {};
  if (collection !== ATTACHMENT_COLLECTION || !isAttachmentName(id)) return null;
  const known = isAttachmentDigest(digest) ? digest : null;
  const plain =
    type === 'file' &&
    Object.keys(more).length === 0 &&
    (digest === undefined || known !== null) &&
    Object.keys(only).every((key) => key === 'type' || key === 'attrs');
  return { name: id, digest: known, media: plain ? null : clone(only) };
}

// ---------------------------------------------------------------------------------------------
// Import

/** Builds a document from the Jira-compatible format. Unknown nodes and marks are kept whole. */
export function fromAdf(doc: AdfNode): PmNode {
  const problem = adfShapeProblem(doc);
  if (problem) throw new Error(`Not a document in the format: ${problem}`);
  if (doc.type !== 'doc') throw new Error(`Expected a doc node, got "${doc.type}"`);
  return schema.nodeFromJSON({ type: 'doc', content: blocks(doc.content) });
}

export function fromAdfJson(doc: AdfNode): PmJson {
  return fromAdf(doc).toJSON() as PmJson;
}

function blocks(nodes: AdfNode[] | undefined): PmJson[] {
  return (nodes ?? []).map(block);
}

function inlines(nodes: AdfNode[] | undefined): PmJson[] {
  // The editor cannot hold an empty text node; dropping one changes nothing visible.
  return (nodes ?? []).filter((n) => n.type !== 'text' || n.text).map(inline);
}

const withAdf = (node: AdfNode, attrs: Attrs = {}): Attrs => ({
  ...attrs,
  adfAttrs: node.attrs ? clone(node.attrs) : null,
});

function block(node: AdfNode): PmJson {
  const a = node.attrs ?? {};
  switch (node.type) {
    case 'paragraph':
      return { type: 'paragraph', attrs: withAdf(node), content: inlines(node.content) };
    case 'heading':
      return {
        type: 'heading',
        attrs: withAdf(node, { level: Number(a.level ?? 1) }),
        content: inlines(node.content),
      };
    case 'bulletList':
      return { type: 'bulletList', attrs: withAdf(node), content: blocks(node.content) };
    case 'orderedList':
      return {
        type: 'orderedList',
        attrs: withAdf(node, { start: Number(a.order ?? 1) }),
        content: blocks(node.content),
      };
    case 'listItem':
      return { type: 'listItem', attrs: withAdf(node), content: blocks(node.content) };
    case 'codeBlock':
      return {
        type: 'codeBlock',
        attrs: withAdf(node, { language: a.language ?? null }),
        content: (node.content ?? []).map((t) => ({ type: 'text', text: t.text ?? '' })),
      };
    case 'blockquote':
      return { type: 'blockquote', attrs: withAdf(node), content: blocks(node.content) };
    case 'rule':
      return { type: 'horizontalRule', attrs: withAdf(node) };
    case 'panel':
      return {
        type: 'panel',
        attrs: withAdf(node, { panelType: a.panelType ?? 'info' }),
        content: blocks(node.content),
      };
    case 'expand':
      // Without blocks, or with a title that is no line of text, it stays as it came.
      if ((node.content ?? []).length === 0 || (a.title !== undefined && !isExpandTitle(a.title))) {
        return { type: 'unknownBlock', attrs: { adf: clone(node) } };
      }
      return {
        type: 'expand',
        attrs: withAdf(node, { title: a.title ?? '' }),
        content: blocks(node.content),
      };
    case 'layoutSection': {
      const columns = columnsOf(node);
      if (!columns) return { type: 'unknownBlock', attrs: { adf: clone(node) } };
      return {
        type: 'columnLayout',
        attrs: withAdf(node),
        content: columns.map((column) => ({
          type: 'column',
          attrs: withAdf(column, { width: column.attrs?.width ?? null }),
          content: blocks(column.content),
        })),
      };
    }
    case 'mediaSingle':
    case 'mediaGroup': {
      const file = attachmentOf(node);
      if (file === null) return { type: 'unknownBlock', attrs: { adf: clone(node) } };
      return {
        type: 'attachmentRef',
        attrs: withAdf(node, {
          name: file.name,
          image: node.type === 'mediaSingle',
          digest: file.digest,
          adfMedia: file.media,
        }),
      };
    }
    case 'table':
      return { type: 'table', attrs: withAdf(node), content: blocks(node.content) };
    case 'tableRow':
      return { type: 'tableRow', attrs: withAdf(node), content: blocks(node.content) };
    case 'tableHeader':
    case 'tableCell':
      return {
        type: node.type,
        attrs: withAdf(node, {
          colspan: Number(a.colspan ?? 1),
          rowspan: Number(a.rowspan ?? 1),
          colwidth: Array.isArray(a.colwidth) ? clone(a.colwidth) : null,
        }),
        content: blocks(node.content),
      };
    case 'taskList':
      return { type: 'taskList', attrs: withAdf(node), content: blocks(node.content) };
    case 'taskItem':
      // The format puts inline content straight into the item; the editor wants a paragraph.
      return {
        type: 'taskItem',
        attrs: withAdf(node, { checked: a.state === 'DONE' }),
        content: [{ type: 'paragraph', content: inlines(node.content) }],
      };
    default:
      return { type: 'unknownBlock', attrs: { adf: clone(node) } };
  }
}

function inline(node: AdfNode): PmJson {
  const a = node.attrs ?? {};
  switch (node.type) {
    case 'text': {
      const out: PmJson = { type: 'text', text: node.text ?? '' };
      if (node.marks && node.marks.length > 0) out.marks = node.marks.map(mark);
      return out;
    }
    case 'hardBreak':
      return { type: 'hardBreak', attrs: withAdf(node) };
    case 'mention':
      // The format's text carries the leading "@"; the editor adds its own when it renders.
      return {
        type: 'mention',
        attrs: withAdf(node, {
          id: a.id ?? null,
          label: typeof a.text === 'string' ? a.text.replace(/^@/, '') : null,
        }),
      };
    case 'emoji':
      return {
        type: 'emoji',
        attrs: withAdf(node, { shortName: a.shortName ?? '', text: a.text ?? null }),
      };
    case 'date':
      return { type: 'date', attrs: withAdf(node, { timestamp: String(a.timestamp ?? '') }) };
    case 'status':
      return {
        type: 'status',
        attrs: withAdf(node, { text: a.text ?? '', color: a.color ?? 'neutral' }),
      };
    case 'inlineCard': {
      const key = typeof a.url === 'string' ? TICKET_ADDRESS.exec(a.url)?.[1] : undefined;
      if (key && TICKET_KEY.test(key)) {
        return { type: 'ticketRef', attrs: withAdf(node, { key }) };
      }
      return { type: 'unknownInline', attrs: { adf: clone(node) } };
    }
    default:
      return { type: 'unknownInline', attrs: { adf: clone(node) } };
  }
}

function mark(m: AdfMark): { type: string; attrs?: Attrs } {
  const a = m.attrs ?? {};
  switch (m.type) {
    case 'strong':
      return { type: 'bold' };
    case 'em':
      return { type: 'italic' };
    case 'strike':
      return { type: 'strike' };
    case 'underline':
      return { type: 'underline' };
    case 'code':
      return { type: 'code' };
    case 'link':
      return {
        type: 'link',
        attrs: { href: a.href ?? '', target: null, rel: null, class: null, adfAttrs: clone(a) },
      };
    case 'textColor':
      // Only a colour that is safe to show (T-318); another is kept aside for the export.
      if (!isSafeColor(a.color)) return unknownMark(m);
      return { type: 'textColor', attrs: { color: a.color, adfAttrs: clone(a) } };
    case 'subsup':
      return { type: 'subsup', attrs: { type: a.type ?? 'sub', adfAttrs: clone(a) } };
    default:
      return unknownMark(m);
  }
}

/** A mark the editor does not show, kept whole so an export writes it back as it came. */
function unknownMark(m: AdfMark): { type: string; attrs: Attrs } {
  return { type: 'unknownMark', attrs: { type: m.type, attrs: m.attrs ? clone(m.attrs) : null } };
}

// ---------------------------------------------------------------------------------------------
// Export

/** Writes a document in the Jira-compatible format. */
export function toAdf(doc: PmNode): AdfNode {
  return toAdfFromJson(doc.toJSON() as PmJson);
}

export function toAdfFromJson(doc: PmJson): AdfNode {
  if (doc.type !== 'doc') throw new Error(`Expected a doc node, got "${doc.type}"`);
  return { version: 1, type: 'doc', content: (doc.content ?? []).map(exportNode) };
}

/**
 * Original attributes first, then the editor's values for the keys it owns. A key the editor
 * owns is written when the original had it or when the value is not the format's default.
 */
function attrsOut(
  attrs: Attrs | undefined,
  owned: Record<string, { value: unknown; isDefault?: boolean }> = {},
): Attrs | undefined {
  const original = (attrs?.adfAttrs as Attrs | null | undefined) ?? {};
  const out: Attrs = { ...clone(original) };
  for (const [key, { value, isDefault }] of Object.entries(owned)) {
    if (key in original || !isDefault) out[key] = clone(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function node(type: string, attrs: Attrs | undefined, content?: AdfNode[]): AdfNode {
  const out: AdfNode = { type };
  if (attrs) out.attrs = attrs;
  if (content) out.content = content;
  return out;
}

function exportNode(n: PmJson): AdfNode {
  const a = n.attrs ?? {};
  const children = () => (n.content ?? []).map(exportNode);
  switch (n.type) {
    case 'paragraph':
      return node('paragraph', attrsOut(a), children());
    case 'heading':
      return node('heading', attrsOut(a, { level: { value: a.level } }), children());
    case 'bulletList':
      return node('bulletList', attrsOut(a), children());
    case 'orderedList':
      return node(
        'orderedList',
        attrsOut(a, { order: { value: a.start, isDefault: a.start === 1 } }),
        children(),
      );
    case 'listItem':
      return node('listItem', attrsOut(a), children());
    case 'codeBlock': {
      const text = (n.content ?? []).map((t) => t.text ?? '').join('');
      return node(
        'codeBlock',
        attrsOut(a, { language: { value: a.language, isDefault: a.language == null } }),
        text ? [{ type: 'text', text }] : [],
      );
    }
    case 'blockquote':
      return node('blockquote', attrsOut(a), children());
    case 'horizontalRule':
      return node('rule', attrsOut(a));
    case 'hardBreak':
      return node('hardBreak', attrsOut(a));
    case 'panel':
      return node('panel', attrsOut(a, { panelType: { value: a.panelType } }), children());
    case 'expand':
      return node(
        'expand',
        attrsOut(a, { title: { value: a.title, isDefault: (a.title ?? '') === '' } }),
        children(),
      );
    case 'columnLayout':
      return node('layoutSection', attrsOut(a), children());
    case 'column':
      return node(
        'layoutColumn',
        attrsOut(a, { width: { value: a.width, isDefault: a.width == null } }),
        children(),
      );
    case 'attachmentRef': {
      // The kept media node comes back whole; the file it names is the editor's.
      const kept = a.adfMedia as AdfNode | null | undefined;
      const media: AdfNode = kept
        ? {
            ...clone(kept),
            type: 'media',
            attrs: {
              ...clone(kept.attrs ?? {}),
              id: a.name,
              collection: ATTACHMENT_COLLECTION,
              ...(isAttachmentDigest(a.digest) ? { digest: a.digest } : {}),
            },
          }
        : fileMedia(a.name, a.digest);
      return node(a.image ? 'mediaSingle' : 'mediaGroup', attrsOut(a), [media]);
    }
    case 'ticketRef':
      return node('inlineCard', attrsOut(a, { url: { value: `/browse/${String(a.key)}` } }));
    case 'table':
      return node('table', attrsOut(a), children());
    case 'tableRow':
      return node('tableRow', attrsOut(a), children());
    case 'tableHeader':
    case 'tableCell':
      return node(
        n.type,
        attrsOut(a, {
          colspan: { value: a.colspan, isDefault: a.colspan === 1 },
          rowspan: { value: a.rowspan, isDefault: a.rowspan === 1 },
          colwidth: { value: a.colwidth, isDefault: a.colwidth == null },
        }),
        children(),
      );
    case 'taskList':
      return node('taskList', attrsOut(a), children());
    case 'taskItem': {
      // Paragraphs inside the item flatten back to inline content, separated by hard breaks.
      const content: AdfNode[] = [];
      for (const [i, child] of (n.content ?? []).entries()) {
        if (i > 0) content.push({ type: 'hardBreak' });
        if (child.type === 'paragraph') content.push(...(child.content ?? []).map(exportNode));
        else content.push(exportNode(child));
      }
      return node(
        'taskItem',
        attrsOut(a, { state: { value: a.checked ? 'DONE' : 'TODO' } }),
        content,
      );
    }
    case 'text': {
      const out: AdfNode = { type: 'text', text: n.text ?? '' };
      if (n.marks && n.marks.length > 0) out.marks = n.marks.map(exportMark);
      return out;
    }
    case 'mention': {
      // "@" and the label, unless the original text had no "@" (then it is kept as it was).
      const original = (a.adfAttrs as Attrs | null | undefined)?.text;
      const bare = typeof original === 'string' && !original.startsWith('@');
      const text = a.label == null ? null : bare ? a.label : `@${String(a.label)}`;
      return node(
        'mention',
        attrsOut(a, { id: { value: a.id }, text: { value: text, isDefault: text == null } }),
      );
    }
    case 'emoji':
      return node(
        'emoji',
        attrsOut(a, {
          shortName: { value: a.shortName },
          text: { value: a.text, isDefault: a.text == null },
        }),
      );
    case 'date':
      return node('date', attrsOut(a, { timestamp: { value: a.timestamp } }));
    case 'status':
      return node('status', attrsOut(a, { text: { value: a.text }, color: { value: a.color } }));
    case 'unknownBlock':
    case 'unknownInline':
      return clone(a.adf as AdfNode);
    default:
      throw new Error(`Cannot export node type "${n.type}"`);
  }
}

function exportMark(m: { type: string; attrs?: Attrs }): AdfMark {
  const a = m.attrs ?? {};
  const withAttrs = (
    type: string,
    owned: Record<string, { value: unknown; isDefault?: boolean }>,
  ) => {
    const attrs = attrsOut(a, owned);
    return attrs ? { type, attrs } : { type };
  };
  switch (m.type) {
    case 'bold':
      return { type: 'strong' };
    case 'italic':
      return { type: 'em' };
    case 'strike':
      return { type: 'strike' };
    case 'underline':
      return { type: 'underline' };
    case 'code':
      return { type: 'code' };
    case 'link':
      return withAttrs('link', { href: { value: a.href } });
    case 'textColor':
      return withAttrs('textColor', { color: { value: a.color } });
    case 'subsup':
      return withAttrs('subsup', { type: { value: a.type } });
    case 'unknownMark': {
      const attrs = a.attrs as Attrs | null | undefined;
      return attrs ? { type: String(a.type), attrs: clone(attrs) } : { type: String(a.type) };
    }
    default:
      throw new Error(`Cannot export mark type "${m.type}"`);
  }
}
