import type {
  BlockContent,
  Definition,
  DefinitionContent,
  Html,
  List,
  ListItem,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from 'mdast';
import { fromMarkdown as parseMarkdown } from 'mdast-util-from-markdown';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown, gfmTableToMarkdown } from 'mdast-util-gfm-table';
import {
  gfmTaskListItemFromMarkdown,
  gfmTaskListItemToMarkdown,
} from 'mdast-util-gfm-task-list-item';
import { defaultHandlers, type Handle, toMarkdown as writeMarkdown } from 'mdast-util-to-markdown';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import { type AdfNode, isAttachmentName, layoutSpan, MAX_TITLE_LENGTH, TICKET_KEY } from './adf';
import { fromAdfJson, type PmJson } from './convert';
import { schema } from './schema';

/**
 * Markdown import and export (M1-017, NTF-006, NTF-007, API-011): CommonMark with the GFM
 * tables, strikethrough, task lists and literal autolinks, plus a few conventions so that what
 * the editor makes comes back unchanged:
 *
 * - mentions are links with the `mention:` scheme: `[@Kalo](mention:42)`;
 * - panels are alert quotes, `> [!INFO]` (GitHub's NOTE, TIP and WARNING are panel types too;
 *   IMPORTANT reads as info and CAUTION as error);
 * - a collapsible section is a quote that starts `> [!EXPAND] Its title`;
 * - a file of the ticket is a paragraph of one link or image with the `attachment:` scheme, a
 *   ticket reference a link with the `ticket:` scheme: `[PAY-42](ticket:PAY-42)`;
 * - underline, subscript, superscript and text colour are the inline HTML tags `<ins>`,
 *   `<sub>`, `<sup>` and `<span style="color: #36b37e">`; `<u>` reads as underline and `<br>`
 *   as a line break. No other HTML is interpreted: it stays as the text it is.
 *
 * Documented losses, everything else round-trips (`markdown.test.ts` holds the corpus):
 * - attributes Markdown has no place for (the original document format's own attributes,
 *   link targets, table column widths and alignment) are not written;
 * - empty paragraphs are dropped;
 * - mentions take no marks (`**[@Ana](mention:9)**` reads as a plain mention);
 * - emoji, dates and status lozenges are written as their text (`🙂`, `2026-03-04`, `[OPEN]`)
 *   and read back as text;
 * - a table whose first row is not all header cells gets an empty header row; merged cells
 *   are written once with empty cells after them; cells with several paragraphs join them with
 *   `<br>` and cells with other blocks keep only their text;
 * - an ordered task list reads as a task list; a list where only some items have a checkbox
 *   reads as a plain list with `[ ]` or `[x]` as text;
 * - columns are written as their blocks, one column after the other, and read back as that;
 * - a collapsible section's title that holds a web address ends where the address starts: the
 *   address reads as the section's first paragraph;
 * - nodes and marks the editor keeps whole for the other format (`unknownBlock`,
 *   `unknownInline`, `unknownMark`) are written as the readable content they hold;
 * - a line break at the end of a paragraph is dropped, and a line feed inside one reads as a
 *   space;
 * - inline code carries no other mark in the editor: inside a link it reads as linked text,
 *   elsewhere other marks on it drop;
 * - web and email addresses in text read back as links (GFM autolinks);
 * - images read as links, reference links as inline links, and HTML blocks as code blocks of
 *   their source (inline HTML other than the tags above stays text).
 */

type Attrs = Record<string, unknown>;
interface MarkJson {
  type: string;
  attrs?: Attrs;
}

/**
 * A link whose address holds a backslash is written `[text](address)`, not `<address>`: the
 * writer escapes the backslash, but `<...>` reads no escapes, so each save would double it.
 */
const writeLinkBody: Handle = (node, parent, state, info) => {
  if (!node.url.includes('\\')) return defaultHandlers.link(node, parent, state, info);
  const before = state.options.resourceLink;
  state.options.resourceLink = true;
  try {
    return defaultHandlers.link(node, parent, state, info);
  } finally {
    state.options.resourceLink = before;
  }
};
const writeLink = Object.assign(writeLinkBody, { peek: defaultHandlers.link.peek });

// No autolink-literal writer: GFM finds web and email addresses in text after escapes are
// read, so escaping them cannot keep them text. They are written as links instead.
const TO_MARKDOWN = [
  gfmTableToMarkdown(),
  gfmStrikethroughToMarkdown(),
  gfmTaskListItemToMarkdown(),
  { handlers: { link: writeLink } },
];
const FROM_MARKDOWN = [
  gfmTableFromMarkdown(),
  gfmStrikethroughFromMarkdown(),
  gfmTaskListItemFromMarkdown(),
  gfmAutolinkLiteralFromMarkdown(),
];
const SYNTAX = [gfmTable(), gfmStrikethrough(), gfmTaskListItem(), gfmAutolinkLiteral()];

const MENTION_SCHEME = 'mention:';
const TICKET_SCHEME = 'ticket:';
const ATTACHMENT_SCHEME = 'attachment:';

/** Inline node types of the other format, known or not, for reading unknown blocks. */
const ADF_INLINE = new Set([
  'text',
  'hardBreak',
  'mention',
  'emoji',
  'date',
  'status',
  'inlineCard',
  'inlineExtension',
  'placeholder',
  'mediaInline',
]);

/** Panel types written as alert quotes, and the alert names read back (spec: ADF panel types). */
const PANEL_TYPES = ['info', 'note', 'tip', 'warning', 'error', 'success', 'custom'];
const ALERT_ALIASES: Record<string, string> = { important: 'info', caution: 'error' };

/** The text with each lone surrogate replaced by U+FFFD, so it can be URI-encoded. */
export const wellFormed = (text: string): string =>
  text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');

/** Only colours we can write back safely: hex values or plain colour names. */
export const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;

/**
 * Link targets a document may hold; anything else (javascript:, data:, ...) keeps only its text.
 * The scheme is read as a browser reads it (the WHATWG URL parser): tabs and line breaks
 * anywhere are dropped and so are control characters and spaces in front, so `java\tscript:`
 * and `\u0001javascript:` are `javascript:` (M1-118; `pnpm fuzz href` checks this against the
 * URL parser). Other leading white space is dropped too, which can only refuse more.
 */
export function isSafeHref(href: string): boolean {
  const noBreaks = href.replace(/[\t\n\r]/g, '');
  let start = 0;
  while (
    start < noBreaks.length &&
    (noBreaks.charCodeAt(start) <= 0x20 || /\s/u.test(noBreaks[start] as string))
  ) {
    start++;
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(noBreaks.slice(start))?.[1]?.toLowerCase();
  return scheme === undefined || ['http', 'https', 'mailto', 'tel'].includes(scheme);
}

// ---------------------------------------------------------------------------------------------
// Export

/** Writes a document (ProseMirror JSON on the shared schema) as Markdown. */
export function toMarkdown(doc: PmJson): string {
  if (doc.type !== 'doc') throw new Error(`Expected a doc node, got "${doc.type}"`);
  const root: Root = { type: 'root', children: blocksOut(doc.content ?? []) };
  // Web and email addresses in text are written as links, the way GFM reads them back; left
  // as text, the reader could take what follows them (a line break's backslash) into the link.
  for (const transform of gfmAutolinkLiteralFromMarkdown().transforms ?? []) transform(root);
  const text = writeMarkdown(root, {
    bullet: '-',
    // `_` for emphasis and `**` for strong keep runs of the two apart (`_a**b**_**c**`).
    emphasis: '_',
    listItemIndent: 'one',
    fences: true,
    join: [listAfterParagraph],
    extensions: TO_MARKDOWN,
  });
  // The writer sometimes encodes "the character before" an emphasis marker at the very start
  // of a line, where there is none; that reference stands for nothing.
  const out = joinSurrogates(text).replaceAll('&#xNAN;', '');
  return out.endsWith('\n') ? out : `${out}\n`;
}

/**
 * The writer encodes the character next to an emphasis marker as a character reference when
 * that keeps the marker working, but encodes half of a character outside the basic plane (an
 * emoji) on its own, which reads back as U+FFFD. This puts both halves in one reference.
 */
function joinSurrogates(text: string): string {
  const half = (reference: string | undefined, raw: string | undefined) =>
    reference === undefined ? (raw as string).charCodeAt(0) : Number.parseInt(reference, 16);
  return text.replace(
    /(?:&#x(D[89AB][0-9A-F]{2});|([\uD800-\uDBFF]))(?:&#x(D[C-F][0-9A-F]{2});|([\uDC00-\uDFFF]))/g,
    (whole, highRef?: string, high?: string, lowRef?: string, low?: string) => {
      if (highRef === undefined && lowRef === undefined) return whole;
      const point = (half(highRef, high) - 0xd800) * 0x400 + (half(lowRef, low) - 0xdc00) + 0x10000;
      return `&#x${point.toString(16).toUpperCase()};`;
    },
  );
}

/**
 * Only a list that starts at 1 with a non-empty item may interrupt a paragraph; any other
 * needs a blank line before it, or Markdown reads it as more of the paragraph.
 */
function listAfterParagraph(left: { type: string }, right: RootContent): number | undefined {
  if (left.type !== 'paragraph' || right.type !== 'list') return undefined;
  const first = right.children[0];
  const empty = !first || first.children.length === 0;
  return empty || (right.ordered && (right.start ?? 1) !== 1) ? 1 : undefined;
}

function blocksOut(nodes: readonly PmJson[]): RootContent[] {
  return nodes.flatMap(blockOut);
}

function blockOut(n: PmJson): RootContent[] {
  const a = n.attrs ?? {};
  const content = n.content ?? [];
  switch (n.type) {
    case 'paragraph': {
      const children = inlinesOut(content);
      return children.length === 0 ? [] : [{ type: 'paragraph', children }];
    }
    case 'heading':
      return [
        {
          type: 'heading',
          depth: Math.min(6, Math.max(1, Number(a.level ?? 1))) as 1 | 2 | 3 | 4 | 5 | 6,
          children: inlinesOut(content),
        },
      ];
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const list: List = {
        type: 'list',
        ordered: n.type === 'orderedList',
        spread: false,
        children: content.map((item) => listItemOut(item, n.type === 'taskList')),
      };
      if (n.type === 'orderedList') list.start = Number(a.start ?? 1);
      return [list];
    }
    case 'codeBlock': {
      const language = typeof a.language === 'string' ? a.language : null;
      return [
        {
          type: 'code',
          lang: language && /^[^\s`~]+$/.test(language) ? language : null,
          value: content.map((t) => t.text ?? '').join(''),
        },
      ];
    }
    case 'blockquote':
      return [{ type: 'blockquote', children: flowOut(content) }];
    case 'horizontalRule':
      return [{ type: 'thematicBreak' }];
    case 'panel': {
      const panelType = String(a.panelType ?? 'info');
      const marker: Html = { type: 'html', value: `[!${panelType.toUpperCase()}]` };
      return [
        {
          type: 'blockquote',
          children: [{ type: 'paragraph', children: [marker] }, ...flowOut(content)],
        },
      ];
    }
    case 'expand': {
      const marker: Html = { type: 'html', value: '[!EXPAND]' };
      const title = String(a.title ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      return [
        {
          type: 'blockquote',
          children: [
            {
              type: 'paragraph',
              children: title === '' ? [marker] : [marker, { type: 'text', value: ` ${title}` }],
            },
            ...flowOut(content),
          ],
        },
      ];
    }
    case 'columnLayout':
      return content.flatMap((column) => blocksOut(column.content ?? []));
    case 'attachmentRef': {
      const name = String(a.name ?? '');
      const url = `${ATTACHMENT_SCHEME}${encodeURIComponent(wellFormed(name))}`;
      return [
        {
          type: 'paragraph',
          children: [
            a.image
              ? { type: 'image', url, alt: name, title: null }
              : { type: 'link', url, title: null, children: [{ type: 'text', value: name }] },
          ],
        },
      ];
    }
    case 'table':
      return [tableOut(n)];
    case 'unknownBlock':
      return blocksOut(readableBlocks(a.adf as AdfNode | null));
    default:
      // Inline content where a block belongs cannot come from the schema; be lenient anyway.
      return [];
  }
}

/** Blocks that may sit in a quote or a list item (everything `blockOut` makes). */
function flowOut(nodes: readonly PmJson[]): (BlockContent | DefinitionContent)[] {
  return blocksOut(nodes) as (BlockContent | DefinitionContent)[];
}

function listItemOut(item: PmJson, task: boolean): ListItem {
  const out: ListItem = { type: 'listItem', spread: false, children: flowOut(item.content ?? []) };
  if (task) {
    out.checked = Boolean(item.attrs?.checked);
    // A checkbox needs text after it on its line: an empty task item gets a no-break space,
    // which reads back as nothing.
    if (out.children[0]?.type !== 'paragraph') {
      out.children.unshift({ type: 'paragraph', children: [{ type: 'text', value: NBSP }] });
    }
  }
  return out;
}

const NBSP = '\u00a0';

/**
 * A GFM table: one header row, then body rows, every cell one line of inline content. Tables
 * that need more are written as close as GFM allows (see the module comment).
 */
function tableOut(table: PmJson): Table {
  const rows = (table.content ?? []).map((row) => {
    const cells: PmJson[] = [];
    for (const cell of row.content ?? []) {
      cells.push(cell);
      // A merged cell is written once; the columns it covers get empty cells.
      const span = layoutSpan(cell.attrs?.colspan);
      for (let i = 1; i < span; i++) cells.push({ type: cell.type });
    }
    return cells;
  });
  const width = Math.max(1, ...rows.map((r) => r.length));
  const first = rows[0];
  const headed = first?.every((c) => c.type === 'tableHeader') === true;
  const bodyRows = headed ? rows.slice(1) : rows;
  const header: TableRow = {
    type: 'tableRow',
    children: Array.from({ length: width }, (_, i) =>
      headed && first?.[i] ? cellOut(first[i]) : { type: 'tableCell', children: [] },
    ),
  };
  return {
    type: 'table',
    align: Array.from({ length: width }, () => null),
    children: [
      header,
      ...bodyRows.map(
        (cells): TableRow => ({
          type: 'tableRow',
          children: Array.from({ length: width }, (_, i) => {
            const cell = cells[i];
            return cell ? cellOut(cell) : { type: 'tableCell', children: [] };
          }),
        }),
      ),
    ],
  };
}

function cellOut(cell: PmJson): TableCell {
  const children: PhrasingContent[] = [];
  for (const block of cell.content ?? []) {
    const text = textOf(block);
    const inline: PhrasingContent[] =
      block.type === 'paragraph' || block.type === 'heading'
        ? inlinesOut(block.content ?? [])
        : text
          ? [{ type: 'text', value: text }]
          : [];
    if (inline.length === 0) continue;
    if (children.length > 0) children.push({ type: 'html', value: '<br>' });
    children.push(...inline);
  }
  return { type: 'tableCell', children: children.map(breakInCell) };
}

/** GFM cells hold one line: a line break inside one is written as `<br>`. */
function breakInCell(node: PhrasingContent): PhrasingContent {
  if (node.type === 'break') return { type: 'html', value: '<br>' };
  if ('children' in node && Array.isArray(node.children)) {
    return { ...node, children: node.children.map(breakInCell) } as PhrasingContent;
  }
  return node;
}

/** The plain text of a node and its descendants. */
function textOf(n: PmJson): string {
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return ' ';
  return (n.content ?? []).map(textOf).join('');
}

/**
 * What an unknown block holds that a reader can use: its children when they are blocks or
 * inline content the editor knows, else a link to the URL it names, else nothing.
 */
export function readableBlocks(adf: AdfNode | null | undefined): PmJson[] {
  if (!adf) return [];
  const children = adf.content ?? [];
  if (children.length > 0) {
    // Inline children (a decision item's text, say) read as one paragraph.
    const inline = children.some((c) => ADF_INLINE.has(c.type));
    try {
      return (
        fromAdfJson({
          type: 'doc',
          content: inline ? [{ type: 'paragraph', content: children }] : children,
        }).content ?? []
      );
    } catch {
      return [];
    }
  }
  const url = adf.attrs?.url;
  if (typeof url === 'string' && url !== '') {
    return [{ type: 'paragraph', content: [linkText(url, url)] }];
  }
  return [];
}

function linkText(text: string, href: string): PmJson {
  return {
    type: 'text',
    text,
    marks: [{ type: 'link', attrs: { href, target: null, rel: null, class: null } }],
  };
}

// Marks, outermost first. Code is not here: it turns its text into inline code.
const MARK_ORDER = ['link', 'textColor', 'underline', 'subsup', 'bold', 'italic', 'strike'];

const markKey = (m: MarkJson) =>
  m.type === 'link'
    ? `link:${String(m.attrs?.href ?? '')}:${String(linkTitle(m) ?? '')}`
    : `${m.type}:${JSON.stringify(m.attrs ?? null)}`;

function linkTitle(m: MarkJson): string | null {
  const adf = m.attrs?.adfAttrs as Attrs | null | undefined;
  return typeof adf?.title === 'string' ? adf.title : null;
}

/** Marks Markdown can write, in nesting order; others (unknown ones, unsafe links) drop. */
function writableMarks(marks: readonly MarkJson[] | undefined, isMention: boolean): MarkJson[] {
  return (marks ?? [])
    .filter((m) => MARK_ORDER.includes(m.type))
    .filter((m) => m.type !== 'link' || (!isMention && isSafeHref(String(m.attrs?.href ?? ''))))
    .filter((m) => m.type !== 'textColor' || SAFE_COLOR.test(String(m.attrs?.color ?? '')))
    .sort((x, y) => MARK_ORDER.indexOf(x.type) - MARK_ORDER.indexOf(y.type));
}

interface Frame {
  mark: MarkJson | null;
  children: PhrasingContent[];
}

/** Inline nodes with flat marks as nested Markdown phrasing content. */
function inlinesOut(nodes: readonly PmJson[]): PhrasingContent[] {
  const root: Frame = { mark: null, children: [] };
  const stack: Frame[] = [root];
  const close = () => {
    const frame = stack.pop() as Frame;
    const parent = stack[stack.length - 1] as Frame;
    parent.children.push(...wrap(frame.mark as MarkJson, frame.children));
  };
  const items = nodes
    .map((n) => ({ n, leaves: leafOut(n), marks: writableMarks(n.marks, n.type === 'mention') }))
    .filter((i) => i.leaves.length > 0);
  // A line break at the end of a block cannot be written: Markdown would read a backslash.
  while (items.length > 0 && items[items.length - 1]?.n.type === 'hardBreak') items.pop();
  const keys = items.map((i) => new Set(i.marks.map(markKey)));
  /** How many nodes from `from` on carry the mark. */
  const reach = (key: string, from: number) => {
    let to = from;
    while (keys[to]?.has(key)) to++;
    return to - from;
  };
  for (const [index, { leaves, marks }] of items.entries()) {
    const wanted = keys[index] as Set<string>;
    // Marks already open stay open as far down the stack as they all continue.
    let keep = 1;
    while (keep < stack.length && wanted.has(markKey(stack[keep]?.mark as MarkJson))) keep++;
    while (stack.length > keep) close();
    const open = new Set(stack.slice(1).map((f) => markKey(f.mark as MarkJson)));
    // New marks open outermost first by how far they reach, so a long one is not closed and
    // reopened around a short one (`*a **b** c*`, never `*a* ***b*** *c*`).
    const fresh = marks
      .filter((m) => !open.has(markKey(m)))
      .sort((x, y) => reach(markKey(y), index) - reach(markKey(x), index));
    for (const mark of fresh) stack.push({ mark, children: [] });
    (stack[stack.length - 1] as Frame).children.push(...leaves);
  }
  while (stack.length > 1) close();
  return flankDeletes(root.children);
}

/** The first or last character a phrasing node writes, as far as flanking rules care. */
function edge(node: PhrasingContent | undefined, side: 'start' | 'end'): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case 'text': {
      const chars = Array.from(node.value);
      return side === 'start' ? chars[0] : chars[chars.length - 1];
    }
    case 'strong':
    case 'emphasis':
      return '*';
    case 'delete':
      return '~';
    case 'inlineCode':
      return '`';
    case 'link':
      return side === 'start' ? '[' : ')';
    case 'html':
      return side === 'start' ? '<' : '>';
    default:
      return undefined;
  }
}

const isWordish = (ch: string | undefined) => ch !== undefined && !/[\s\p{P}\p{S}]/u.test(ch);
const isMarkup = (ch: string | undefined) => ch !== undefined && /[\p{P}\p{S}]/u.test(ch);
const reference = (ch: string): PhrasingContent => ({
  type: 'html',
  value: `&#x${(ch.codePointAt(0) as number).toString(16).toUpperCase()};`,
});

/**
 * `~~` only opens before punctuation when nothing but space or punctuation precedes it, and
 * only closes after punctuation when space or punctuation follows (GFM flanking rules). The
 * strikethrough writer does not see to that, so a letter or digit next to a struck run that
 * starts or ends with markup is written as a character reference, which reads back as itself.
 */
function flankDeletes(nodes: PhrasingContent[]): PhrasingContent[] {
  const out = nodes.map((n) =>
    'children' in n && Array.isArray(n.children)
      ? ({ ...n, children: flankDeletes(n.children as PhrasingContent[]) } as PhrasingContent)
      : n,
  );
  for (let i = 0; i < out.length; i++) {
    const node = out[i] as PhrasingContent;
    if (node.type !== 'delete') continue;
    const after = out[i + 1];
    if (after?.type === 'text' && isMarkup(edge(node.children.at(-1), 'end'))) {
      const [first = '', ...rest] = Array.from(after.value);
      if (isWordish(first)) {
        out.splice(
          i + 1,
          1,
          reference(first),
          ...(rest.length ? [{ ...after, value: rest.join('') }] : []),
        );
      }
    }
    const before = out[i - 1];
    if (before?.type === 'text' && isMarkup(edge(node.children[0], 'start'))) {
      const chars = Array.from(before.value);
      const last = chars.pop();
      if (isWordish(last)) {
        out.splice(
          i - 1,
          1,
          ...(chars.length ? [{ ...before, value: chars.join('') }] : []),
          reference(last as string),
        );
        i += chars.length ? 1 : 0;
      }
    }
  }
  return out;
}

function wrap(mark: MarkJson, children: PhrasingContent[]): PhrasingContent[] {
  const a = mark.attrs ?? {};
  const tag = (open: string, close: string): PhrasingContent[] => [
    { type: 'html', value: open },
    ...children,
    { type: 'html', value: close },
  ];
  switch (mark.type) {
    case 'link':
      return [{ type: 'link', url: String(a.href ?? ''), title: linkTitle(mark), children }];
    case 'bold':
      return [{ type: 'strong', children }];
    case 'italic':
      return [{ type: 'emphasis', children }];
    case 'strike':
      return [{ type: 'delete', children }];
    case 'underline':
      return tag('<ins>', '</ins>');
    case 'subsup':
      return a.type === 'sup' ? tag('<sup>', '</sup>') : tag('<sub>', '</sub>');
    case 'textColor':
      return tag(`<span style="color: ${String(a.color)}">`, '</span>');
    default:
      return children;
  }
}

function leafOut(n: PmJson): PhrasingContent[] {
  const a = n.attrs ?? {};
  switch (n.type) {
    case 'text': {
      const text = n.text ?? '';
      if (text === '') return [];
      return n.marks?.some((m) => m.type === 'code')
        ? [{ type: 'inlineCode', value: text }]
        : [{ type: 'text', value: text }];
    }
    case 'hardBreak':
      return [{ type: 'break' }];
    case 'mention': {
      const id = String(a.id ?? '');
      const label = typeof a.label === 'string' && a.label !== '' ? a.label : id;
      return [
        {
          type: 'link',
          // A lone surrogate cannot be encoded; it becomes U+FFFD (M1-118, `pnpm fuzz wiki`).
          url: `${MENTION_SCHEME}${encodeURIComponent(wellFormed(id))}`,
          title: null,
          children: [{ type: 'text', value: `@${label}` }],
        },
      ];
    }
    case 'ticketRef': {
      const key = String(a.key ?? '');
      return key
        ? [
            {
              type: 'link',
              url: `${TICKET_SCHEME}${encodeURIComponent(wellFormed(key))}`,
              title: null,
              children: [{ type: 'text', value: key }],
            },
          ]
        : [];
    }
    case 'emoji': {
      const text = typeof a.text === 'string' && a.text !== '' ? a.text : String(a.shortName ?? '');
      return text ? [{ type: 'text', value: text }] : [];
    }
    case 'date':
      return [{ type: 'text', value: dayOf(String(a.timestamp ?? '')) }];
    case 'status':
      return a.text ? [{ type: 'text', value: `[${String(a.text)}]` }] : [];
    case 'unknownInline': {
      // Its text, or the address it points to (as text: a link here could merge with one
      // next to it).
      const adf = a.adf as AdfNode | null;
      const text = adf?.text ?? adf?.attrs?.text ?? adf?.attrs?.url;
      return typeof text === 'string' && text !== '' ? [{ type: 'text', value: text }] : [];
    }
    default:
      return [];
  }
}

/** A date node's timestamp (milliseconds) as the day it names, in UTC. */
export function dayOf(timestamp: string): string {
  const ms = Number(timestamp);
  if (timestamp === '' || !Number.isFinite(ms)) return timestamp;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? timestamp : date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Import

/** Reads Markdown into a document on the shared schema. */
export function fromMarkdown(markdown: string): PmJson {
  const tree = parseMarkdown(markdown, { extensions: SYNTAX, mdastExtensions: FROM_MARKDOWN });
  const definitions = new Map<string, Definition>();
  collectDefinitions(tree, definitions);
  const content = blocksIn(tree.children, definitions);
  const json: PmJson = {
    type: 'doc',
    content: content.length > 0 ? content : [{ type: 'paragraph' }],
  };
  const node = schema.nodeFromJSON(json);
  node.check();
  return node.toJSON() as PmJson;
}

function collectDefinitions(node: { children?: unknown[] }, out: Map<string, Definition>) {
  for (const child of (node.children ?? []) as (RootContent & { children?: unknown[] })[]) {
    if (child.type === 'definition' && !out.has(child.identifier)) out.set(child.identifier, child);
    if ('children' in child) collectDefinitions(child, out);
  }
}

type Definitions = ReadonlyMap<string, Definition>;

function blocksIn(nodes: readonly RootContent[], defs: Definitions): PmJson[] {
  return nodes.flatMap((n) => blockIn(n, defs));
}

function blockIn(n: RootContent, defs: Definitions): PmJson[] {
  switch (n.type) {
    case 'paragraph': {
      const attachment = attachmentIn(n.children);
      return [attachment ?? { type: 'paragraph', content: inlinesIn(n.children, [], defs) }];
    }
    case 'heading':
      return [
        { type: 'heading', attrs: { level: n.depth }, content: inlinesIn(n.children, [], defs) },
      ];
    case 'thematicBreak':
      return [{ type: 'horizontalRule' }];
    case 'blockquote':
      return [quoteIn(n.children, defs)];
    case 'list':
      return [listIn(n, defs)];
    case 'code':
      return [
        {
          type: 'codeBlock',
          attrs: { language: n.lang ?? null },
          ...(n.value ? { content: [{ type: 'text', text: n.value }] } : {}),
        },
      ];
    case 'html':
      // Raw HTML is never interpreted: it stays as the source it is, in a code block.
      return n.value.trim() === ''
        ? []
        : [
            {
              type: 'codeBlock',
              attrs: { language: 'html' },
              content: [{ type: 'text', text: n.value }],
            },
          ];
    case 'table':
      return [tableIn(n, defs)];
    default:
      // Definitions were read already; nothing else the parser makes is a block of ours.
      return [];
  }
}

/** A quote, or a panel when its first line is an alert marker such as `[!WARNING]`. */
function quoteIn(children: readonly RootContent[], defs: Definitions): PmJson {
  const [first, ...rest] = children;
  if (first?.type === 'paragraph') {
    const lead = first.children[0];
    const value = lead?.type === 'text' || lead?.type === 'html' ? lead.value : '';
    const expand = /^\[!EXPAND\][ \t]*([^\r\n]*)(?:\r?\n|$)/i.exec(value);
    if (expand) {
      const remaining = value.slice(expand[0].length);
      const leadRest: PhrasingContent[] =
        remaining === '' ? [] : [{ type: 'text', value: remaining }];
      const paragraph = [...leadRest, ...first.children.slice(1)];
      const blocks = [
        ...(paragraph.length > 0
          ? [{ type: 'paragraph', content: inlinesIn(paragraph, [], defs) } as PmJson]
          : []),
        ...blocksIn(rest, defs),
      ];
      return {
        type: 'expand',
        attrs: { title: (expand[1] ?? '').trim().slice(0, MAX_TITLE_LENGTH) },
        content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
      };
    }
    const match = /^\[!([A-Za-z]+)\][ \t]*(?:\r?\n|$)/.exec(value);
    const name = match?.[1]?.toLowerCase() ?? '';
    const panelType = ALERT_ALIASES[name] ?? (PANEL_TYPES.includes(name) ? name : null);
    if (match && panelType) {
      const remaining = value.slice(match[0].length);
      const leadRest: PhrasingContent[] =
        remaining === '' ? [] : [{ type: 'text', value: remaining }];
      const paragraph = [...leadRest, ...first.children.slice(1)];
      const blocks = [
        ...(paragraph.length > 0
          ? [{ type: 'paragraph', content: inlinesIn(paragraph, [], defs) } as PmJson]
          : []),
        ...blocksIn(rest, defs),
      ];
      return {
        type: 'panel',
        attrs: { panelType },
        content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
      };
    }
  }
  const blocks = blocksIn(children, defs);
  return { type: 'blockquote', content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }] };
}

function listIn(list: List, defs: Definitions): PmJson {
  const items = list.children;
  const task = items.length > 0 && items.every((i) => typeof i.checked === 'boolean');
  if (task) {
    return {
      type: 'taskList',
      content: items.map((i) => ({
        type: 'taskItem',
        attrs: { checked: i.checked === true },
        content: itemBlocks(i, defs, null),
      })),
    };
  }
  return {
    type: list.ordered ? 'orderedList' : 'bulletList',
    ...(list.ordered ? { attrs: { start: list.start ?? 1 } } : {}),
    content: items.map((i) => ({
      type: 'listItem',
      // In a list where only some items have a checkbox, the box stays as text.
      content: itemBlocks(i, defs, typeof i.checked === 'boolean' ? i.checked : null),
    })),
  };
}

/** A list item's blocks; the schema wants a paragraph first. */
function itemBlocks(item: ListItem, defs: Definitions, box: boolean | null): PmJson[] {
  const blocks = blocksIn(item.children, defs);
  const lead = blocks[0]?.content;
  if (lead?.length === 1 && lead[0]?.type === 'text' && lead[0].text === NBSP && !lead[0].marks) {
    (blocks[0] as PmJson).content = [];
  }
  if (blocks[0]?.type !== 'paragraph') blocks.unshift({ type: 'paragraph' });
  if (box !== null) {
    const first = blocks[0] as PmJson;
    first.content = [{ type: 'text', text: box ? '[x] ' : '[ ] ' }, ...(first.content ?? [])];
  }
  return blocks;
}

function tableIn(table: Table, defs: Definitions): PmJson {
  return {
    type: 'table',
    content: table.children.map((row, r) => ({
      type: 'tableRow',
      content: row.children.map((cell) => ({
        type: r === 0 ? 'tableHeader' : 'tableCell',
        content: [{ type: 'paragraph', content: inlinesIn(cell.children, [], defs) }],
      })),
    })),
  };
}

/** Inline HTML tags that stand for marks, and the mark each opens. */
function tagMark(value: string): { open: MarkJson } | { close: string } | { br: true } | null {
  const tag = value.trim();
  if (/^<br\s*\/?>$/i.test(tag)) return { br: true };
  const closing = /^<\/(ins|u|sub|sup|span)\s*>$/i.exec(tag);
  if (closing) return { close: (closing[1] as string).toLowerCase() };
  const simple = /^<(ins|u|sub|sup)>$/i.exec(tag);
  if (simple) {
    const name = (simple[1] as string).toLowerCase();
    if (name === 'ins' || name === 'u') return { open: { type: 'underline' } };
    return { open: { type: 'subsup', attrs: { type: name } } };
  }
  const span = /^<span\s+style="\s*color:\s*([^";]+?)\s*;?\s*">$/i.exec(tag);
  if (span && SAFE_COLOR.test(span[1] as string)) {
    return { open: { type: 'textColor', attrs: { color: span[1] } } };
  }
  return null;
}

const TAG_OF: Record<string, string[]> = {
  underline: ['ins', 'u'],
  subsup: ['sub', 'sup'],
  textColor: ['span'],
};

function inlinesIn(
  nodes: readonly PhrasingContent[],
  marks: readonly MarkJson[],
  defs: Definitions,
): PmJson[] {
  const out: PmJson[] = [];
  // Marks opened by inline HTML tags among these siblings, innermost last.
  const open: { mark: MarkJson }[] = [];
  const current = () => open.reduce((all, o) => withMark(all, o.mark), [...marks]);
  const text = (value: string, code = false) => {
    if (value === '') return;
    let all = current();
    // Inline code takes no other mark in the editor: linked code reads as linked text, and
    // code keeps only its code mark elsewhere.
    if (code) all = all.some((m) => m.type === 'link') ? all : [{ type: 'code' }];
    out.push({ type: 'text', text: value, ...(all.length > 0 ? { marks: all } : {}) });
  };
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        // A soft line break inside a paragraph is a space in rich text.
        text(n.value.replace(/[ \t]*\r?\n[ \t]*/g, ' '));
        break;
      case 'inlineCode':
        text(n.value, true);
        break;
      case 'break':
        out.push({ type: 'hardBreak' });
        break;
      case 'emphasis':
        out.push(...inlinesIn(n.children, withMark(current(), { type: 'italic' }), defs));
        break;
      case 'strong':
        out.push(...inlinesIn(n.children, withMark(current(), { type: 'bold' }), defs));
        break;
      case 'delete':
        out.push(...inlinesIn(n.children, withMark(current(), { type: 'strike' }), defs));
        break;
      case 'link':
        out.push(...linkIn(n.url, n.title ?? null, n.children, current(), defs));
        break;
      case 'linkReference': {
        const def = defs.get(n.identifier);
        if (def) out.push(...linkIn(def.url, def.title ?? null, n.children, current(), defs));
        else out.push(...inlinesIn(n.children, current(), defs));
        break;
      }
      case 'image':
      case 'imageReference': {
        // No inline images yet: an image reads as a link to it.
        const def = n.type === 'imageReference' ? defs.get(n.identifier) : undefined;
        const url = n.type === 'image' ? n.url : (def?.url ?? '');
        const label = n.alt || url;
        if (url && isSafeHref(url)) {
          out.push(...linkIn(url, null, [{ type: 'text', value: label }], current(), defs));
        } else {
          text(label);
        }
        break;
      }
      case 'html': {
        const tag = tagMark(n.value);
        if (tag && 'br' in tag) out.push({ type: 'hardBreak' });
        else if (tag && 'open' in tag) {
          open.push({ mark: tag.open });
        } else if (tag && 'close' in tag) {
          const at = open.findLastIndex((o) => (TAG_OF[o.mark.type] ?? []).includes(tag.close));
          if (at === -1) text(n.value);
          else open.splice(at, 1);
        } else {
          text(n.value);
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** The file a paragraph names, when it is one link or image with the `attachment:` scheme. */
function attachmentIn(children: readonly PhrasingContent[]): PmJson | null {
  const [only, ...rest] = children;
  if (!only || rest.length > 0) return null;
  if ((only.type !== 'link' && only.type !== 'image') || !only.url.startsWith(ATTACHMENT_SCHEME)) {
    return null;
  }
  const encoded = only.url.slice(ATTACHMENT_SCHEME.length);
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    name = encoded;
  }
  if (!isAttachmentName(name)) return null;
  return { type: 'attachmentRef', attrs: { name, image: only.type === 'image' } };
}

function linkIn(
  url: string,
  title: string | null,
  children: readonly PhrasingContent[],
  marks: readonly MarkJson[],
  defs: Definitions,
): PmJson[] {
  if (url.startsWith(TICKET_SCHEME)) {
    const key = url.slice(TICKET_SCHEME.length);
    if (TICKET_KEY.test(key)) return [{ type: 'ticketRef', attrs: { key } }];
  }
  if (url.startsWith(MENTION_SCHEME)) {
    const [only] = children;
    if (children.length === 1 && only?.type === 'text' && only.value.startsWith('@')) {
      let id: string;
      try {
        id = decodeURIComponent(url.slice(MENTION_SCHEME.length));
      } catch {
        id = url.slice(MENTION_SCHEME.length);
      }
      return [{ type: 'mention', attrs: { id, label: only.value.slice(1) || null } }];
    }
  }
  if (!isSafeHref(url)) return inlinesIn(children, marks, defs);
  const link: MarkJson = {
    type: 'link',
    attrs: {
      href: url,
      target: null,
      rel: null,
      class: null,
      adfAttrs: title ? { href: url, title } : null,
    },
  };
  return inlinesIn(children, withMark(marks, link), defs);
}

/** Marks with one more; an inner mark of a type already there replaces the outer one. */
function withMark(marks: readonly MarkJson[], mark: MarkJson): MarkJson[] {
  return [...marks.filter((m) => m.type !== mark.type), mark];
}

/**
 * Whether pasted plain text reads as Markdown worth converting (NTF-006 (2)): a heading, list,
 * quote, fence, table or rule line, or inline emphasis, code or a link.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (/^(#{1,6} |\s*[-*+] |\s*\d{1,9}[.)] |> |```|~~~|\|.+\|\s*$|-{3,}\s*$)/m.test(text)) {
    return true;
  }
  return /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|~~[^~\n]+~~)/.test(text);
}
