import type { Node as PmNode } from '@tiptap/pm/model';
import type { AdfMark, AdfNode } from './adf';
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

// ---------------------------------------------------------------------------------------------
// Import

/** Builds a document from the Jira-compatible format. Unknown nodes and marks are kept whole. */
export function fromAdf(doc: AdfNode): PmNode {
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
      return { type: 'textColor', attrs: { color: a.color ?? null, adfAttrs: clone(a) } };
    case 'subsup':
      return { type: 'subsup', attrs: { type: a.type ?? 'sub', adfAttrs: clone(a) } };
    default:
      return {
        type: 'unknownMark',
        attrs: { type: m.type, attrs: m.attrs ? clone(m.attrs) : null },
      };
  }
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
