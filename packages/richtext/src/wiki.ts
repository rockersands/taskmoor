import { type AdfNode, layoutSpan, MAX_TITLE_LENGTH } from './adf';
import type { PmJson } from './convert';
import { dayOf, isSafeHref, readableBlocks, SAFE_COLOR } from './markdown';
import { schema } from './schema';

/**
 * Wiki markup import and export (M1-071; API-011; ADR-091): the plain-text markup that version 2
 * of the Jira-compatible API carries. The notes below are our own description of it (ADR-003).
 *
 * Blocks are separated by blank lines and recognised at the start of a line:
 * - `h1. ` to `h6. ` start a heading of one line; `bq. ` a quoted paragraph; `----` is a rule;
 * - `* ` and `- ` start a bullet item and `# ` a numbered one; nesting repeats the marker, and
 *   mixed nesting combines them (`#* ` is a bullet inside a numbered item);
 * - a line that starts with `|` is a table row: `||` before a cell makes it a header cell, `|` a
 *   plain one;
 * - `{code:sql}` ... `{code}` and `{noformat}` ... `{noformat}` hold text taken as it is;
 *   `{quote}` ... `{quote}` holds blocks; `{panel:...}` ... `{panel}` holds blocks in a panel
 *   (`{info}`, `{note}`, `{tip}` and `{warning}` read as panels of those types);
 *   `{expand:Title}` ... `{expand}` holds blocks in a collapsible section.
 *
 * Inside a line: `*bold*`, `_italic_`, `-strike-`, `+underline+`, `^superscript^`,
 * `~subscript~`, `{{monospace}}`, `{color:#36b37e}text{color}`, `[text|address]`, `[address]`,
 * `[~accountid:42]` for a mention, `!picture.png!` for an image and `\\` for a line break. A
 * marker opens only where it is not glued to a letter or digit before it and has no space after
 * it; it closes where it has no space before it and no letter or digit after it. `{*}` (and
 * the same for every marker) works anywhere, so the writer uses it inside words. A backslash
 * before a markup character takes it as text; `&#92;` and other numeric references stand for
 * the character they name.
 *
 * Conventions so that what the editor makes comes back unchanged:
 * - checklists are bullet lists whose items start with `[ ]` or `[x]`;
 * - panel types are the panel's background colour (`{panel:bgColor=#deebff}` is info), or
 *   `panelType=` for types without a colour of their own (tip, custom);
 * - a code block without a language is `{noformat}` (a bare `{code}` reads as no language too);
 * - a line feed inside a paragraph reads as a line break, the way people type them.
 *
 * Documented losses, everything else round-trips (`wiki.test.ts` holds the corpus):
 * - attributes the markup has no place for (the other format's own attributes, link targets
 *   and titles, a numbered list's start, table column widths) are not written;
 * - a mention is written by id only and reads back without its display name;
 * - empty paragraphs are dropped, and text line feeds are written as spaces;
 * - emoji, dates and status lozenges are written as their text and read back as text;
 * - line breaks carry no marks; inline code carries no other mark (inside a link it reads as
 *   linked text);
 * - a list item holds one line and nested lists: its other blocks join that line after line
 *   breaks; a table cell holds one line the same way, and merged cells are written once with
 *   empty cells after them;
 * - a quote inside a quote stays a quote only when it is a single paragraph (`bq.`), and a
 *   panel inside a panel loses its frame: the markup cannot nest those blocks;
 * - a link address has `[`, `]`, `|`, backslashes and white space percent-encoded; links to
 *   addresses the editor may not hold (`javascript:` and the like) keep only their text;
 * - a code language that the markup cannot carry is dropped, and a code block whose text holds
 *   its own closing tag is written with `{noformat}`;
 * - columns are written as their blocks, one column after the other, and read back as that;
 * - a file of the ticket is written as its name and a ticket reference as its key, and both read
 *   back as text;
 * - a collapsible section inside another loses its frame, and `}` in a section's title is dropped:
 *   the markup cannot hold either;
 * - nodes and marks kept whole for the other format are written as the readable content they
 *   hold;
 * - web and email addresses in text (`https://...`, `mailto:...`) read back as links.
 */

type Attrs = Record<string, unknown>;
interface MarkJson {
  type: string;
  attrs?: Attrs;
}

/** Characters that open and close inline marks, and the mark each stands for. */
const DELIMS = '*_-+^~';
const MARK_OF: Record<string, MarkJson> = {
  '*': { type: 'bold' },
  _: { type: 'italic' },
  '-': { type: 'strike' },
  '+': { type: 'underline' },
  '^': { type: 'subsup', attrs: { type: 'sup' } },
  '~': { type: 'subsup', attrs: { type: 'sub' } },
};
/** Characters a backslash turns into text (two backslashes are a line break). */
const ESCAPABLE = new Set([...'*_-+^~{}[]|!#&']);
/** Marks, outermost first. Code is not here: it turns its text into monospace. */
const MARK_ORDER = ['link', 'textColor', 'underline', 'subsup', 'bold', 'italic', 'strike'];
/** Panel types by the background colour that stands for them. */
const PANEL_COLORS: Record<string, string> = {
  info: '#deebff',
  note: '#eae6ff',
  success: '#e3fcef',
  warning: '#fffae6',
  error: '#ffebe6',
};
const MAX_LIST_DEPTH = 20;
const LANGUAGE = /^[A-Za-z0-9_+#.-]+$/;

/**
 * Lower case for ASCII letters only, so every index into the result is an index into the text
 * (`İ` lowercases to two characters; M1-118, found by `pnpm fuzz wiki`). Macro names are ASCII,
 * and the readers' case-insensitive patterns fold ASCII only too.
 */
const asciiLower = (s: string): string => s.replace(/[A-Z]+/g, (c) => c.toLowerCase());
/** Ids a mention can carry in `[~accountid:...]`. */
const MENTION_ID = /^[^\s[\]|\\{}]+$/;

// ---------------------------------------------------------------------------------------------
// Characters

type Cls = 'edge' | 'space' | 'word' | 'punct';

function cls(ch: string | undefined): Cls {
  if (ch === undefined || ch === '') return 'edge';
  if (/\s/u.test(ch)) return 'space';
  return /[\p{L}\p{N}]/u.test(ch) ? 'word' : 'punct';
}

/** Whether a simple marker between these neighbours opens, and whether it closes. */
const opens = (prev: Cls, next: Cls) => (next === 'word' || next === 'punct') && prev !== 'word';
const closes = (prev: Cls, next: Cls) => (prev === 'word' || prev === 'punct') && next !== 'word';

function pointBefore(s: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const low = s.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = s.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

function pointAt(s: string, i: number): string | undefined {
  if (i >= s.length) return undefined;
  return String.fromCodePoint(s.codePointAt(i) as number);
}

const entity = (ch: string) => `&#${ch.codePointAt(0) as number};`;

// ---------------------------------------------------------------------------------------------
// Export

/** Writes a document (ProseMirror JSON on the shared schema) as wiki markup. */
export function toWiki(doc: PmJson): string {
  if (doc.type !== 'doc') throw new Error(`Expected a doc node, got "${doc.type}"`);
  return blocksOut(doc.content ?? [], { quote: false, panel: false, expand: false });
}

interface BlockContext {
  quote: boolean;
  panel: boolean;
  expand: boolean;
}

function blocksOut(nodes: readonly PmJson[], ctx: BlockContext): string {
  return nodes
    .map((n) => blockOut(n, ctx))
    .filter((s) => s !== '')
    .join('\n\n');
}

function blockOut(n: PmJson, ctx: BlockContext): string {
  const a = n.attrs ?? {};
  const content = n.content ?? [];
  switch (n.type) {
    case 'paragraph':
      return inlineOut(content, { newlines: true, lineStart: true });
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(a.level ?? 1) || 1));
      const body = inlineOut(content, { protectLead: true });
      return body === '' ? `h${level}.` : `h${level}. ${body}`;
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listOut(n, '').join('\n');
    case 'codeBlock':
      return codeOut(n);
    case 'blockquote': {
      if (!ctx.quote) return `{quote}\n${blocksOut(content, { ...ctx, quote: true })}\n{quote}`;
      // `{quote}` cannot nest: a quote in a quote is `bq.` when it is one paragraph.
      const [only] = content;
      if (content.length === 1 && only?.type === 'paragraph') {
        const body = inlineOut(only.content ?? [], {
          newlines: true,
          lineStart: true,
          protectLead: true,
        });
        return body === '' ? 'bq.' : `bq. ${body}`;
      }
      return blocksOut(content, ctx);
    }
    case 'horizontalRule':
      return '----';
    case 'panel': {
      if (ctx.panel) return blocksOut(content, ctx);
      return `{panel:${panelParams(String(a.panelType ?? 'info'))}}\n${blocksOut(content, { ...ctx, panel: true })}\n{panel}`;
    }
    case 'expand': {
      if (ctx.expand) return blocksOut(content, ctx);
      const title = expandTitle(a.title);
      return `{expand${title === '' ? '' : `:${title}`}}\n${blocksOut(content, { ...ctx, expand: true })}\n{expand}`;
    }
    case 'columnLayout':
      return blocksOut(
        content.flatMap((column) => column.content ?? []),
        ctx,
      );
    case 'attachmentRef':
      return inlineOut([{ type: 'text', text: String(a.name ?? '') }], {
        newlines: true,
        lineStart: true,
      });
    case 'table':
      return tableOut(n);
    case 'unknownBlock':
      return blocksOut(readableBlocks(a.adf as AdfNode | null), ctx);
    default:
      return '';
  }
}

/** A collapsible section's title as its opening tag can hold it. */
function expandTitle(title: unknown): string {
  return String(title ?? '')
    .replace(/[}\s]+/g, (run) => (/\s/.test(run) ? ' ' : ''))
    .trim();
}

function panelParams(panelType: string): string {
  const color = PANEL_COLORS[panelType];
  if (color) return `bgColor=${color}`;
  return /^[A-Za-z][A-Za-z0-9-]{0,30}$/.test(panelType)
    ? `panelType=${panelType}`
    : `bgColor=${PANEL_COLORS.info}`;
}

function codeOut(n: PmJson): string {
  const text = (n.content ?? []).map((t) => t.text ?? '').join('');
  const language = typeof n.attrs?.language === 'string' ? n.attrs.language : null;
  const lang = language && LANGUAGE.test(language) ? language : null;
  const lower = asciiLower(text);
  if (lang && !lower.includes('{code}')) return `{code:${lang}}\n${text}\n{code}`;
  if (!lower.includes('{noformat}')) return `{noformat}\n${text}\n{noformat}`;
  if (!lower.includes('{code}')) return `{code}\n${text}\n{code}`;
  return `{noformat}\n${text.replace(/\{noformat\}/gi, '{noformat }')}\n{noformat}`;
}

const isList = (n: PmJson) =>
  n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'taskList';

function listOut(list: PmJson, markers: string): string[] {
  const own = list.type === 'orderedList' ? '#' : '*';
  const marker = markers + own;
  const lines: string[] = [];
  for (const item of list.content ?? []) {
    const [first, ...rest] = item.content ?? [];
    // One line per item: blocks other than lists join it after line breaks.
    const inline: PmJson[] = first ? [...flatInline(first)] : [];
    for (const block of rest) {
      if (isList(block)) continue;
      const more = flatInline(block);
      if (more.length === 0) continue;
      if (inline.length > 0) inline.push({ type: 'hardBreak' });
      inline.push(...more);
    }
    let body: string;
    if (list.type === 'taskList') {
      const box = item.attrs?.checked ? '\\[x]' : '\\[ ]';
      const text = inlineOut(inline, {});
      body = text === '' ? box : `${box} ${text}`;
    } else {
      body = inlineOut(inline, { protectLead: true });
      // Text that starts like a checkbox must not turn the list into a checklist.
      if (/^\\\[[ xX]\](?:\s|$)/.test(body)) body = `&#91;${body.slice(2)}`;
    }
    lines.push(body === '' ? marker : `${marker} ${body}`);
    for (const block of rest) if (isList(block)) lines.push(...listOut(block, marker));
  }
  return lines;
}

/** A block's content as inline nodes, for places that hold one line. */
function flatInline(block: PmJson): PmJson[] {
  const a = block.attrs ?? {};
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return block.content ?? [];
    case 'codeBlock': {
      const text = (block.content ?? []).map((t) => t.text ?? '').join('');
      return joinBreaks(
        text.split('\n').map((line) => (line ? [{ type: 'text', text: line }] : [])),
      );
    }
    case 'horizontalRule':
      return [];
    case 'unknownBlock':
      return joinBreaks(readableBlocks(a.adf as AdfNode | null).map(flatInline));
    case 'attachmentRef':
      return a.name ? [{ type: 'text', text: String(a.name) }] : [];
    case 'expand': {
      const title = expandTitle(a.title);
      return joinBreaks([
        title === '' ? [] : [{ type: 'text', text: title }],
        ...(block.content ?? []).map(flatInline),
      ]);
    }
    case 'table':
      return joinBreaks(
        (block.content ?? []).flatMap((row) =>
          (row.content ?? []).map((cell) => joinBreaks((cell.content ?? []).map(flatInline))),
        ),
      );
    default:
      // Lists, list items, quotes and panels: their blocks, one after the other.
      return joinBreaks((block.content ?? []).map(flatInline));
  }
}

function joinBreaks(parts: PmJson[][]): PmJson[] {
  const out: PmJson[] = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    if (out.length > 0) out.push({ type: 'hardBreak' });
    out.push(...part);
  }
  return out;
}

function tableOut(table: PmJson): string {
  const lines: string[] = [];
  for (const row of table.content ?? []) {
    const cells = row.content ?? [];
    if (cells.length === 0) continue;
    let line = '';
    let last = '|';
    for (const cell of cells) {
      const delim = cell.type === 'tableHeader' ? '||' : '|';
      const body = inlineOut(joinBreaks((cell.content ?? []).map(flatInline)), {
        table: true,
        protectLead: true,
        protectTrail: true,
      });
      line += delim + (body === '' ? ' ' : body);
      // A merged cell is written once; the columns it covers get empty cells.
      const span = layoutSpan(cell.attrs?.colspan);
      for (let i = 1; i < span; i++) line += `${delim} `;
      last = delim;
    }
    lines.push(line + last);
  }
  return lines.join('\n');
}

// Inline export ---------------------------------------------------------------------------------

interface LineOptions {
  /** A line break may be a line feed (paragraphs); elsewhere it is `\\`. */
  newlines?: boolean;
  /** Lines start blocks here, so text that looks like a block start is escaped. */
  lineStart?: boolean;
  /** Leading white space would be trimmed by the reader: keep it as a reference. */
  protectLead?: boolean;
  protectTrail?: boolean;
  /** Inside a table row, where `|` separates cells. */
  table?: boolean;
}

interface Unit {
  kind: 'lit' | 'delim' | 'syn' | 'br';
  /** The character (lit), the marker (delim) or the text (syn). */
  v: string;
  role?: 'open' | 'close';
  inLink?: boolean;
  inCode?: boolean;
  /** What is written; decided in `render`. */
  out?: string;
  forced?: boolean;
}

interface Item {
  node: PmJson;
  marks: MarkJson[];
  units: Unit[];
  br: boolean;
}

interface Frame {
  mark: MarkJson | null;
  children: (Frame | Item)[];
}

const markKey = (m: MarkJson) =>
  m.type === 'link'
    ? `link:${String(m.attrs?.href ?? '')}`
    : `${m.type}:${m.type === 'subsup' ? String(m.attrs?.type) : m.type === 'textColor' ? String(m.attrs?.color) : ''}`;

/** Marks the markup can write, in nesting order; others (unknown ones, unsafe links) drop. */
function writableMarks(n: PmJson): MarkJson[] {
  if (n.type !== 'text') return [];
  const marks = n.marks ?? [];
  const linked = marks.some((m) => m.type === 'link' && linkable(m));
  // Monospace takes no other mark; linked monospace is written as linked text.
  if (marks.some((m) => m.type === 'code') && !linked) return [];
  return marks
    .filter((m) => MARK_ORDER.includes(m.type))
    .filter((m) => m.type !== 'link' || linkable(m))
    .filter((m) => m.type !== 'textColor' || SAFE_COLOR.test(String(m.attrs?.color ?? '')))
    .sort((x, y) => MARK_ORDER.indexOf(x.type) - MARK_ORDER.indexOf(y.type));
}

function linkable(m: MarkJson): boolean {
  const href = String(m.attrs?.href ?? '');
  return href.trim() !== '' && isSafeHref(href);
}

const lits = (text: string, inCode = false): Unit[] =>
  Array.from(text.replace(/\r\n?|\n/g, ' '), (v) => ({ kind: 'lit' as const, v, inCode }));
const syn = (v: string): Unit => ({ kind: 'syn', v });

function leafUnits(n: PmJson, marks: MarkJson[]): Unit[] {
  const a = n.attrs ?? {};
  switch (n.type) {
    case 'text': {
      const text = n.text ?? '';
      if (text === '') return [];
      const code = n.marks?.some((m) => m.type === 'code') && !marks.some((m) => m.type === 'link');
      return code ? [syn('{{'), ...lits(text, true), syn('}}')] : lits(text);
    }
    case 'hardBreak':
      return [{ kind: 'br', v: '' }];
    case 'mention': {
      const id = String(a.id ?? '');
      if (MENTION_ID.test(id)) return [syn(`[~accountid:${id}]`)];
      const label = typeof a.label === 'string' && a.label !== '' ? a.label : id;
      return label ? lits(`@${label}`) : [];
    }
    case 'emoji': {
      const text = typeof a.text === 'string' && a.text !== '' ? a.text : String(a.shortName ?? '');
      return lits(text);
    }
    case 'date':
      return lits(dayOf(String(a.timestamp ?? '')));
    case 'status':
      return a.text ? lits(`[${String(a.text)}]`) : [];
    case 'ticketRef':
      return a.key ? lits(String(a.key)) : [];
    default:
      return [];
  }
}

/** Inline nodes with flat marks as nested markup, rendered as one string. */
function inlineOut(nodes: readonly PmJson[], opts: LineOptions): string {
  // Web and email addresses in text are written as links, the way the reader takes them.
  const linked = nodes.flatMap((node) => {
    // A node kept whole for the other format is written as the text it holds.
    if (node.type === 'unknownInline') {
      const adf = node.attrs?.adf as AdfNode | null;
      const text = adf?.text ?? adf?.attrs?.text ?? adf?.attrs?.url;
      return typeof text === 'string' && text !== '' ? autolinks(text, []) : [];
    }
    return node.type === 'text' && !node.marks?.some((m) => m.type === 'link' || m.type === 'code')
      ? autolinks(node.text ?? '', node.marks ?? [])
      : [node];
  });
  const items: Item[] = linked
    .map((node) => {
      const marks = writableMarks(node);
      return { node, marks, units: leafUnits(node, marks), br: node.type === 'hardBreak' };
    })
    .filter((i) => i.units.length > 0);
  const keys = items.map((i) => new Set(i.marks.map(markKey)));
  // A line break keeps the marks on both sides of it open and opens none of its own.
  for (const [index, item] of items.entries()) {
    if (!item.br) continue;
    let before = index - 1;
    while (before >= 0 && items[before]?.br) before--;
    let after = index + 1;
    while (after < items.length && items[after]?.br) after++;
    const prev = before >= 0 ? (keys[before] as Set<string>) : null;
    const next = after < items.length ? (keys[after] as Set<string>) : null;
    const both = prev && next ? new Set([...prev].filter((k) => next.has(k))) : new Set<string>();
    keys[index] = both;
    item.marks =
      before >= 0 ? (items[before] as Item).marks.filter((m) => both.has(markKey(m))) : [];
  }
  const root: Frame = { mark: null, children: [] };
  const stack: Frame[] = [root];
  // Frames are attached to their parent when they open; closing one only leaves it.
  const close = () => stack.pop();
  const reach = (key: string, from: number) => {
    let to = from;
    while (keys[to]?.has(key)) to++;
    return to - from;
  };
  for (const [index, item] of items.entries()) {
    const wanted = keys[index] as Set<string>;
    let keep = 1;
    while (keep < stack.length && wanted.has(markKey(stack[keep]?.mark as MarkJson))) keep++;
    while (stack.length > keep) close();
    const open = new Set(stack.slice(1).map((f) => markKey(f.mark as MarkJson)));
    const fresh = item.marks
      .filter((m) => !open.has(markKey(m)))
      .sort((x, y) => reach(markKey(y), index) - reach(markKey(x), index));
    for (const mark of fresh) {
      const frame: Frame = { mark, children: [] };
      (stack[stack.length - 1] as Frame).children.push(frame);
      stack.push(frame);
    }
    (stack[stack.length - 1] as Frame).children.push(item);
  }
  return render(emit(root.children, false), opts);
}

function isFrame(x: Frame | Item): x is Frame {
  return 'children' in x;
}

function emit(children: readonly (Frame | Item)[], inLink: boolean): Unit[] {
  const out: Unit[] = [];
  for (const child of children) {
    if (!isFrame(child)) {
      for (const u of child.units)
        out.push(inLink && u.kind !== 'syn' ? { ...u, inLink } : { ...u });
      continue;
    }
    const mark = child.mark as MarkJson;
    const a = mark.attrs ?? {};
    if (mark.type === 'link') {
      const href = String(a.href ?? '');
      const [only] = child.children;
      if (
        child.children.length === 1 &&
        only &&
        !isFrame(only) &&
        only.node.type === 'text' &&
        only.node.text === href &&
        !only.node.marks?.some((m) => m.type === 'code') &&
        shorthand(href)
      ) {
        out.push(syn(`[${href}]`));
      } else {
        const alias = emit(child.children, true);
        // `[~` and `[^` start a mention and an attachment: the text must not start with them.
        const lead = alias[0];
        if (lead && (lead.v === '~' || lead.v === '^')) {
          lead.forced = lead.kind === 'lit';
          lead.out = lead.kind === 'lit' ? `\\${lead.v}` : `{${lead.v}}`;
        }
        out.push(syn('['), ...alias, syn(`|${encodeHref(href)}]`));
      }
      continue;
    }
    if (mark.type === 'textColor') {
      out.push(syn(`{color:${String(a.color)}}`), ...emit(child.children, inLink), syn('{color}'));
      continue;
    }
    const c = mark.type === 'subsup' ? (a.type === 'sup' ? '^' : '~') : delimFor(mark.type);
    out.push({ kind: 'delim', v: c, role: 'open', inLink }, ...emit(child.children, inLink), {
      kind: 'delim',
      v: c,
      role: 'close',
      inLink,
    });
  }
  return out;
}

function delimFor(type: string): string {
  switch (type) {
    case 'bold':
      return '*';
    case 'italic':
      return '_';
    case 'strike':
      return '-';
    default:
      return '+';
  }
}

/** Whether `[address]` reads back as a link to exactly this address. */
function shorthand(href: string): boolean {
  return (
    looksLikeAddress(href) &&
    isSafeHref(href) &&
    !/[\s[\]|\\{}]/.test(href) &&
    !href.startsWith('~') &&
    !href.startsWith('^')
  );
}

/** An address as `[text|address]` holds it: what would end or split the link, encoded. */
function encodeHref(href: string): string {
  const code = (ch: string) =>
    `%${(ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(2, '0')}`;
  // The reader trims the address, so white space at its ends is encoded too.
  return href
    .replace(/[[\]|\\{}\r\n]/g, code)
    .replace(/^\s+|\s+$/g, (ws) => [...ws].map(code).join(''));
}

/** Text that reads as a block start when it begins a line. */
const LINE_START = /^(?:h[1-6]\.(?:\s|$)|bq\.(?:\s|$)|(?:[*#]+|-)(?:\s|$)|-{4,}\s*$|\|)/;

/**
 * Decides how each unit is written: line breaks, which markers need their braced form, and
 * which characters need a backslash or a reference so that they read back as text.
 */
function render(units: Unit[], opts: LineOptions): string {
  const n = units.length;
  const first = (u: Unit | undefined): string | undefined => {
    if (!u) return undefined;
    if (u.out !== undefined) return pointAt(u.out, 0);
    if (u.kind === 'br') return '\\';
    return pointAt(u.v, 0);
  };
  const last = (u: Unit | undefined): string | undefined => {
    if (!u) return undefined;
    if (u.out !== undefined) return pointBefore(u.out, u.out.length);
    if (u.kind === 'br') return '\\';
    return pointBefore(u.v, u.v.length);
  };
  const force = (u: Unit) => {
    u.forced = true;
    u.out = ESCAPABLE.has(u.v) ? `\\${u.v}` : entity(u.v);
  };
  const isSpaceLit = (u: Unit | undefined) => u?.kind === 'lit' && /\s/u.test(u.v);

  // 1. Line breaks: a line feed in paragraphs when a visible character follows, else `\\`.
  for (let i = 0; i < n; i++) {
    const u = units[i] as Unit;
    if (u.kind !== 'br') continue;
    const next = units[i + 1];
    const feed =
      opts.newlines &&
      i > 0 &&
      !u.inLink &&
      !u.inCode &&
      next !== undefined &&
      next.kind !== 'br' &&
      !/\s/u.test(first(next) ?? ' ');
    u.out = feed ? '\n' : '\\\\';
  }

  // 2. Line starts and edges the reader would take for markup or trim.
  if (opts.lineStart) {
    const starts = [0];
    for (let i = 0; i < n; i++) if (units[i]?.out === '\n') starts.push(i + 1);
    for (const start of starts) {
      let end = start;
      while (end < n && units[end]?.out !== '\n') end++;
      let j = start;
      while (j < end && isSpaceLit(units[j])) j++;
      if (j === end) {
        if (start < end) force(units[start] as Unit);
        continue;
      }
      const text = units
        .slice(j, end)
        .map((u) => u.out ?? u.v)
        .join('');
      const head = units[j] as Unit;
      if (!LINE_START.test(text)) continue;
      if (head.kind === 'lit') force(head);
      else if (head.kind === 'delim') head.out = `{${head.v}}`;
    }
  }
  if (opts.protectLead && isSpaceLit(units[0]) && !units[0]?.forced) force(units[0] as Unit);
  if (opts.protectTrail && isSpaceLit(units[n - 1]) && !units[n - 1]?.forced) {
    force(units[n - 1] as Unit);
  }

  // 3. Markers: the simple form where it reads as intended, else the braced form.
  for (let i = 0; i < n; i++) {
    const u = units[i] as Unit;
    if (u.kind !== 'delim' || u.out !== undefined) continue;
    const prev = last(units[i - 1]);
    const next = first(units[i + 1]);
    const ok =
      prev !== u.v &&
      next !== u.v &&
      (u.role === 'open' ? opens(cls(prev), cls(next)) : closes(cls(prev), cls(next)));
    u.out = ok ? u.v : `{${u.v}}`;
  }

  // 4. Marker characters in text: escaped when the reader could pair them with another.
  const plainLit = (u: Unit | undefined) => u?.kind === 'lit' && !u.forced && DELIMS.includes(u.v);
  const inRun = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; ) {
    const u = units[i] as Unit;
    let j = i + 1;
    if (plainLit(u)) while (j < n && plainLit(units[j]) && units[j]?.v === u.v) j++;
    if (j - i >= 2) for (let k = i; k < j; k++) inRun[k] = true;
    i = j;
  }
  const flags = (i: number) => {
    const u = units[i] as Unit;
    if (u.kind === 'delim' && u.out !== u.v) return { open: true, close: true };
    const prev = cls(units[i - 1]?.kind === 'lit' ? units[i - 1]?.v : last(units[i - 1]));
    const next = cls(units[i + 1]?.kind === 'lit' ? units[i + 1]?.v : first(units[i + 1]));
    return { open: opens(prev, next), close: closes(prev, next) };
  };
  for (const c of DELIMS) {
    const at: { i: number; lit: boolean; open: boolean; close: boolean }[] = [];
    for (let i = 0; i < n; i++) {
      const u = units[i] as Unit;
      if (u.v !== c) continue;
      if (u.kind === 'delim') at.push({ i, lit: false, ...flags(i) });
      else if (plainLit(u) && !inRun[i]) at.push({ i, lit: true, ...flags(i) });
    }
    let opener = false;
    for (const p of at) {
      if (p.lit && p.close && opener) force(units[p.i] as Unit);
      if (p.open) opener = true;
    }
    let closer = false;
    for (let k = at.length - 1; k >= 0; k--) {
      const p = at[k] as (typeof at)[number];
      if (p.lit && p.open && closer && !units[p.i]?.forced) force(units[p.i] as Unit);
      if (p.close) closer = true;
    }
  }

  // 5. Other characters that would read as markup.
  for (let i = 0; i < n; i++) {
    const u = units[i] as Unit;
    if (u.kind === 'syn') {
      u.out = u.v;
      continue;
    }
    if (u.kind !== 'lit' || u.out !== undefined) continue;
    const next = units[i + 1];
    const after = next?.kind === 'lit' && next.out === undefined ? next.v : first(next);
    switch (u.v) {
      case '\\':
        u.out = after === undefined || after === '\\' || ESCAPABLE.has(after) ? '&#92;' : '\\';
        break;
      case '{':
      case '[':
        u.out = `\\${u.v}`;
        break;
      case ']':
        u.out = u.inLink ? '\\]' : ']';
        break;
      case '|':
        u.out = u.inLink || opts.table ? '\\|' : '|';
        break;
      case '}':
        u.out = u.inCode ? '\\}' : '}';
        break;
      case '!':
        u.out = after !== undefined && !/\s/u.test(after) ? '\\!' : '!';
        break;
      case '&':
        u.out = after === '#' ? '\\&' : '&';
        break;
      default:
        u.out = u.v;
    }
  }
  return units.map((u) => u.out ?? u.v).join('');
}

// ---------------------------------------------------------------------------------------------
// Import

/** Reads wiki markup into a document on the shared schema. */
export function fromWiki(text: string): PmJson {
  const content = unnest(blocksIn(text.replace(/\r\n?/g, '\n')), {
    quote: false,
    panel: false,
    expand: false,
  });
  const json: PmJson = {
    type: 'doc',
    content: content.length > 0 ? content : [{ type: 'paragraph' }],
  };
  const node = schema.nodeFromJSON(json);
  node.check();
  return node.toJSON() as PmJson;
}

/**
 * Quotes and panels nested the way the writer can write them back: a quote in a quote only as
 * one paragraph, no panel in a panel (the inner one's blocks take its place).
 */
function unnest(blocks: readonly PmJson[], ctx: BlockContext): PmJson[] {
  const out: PmJson[] = [];
  // Blocks that take the place of their container; the writer drops empty paragraphs.
  const splice = (inner: PmJson[]) =>
    out.push(...inner.filter((x) => x.type !== 'paragraph' || (x.content ?? []).length > 0));
  const within = (b: PmJson, inner: BlockContext): PmJson => {
    const content = unnest(b.content ?? [], inner);
    return { ...b, content: content.length > 0 ? content : [{ type: 'paragraph' }] };
  };
  for (const b of blocks) {
    const content = b.content ?? [];
    if (b.type === 'blockquote') {
      if (!ctx.quote) out.push(within(b, { ...ctx, quote: true }));
      else if (content.length === 1 && content[0]?.type === 'paragraph') out.push(b);
      else splice(unnest(content, ctx));
    } else if (b.type === 'panel') {
      if (ctx.panel) splice(unnest(content, ctx));
      else out.push(within(b, { ...ctx, panel: true }));
    } else if (b.type === 'expand') {
      if (ctx.expand) splice(unnest(content, ctx));
      else out.push(within(b, { ...ctx, expand: true }));
    } else {
      out.push(b);
    }
  }
  return out;
}

const MACRO = /[ \t]*\{(code|noformat|quote|panel|info|note|tip|warning|expand)(?::([^}\n]*))?\}/iy;
const HEADING = /^h([1-6])\.(?:\s(.*))?$/;
const RULE = /^-{4,}[ \t]*$/;
const QUOTE_LINE = /^bq\.(?:\s(.*))?$/;
const LIST_LINE = /^([*#]+|-)(?:[ \t]+(.*))?$/;
const TASK = /^\\?\[([ xX])\\?\](?:[ \t]|$)/;

function lineEnd(src: string, i: number): number {
  const end = src.indexOf('\n', i);
  return end === -1 ? src.length : end;
}

/**
 * How deep block macros nest before an opening tag reads as text (M1-118, fuzz 2026-11-02). An
 * unclosed `{panel}` holds the rest of the text, so a run of them nested each in the one before
 * and every level scanned what followed it again: 312 took 620 ms. Deeper levels add nothing a
 * document can keep (a panel in a panel loses its frame, see `unnest`).
 */
const MAX_MACRO_DEPTH = 8;
let macroDepth = 0;

function macroAt(src: string, i: number): RegExpExecArray | null {
  if (macroDepth >= MAX_MACRO_DEPTH) return null;
  MACRO.lastIndex = i;
  return MACRO.exec(src);
}

/** `asciiLower` of the text a macro sits in, once per text rather than once per macro. */
let lowered: { src: string; lower: string } | undefined;
function lowerOf(src: string): string {
  if (lowered?.src !== src) lowered = { src, lower: asciiLower(src) };
  return lowered.lower;
}

function startsBlock(src: string, i: number, line: string): boolean {
  const lead = line.trimStart();
  return (
    macroAt(src, i) !== null ||
    HEADING.test(lead) ||
    RULE.test(lead) ||
    QUOTE_LINE.test(lead) ||
    LIST_LINE.test(lead) ||
    lead.startsWith('|')
  );
}

function blocksIn(src: string): PmJson[] {
  const out: PmJson[] = [];
  let i = 0;
  while (i < src.length) {
    const eol = lineEnd(src, i);
    const line = src.slice(i, eol);
    if (line.trim() === '') {
      i = eol + 1;
      continue;
    }
    const macro = macroAt(src, i);
    if (macro) {
      const read = macroIn(src, macro);
      out.push(...read.blocks);
      i = read.end;
      continue;
    }
    const lead = line.trimStart();
    const heading = HEADING.exec(lead);
    if (heading) {
      out.push({
        type: 'heading',
        attrs: { level: Number(heading[1]) },
        content: inlineIn((heading[2] ?? '').replace(/^\s+/, '')),
      });
      i = eol + 1;
      continue;
    }
    if (RULE.test(lead)) {
      out.push({ type: 'horizontalRule' });
      i = eol + 1;
      continue;
    }
    const quote = QUOTE_LINE.exec(lead);
    if (quote) {
      const lines = [(quote[1] ?? '').replace(/^\s+/, '')];
      i = continuation(src, eol + 1, lines);
      out.push({
        type: 'blockquote',
        content: [{ type: 'paragraph', content: inlineIn(lines.join('\n')) }],
      });
      continue;
    }
    if (LIST_LINE.test(lead)) {
      const read = listIn(src, i);
      out.push(...read.blocks);
      i = read.end;
      continue;
    }
    if (lead.startsWith('|')) {
      const read = tableIn(src, i);
      if (read.block) out.push(read.block);
      i = read.end;
      continue;
    }
    const lines = [line];
    i = continuation(src, eol + 1, lines);
    out.push({ type: 'paragraph', content: inlineIn(lines.join('\n')) });
  }
  return out;
}

/** Collects the lines that continue a paragraph; returns where the next block starts. */
function continuation(src: string, from: number, lines: string[]): number {
  let i = from;
  while (i < src.length) {
    const eol = lineEnd(src, i);
    const line = src.slice(i, eol);
    if (line.trim() === '' || startsBlock(src, i, line)) return i;
    lines.push(line);
    i = eol + 1;
  }
  return i;
}

/** After a closing tag: the rest of its line when it holds only white space. */
function afterTag(src: string, end: number): number {
  const eol = lineEnd(src, end);
  return src.slice(end, eol).trim() === '' ? eol + 1 : end;
}

function params(raw: string | undefined): { list: string[]; named: Map<string, string> } {
  const list: string[] = [];
  const named = new Map<string, string>();
  for (const part of (raw ?? '').split('|')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      if (part.trim() !== '') list.push(part.trim());
    } else {
      named.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
    }
  }
  return { list, named };
}

function macroIn(src: string, m: RegExpExecArray): { blocks: PmJson[]; end: number } {
  const name = (m[1] as string).toLowerCase();
  const bodyStart = m.index + m[0].length;
  const tag = `{${name}}`;
  const lower = lowerOf(src);
  if (name === 'code' || name === 'noformat') {
    const close = lower.indexOf(tag, bodyStart);
    const bodyEnd = close === -1 ? src.length : close;
    const body = src
      .slice(bodyStart, bodyEnd)
      .replace(/^[ \t]*\n/, '')
      .replace(/\n[ \t]*$/, '');
    const p = params(m[2]);
    const given =
      name === 'code'
        ? (p.named.get('language') ?? p.named.get('lang') ?? p.list[0] ?? null)
        : null;
    // Only a language the writer can carry, so the block writes back as it was read (M1-118).
    const language = given && LANGUAGE.test(given) ? given : null;
    return {
      blocks: [
        {
          type: 'codeBlock',
          attrs: { language },
          ...(body ? { content: [{ type: 'text', text: body }] } : {}),
        },
      ],
      end: close === -1 ? src.length : afterTag(src, close + tag.length),
    };
  }
  const close = closingTag(src, lower, bodyStart, tag);
  const bodyEnd = close === -1 ? src.length : close;
  macroDepth++;
  let blocks: PmJson[];
  try {
    blocks = blocksIn(src.slice(bodyStart, bodyEnd));
  } finally {
    macroDepth--;
  }
  const end = close === -1 ? src.length : afterTag(src, close + tag.length);
  if (name === 'quote') {
    return {
      blocks: [
        { type: 'blockquote', content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }] },
      ],
      end,
    };
  }
  if (name === 'expand') {
    return {
      blocks: [
        {
          type: 'expand',
          attrs: { title: expandTitle(m[2]).slice(0, MAX_TITLE_LENGTH) },
          content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
        },
      ],
      end,
    };
  }
  let panelType = name;
  if (name === 'panel') {
    const p = params(m[2]);
    const declared = p.named.get('paneltype');
    const color = p.named.get('bgcolor')?.toLowerCase();
    const byColor = Object.entries(PANEL_COLORS).find(([, c]) => c === color)?.[0];
    panelType =
      declared && /^[A-Za-z][A-Za-z0-9-]{0,30}$/.test(declared) ? declared : (byColor ?? 'info');
    const title = p.named.get('title');
    if (title) {
      blocks.unshift({
        type: 'paragraph',
        content: [{ type: 'text', text: title, marks: [{ type: 'bold' }] }],
      });
    }
  }
  return {
    blocks: [
      {
        type: 'panel',
        attrs: { panelType },
        content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
      },
    ],
    end,
  };
}

/** Where a block macro's closing tag is, past escapes and the code blocks inside it. */
function closingTag(src: string, lower: string, from: number, tag: string): number {
  let lineStart = from;
  for (let j = from; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\n') {
      lineStart = j + 1;
      continue;
    }
    if (ch === '\\') {
      j++;
      continue;
    }
    if (ch !== '{') continue;
    if (src[j + 1] === '{') {
      // Monospace may hold the tag's letters (`{{quote}}`): it is not the tag.
      const end = codeEnd(src, j + 2);
      if (end !== -1 && !src.slice(j, end).includes('\n')) {
        j = end + 1;
        continue;
      }
    }
    if (lower.startsWith(tag, j)) return j;
    if (src.slice(lineStart, j).trim() !== '') continue;
    const inner = /\{(code|noformat)(?::[^}\n]*)?\}/iy;
    inner.lastIndex = j;
    const m = inner.exec(src);
    if (!m) continue;
    const close = lower.indexOf(`{${(m[1] as string).toLowerCase()}}`, j + m[0].length);
    if (close === -1) return -1;
    j = close + (m[1] as string).length + 1;
  }
  return -1;
}

interface ListBuild {
  ordered: boolean;
  items: ItemBuild[];
}
interface ItemBuild {
  raw: string;
  more: string[];
  lists: ListBuild[];
}

function listIn(src: string, from: number): { blocks: PmJson[]; end: number } {
  const top: ListBuild[] = [];
  const stack: ListBuild[] = [];
  let current: ItemBuild | null = null;
  let i = from;
  while (i < src.length) {
    const eol = lineEnd(src, i);
    const line = src.slice(i, eol);
    if (line.trim() === '') break;
    const lead = line.trimStart();
    const m = macroAt(src, i) ? null : LIST_LINE.exec(lead);
    if (!m) {
      if (startsBlock(src, i, line) || !current) break;
      current.more.push(line);
      i = eol + 1;
      continue;
    }
    const markers = (m[1] as string).slice(0, MAX_LIST_DEPTH);
    const item: ItemBuild = { raw: m[2] ?? '', more: [], lists: [] };
    for (let k = 0; k < markers.length; k++) {
      const ordered = markers[k] === '#';
      const deepest = k === markers.length - 1;
      const existing = stack[k];
      if (existing && existing.ordered === ordered) {
        if (deepest) {
          existing.items.push(item);
          stack.length = k + 1;
        }
        continue;
      }
      stack.length = k;
      const list: ListBuild = { ordered, items: [] };
      if (k === 0) top.push(list);
      else {
        const parent = stack[k - 1] as ListBuild;
        let owner = parent.items[parent.items.length - 1];
        if (!owner) {
          owner = { raw: '', more: [], lists: [] };
          parent.items.push(owner);
        }
        owner.lists.push(list);
      }
      stack.push(list);
      if (deepest) list.items.push(item);
      else list.items.push({ raw: '', more: [], lists: [] });
    }
    current = item;
    i = eol + 1;
  }
  return { blocks: top.map(listJson), end: i };
}

function listJson(list: ListBuild): PmJson {
  const task = !list.ordered && list.items.every((it) => TASK.test(it.raw));
  if (task) {
    return {
      type: 'taskList',
      content: list.items.map((it) => {
        const box = TASK.exec(it.raw) as RegExpExecArray;
        return {
          type: 'taskItem',
          attrs: { checked: box[1] !== ' ' },
          content: itemJson({ ...it, raw: it.raw.slice(box[0].length) }),
        };
      }),
    };
  }
  return {
    type: list.ordered ? 'orderedList' : 'bulletList',
    content: list.items.map((it) => ({ type: 'listItem', content: itemJson(it) })),
  };
}

function itemJson(item: ItemBuild): PmJson[] {
  return [
    { type: 'paragraph', content: inlineIn([item.raw, ...item.more].join('\n')) },
    ...item.lists.map(listJson),
  ];
}

function tableIn(src: string, from: number): { block: PmJson | null; end: number } {
  const rows: PmJson[] = [];
  let i = from;
  while (i < src.length) {
    const eol = lineEnd(src, i);
    const lead = src.slice(i, eol).trimStart();
    if (!lead.startsWith('|')) break;
    const cells = splitRow(lead);
    if (cells.length > 0) {
      rows.push({
        type: 'tableRow',
        content: cells.map((cell) => ({
          type: cell.header ? 'tableHeader' : 'tableCell',
          content: [
            { type: 'paragraph', content: inlineIn(cell.src.replace(/^[ \t]+|[ \t]+$/g, '')) },
          ],
        })),
      });
    }
    i = eol + 1;
  }
  return { block: rows.length > 0 ? { type: 'table', content: rows } : null, end: i };
}

const IMAGE = /!([^\s!|[\]{}\\]+)(?:\|[^!\n]*)?!/y;

function splitRow(line: string): { header: boolean; src: string }[] {
  const cells: { header: boolean; src: string }[] = [];
  let header: boolean | null = null;
  let start = 0;
  let j = 0;
  while (j < line.length) {
    const ch = line[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '[') {
      const end = bracketEnd(line, j + 1);
      if (end !== -1) {
        j = end + 1;
        continue;
      }
    }
    if (line.startsWith('{{', j)) {
      const end = codeEnd(line, j + 2);
      if (end !== -1) {
        j = end + 2;
        continue;
      }
    }
    if (ch === '!') {
      IMAGE.lastIndex = j;
      const m = IMAGE.exec(line);
      if (m) {
        j += m[0].length;
        continue;
      }
    }
    if (ch === '|') {
      if (header !== null) cells.push({ header, src: line.slice(start, j) });
      header = line[j + 1] === '|';
      j += header ? 2 : 1;
      start = j;
      continue;
    }
    j++;
  }
  if (header !== null) {
    const rest = line.slice(start);
    if (rest.trim() !== '') cells.push({ header, src: rest });
  }
  return cells;
}

// Inline import ---------------------------------------------------------------------------------

type Tok =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'delim'; c: string; open: boolean; close: boolean; raw: string }
  | { t: 'code'; src: string; raw: string }
  | { t: 'link'; src: string; raw: string }
  | { t: 'image'; src: string; raw: string }
  | { t: 'colorOpen'; color: string; raw: string }
  | { t: 'colorClose'; raw: string };

/** The index of the `]` closing a bracket opened before `from`, or -1. */
function bracketEnd(src: string, from: number): number {
  for (let j = from; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\' && src[j + 1] !== '\n') j++;
    else if (ch === ']') return j;
    else if (ch === '[' || ch === '\n') return -1;
  }
  return -1;
}

/**
 * Where a scan found no `}}` up to the end of its text (M1-118, fuzz 2026-11-02): a later scan
 * of the same text from further on finds none either, so a line of unclosed `{{` costs one scan,
 * not one per `{{`. Every caller starts right after a `{{`, a position an earlier scan reached
 * in step (not as the character after a backslash), so the answer is the same.
 */
let noCloseFrom: { src: string; from: number } | undefined;

/** The index of the `}}` closing monospace opened before `from`, or -1. */
function codeEnd(src: string, from: number): number {
  if (noCloseFrom !== undefined && from >= noCloseFrom.from && noCloseFrom.src === src) return -1;
  for (let j = from; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === '}' && src[j + 1] === '}') return j > from ? j : -1;
  }
  noCloseFrom = { src, from };
  return -1;
}

const BRACE = /\{([*_\-+^~])\}/y;
const COLOR = /\{color(?::([^}\n]*))?\}/iy;
const REFERENCE = /&#(?:(\d{1,7})|[xX]([0-9a-fA-F]{1,6}));/y;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let text = '';
  const flush = () => {
    if (text !== '') out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === '\\') {
        flush();
        out.push({ t: 'br' });
        i += 2;
      } else if (next !== undefined && ESCAPABLE.has(next)) {
        text += next;
        i += 2;
      } else {
        text += '\\';
        i++;
      }
      continue;
    }
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '&') {
      REFERENCE.lastIndex = i;
      const m = REFERENCE.exec(src);
      const point = m ? Number.parseInt((m[1] ?? m[2]) as string, m[1] ? 10 : 16) : Number.NaN;
      if (m && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) && point > 0) {
        text += String.fromCodePoint(point);
        i += m[0].length;
        continue;
      }
      text += '&';
      i++;
      continue;
    }
    if (ch === '{') {
      if (src[i + 1] === '{') {
        const end = codeEnd(src, i + 2);
        if (end !== -1) {
          flush();
          out.push({ t: 'code', src: src.slice(i + 2, end), raw: src.slice(i, end + 2) });
          i = end + 2;
          continue;
        }
      }
      BRACE.lastIndex = i;
      const brace = BRACE.exec(src);
      if (brace) {
        flush();
        out.push({ t: 'delim', c: brace[1] as string, open: true, close: true, raw: brace[0] });
        i += 3;
        continue;
      }
      COLOR.lastIndex = i;
      const color = COLOR.exec(src);
      if (color) {
        const value = color[1]?.trim();
        if (value === undefined) {
          flush();
          out.push({ t: 'colorClose', raw: color[0] });
          i += color[0].length;
          continue;
        }
        if (SAFE_COLOR.test(value)) {
          flush();
          out.push({ t: 'colorOpen', color: value, raw: color[0] });
          i += color[0].length;
          continue;
        }
      }
      text += ch;
      i++;
      continue;
    }
    if (ch === '[') {
      const end = bracketEnd(src, i + 1);
      if (end !== -1) {
        flush();
        out.push({ t: 'link', src: src.slice(i + 1, end), raw: src.slice(i, end + 1) });
        i = end + 1;
        continue;
      }
      text += ch;
      i++;
      continue;
    }
    if (ch === '!') {
      IMAGE.lastIndex = i;
      const m = IMAGE.exec(src);
      if (m) {
        flush();
        out.push({ t: 'image', src: m[1] as string, raw: m[0] });
        i += m[0].length;
        continue;
      }
      text += ch;
      i++;
      continue;
    }
    if (DELIMS.includes(ch)) {
      let k = 1;
      while (src[i + k] === ch) k++;
      if (k >= 2) {
        // A run of the same marker (`--`, `**`) is text.
        text += ch.repeat(k);
        i += k;
        continue;
      }
      const prev = cls(pointBefore(src, i));
      const next = cls(pointAt(src, i + 1));
      const open = opens(prev, next);
      const close = closes(prev, next);
      if (open || close) {
        flush();
        out.push({ t: 'delim', c: ch, open, close, raw: ch });
      } else {
        text += ch;
      }
      i++;
      continue;
    }
    const point = pointAt(src, i) as string;
    text += point;
    i += point.length;
  }
  flush();
  return out;
}

function inlineIn(src: string, marks: readonly MarkJson[] = [], inLink = false): PmJson[] {
  const tokens = tokenize(src);
  const n = tokens.length;
  // For each marker, the nearest token at or after an index that can close it.
  const nearest = new Map<string, Int32Array>();
  for (const key of [...DELIMS, 'color']) {
    const arr = new Int32Array(n + 1).fill(n);
    for (let i = n - 1; i >= 0; i--) {
      const tok = tokens[i] as Tok;
      const hit =
        key === 'color' ? tok.t === 'colorClose' : tok.t === 'delim' && tok.c === key && tok.close;
      arr[i] = hit ? i : (arr[i + 1] as number);
    }
    nearest.set(key, arr);
  }
  return parseRange(tokens, nearest, 0, n, marks, inLink);
}

function parseRange(
  tokens: Tok[],
  nearest: Map<string, Int32Array>,
  from: number,
  to: number,
  marks: readonly MarkJson[],
  inLink: boolean,
): PmJson[] {
  const out: PmJson[] = [];
  const n = tokens.length;
  const text = (v: string, with_: readonly MarkJson[] = marks) => {
    if (v === '') return;
    if (inLink || with_.some((m) => m.type === 'link' || m.type === 'code')) {
      out.push(textNode(v, with_));
    } else {
      out.push(...autolinks(v, with_));
    }
  };
  let i = from;
  while (i < to) {
    const tok = tokens[i] as Tok;
    if (tok.t === 'delim' && tok.open) {
      const j = (nearest.get(tok.c) as Int32Array)[Math.min(i + 2, n)] as number;
      if (j < to) {
        out.push(
          ...parseRange(
            tokens,
            nearest,
            i + 1,
            j,
            withMark(marks, MARK_OF[tok.c] as MarkJson),
            inLink,
          ),
        );
        i = j + 1;
        continue;
      }
    }
    if (tok.t === 'colorOpen') {
      const j = (nearest.get('color') as Int32Array)[Math.min(i + 2, n)] as number;
      if (j < to) {
        const mark = { type: 'textColor', attrs: { color: tok.color } };
        out.push(...parseRange(tokens, nearest, i + 1, j, withMark(marks, mark), inLink));
        i = j + 1;
        continue;
      }
    }
    switch (tok.t) {
      case 'text':
        text(tok.v);
        break;
      case 'br':
        out.push({ type: 'hardBreak' });
        break;
      case 'code':
        out.push(...codeIn(tok.src, marks));
        break;
      case 'link':
        out.push(...linkIn(tok.src, marks));
        break;
      case 'image':
        if (isSafeHref(tok.src)) out.push(textNode(tok.src, withMark(marks, linkMark(tok.src))));
        else text(tok.src);
        break;
      default:
        text(tok.raw);
    }
    i++;
  }
  return out;
}

function textNode(text: string, marks: readonly MarkJson[]): PmJson {
  return marks.length > 0 ? { type: 'text', text, marks: [...marks] } : { type: 'text', text };
}

function linkMark(href: string): MarkJson {
  return { type: 'link', attrs: { href, target: null, rel: null, class: null } };
}

/** Marks with one more; an inner mark of a type already there replaces the outer one. */
function withMark(marks: readonly MarkJson[], mark: MarkJson): MarkJson[] {
  return [...marks.filter((m) => m.type !== mark.type), mark];
}

/** Monospace holds no other mark, except that linked monospace reads as linked text. */
function codeIn(src: string, marks: readonly MarkJson[]): PmJson[] {
  return inlineIn(src, marks, true).map((node) => {
    if (node.type !== 'text') return node;
    const linked = (node.marks ?? []).some((m) => m.type === 'link');
    return linked ? node : { type: 'text', text: node.text ?? '', marks: [{ type: 'code' }] };
  });
}

/** Whether `[text]` names an address rather than being text in brackets. */
function looksLikeAddress(text: string): boolean {
  return /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/|#)/.test(text);
}

function linkIn(src: string, marks: readonly MarkJson[]): PmJson[] {
  if (src.startsWith('~')) {
    let id = src.slice(1).trim();
    if (/^accountid:/i.test(id)) id = id.slice('accountid:'.length).trim();
    if (MENTION_ID.test(id)) return [{ type: 'mention', attrs: { id, label: null } }];
  }
  if (src.startsWith('^') && src.length > 1) return inlineIn(src.slice(1), marks);
  const bar = aliasEnd(src);
  if (bar === -1) {
    const href = src.trim();
    if (shorthand(href)) {
      return [textNode(href, withMark(marks, linkMark(href)))];
    }
    return [textNode('[', marks), ...inlineIn(src, marks), textNode(']', marks)];
  }
  const alias = src.slice(0, bar);
  // Encoded the way the writer encodes it, so the address reads back the same each time.
  const href = encodeHref((src.slice(bar + 1).split('|')[0] ?? '').trim());
  if (href === '' || !isSafeHref(href)) return inlineIn(alias, marks);
  const linked = withMark(marks, linkMark(href));
  if (alias === '') return [textNode(href, linked)];
  return inlineIn(alias, linked, true);
}

/** The first `|` in a link that is not escaped or inside monospace, or -1. */
function aliasEnd(src: string): number {
  for (let j = 0; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === '{' && src[j + 1] === '{') {
      const end = codeEnd(src, j + 2);
      if (end !== -1) j = end + 1;
    } else if (src[j] === '|') return j;
  }
  return -1;
}

const ADDRESS = /(?<![\p{L}\p{N}])(?:https?:\/\/|mailto:)[^\s<>"[\]{}|\\^`]+/giu;

/** Web and email addresses in text become links, the way the markup's renderers show them. */
function autolinks(text: string, marks: readonly MarkJson[]): PmJson[] {
  const out: PmJson[] = [];
  let at = 0;
  for (const m of text.matchAll(ADDRESS)) {
    let href = m[0];
    href = href.replace(/[.,;:!?'"]+$/, '');
    if (href.endsWith(')') && (href.match(/\(/g)?.length ?? 0) < (href.match(/\)/g)?.length ?? 0)) {
      href = href.slice(0, -1);
    }
    if (!/^(?:https?:\/\/.+|mailto:.+)/i.test(href)) continue;
    const start = m.index as number;
    if (start > at) out.push(textNode(text.slice(at, start), marks));
    out.push(textNode(href, withMark(marks, linkMark(href))));
    at = start + href.length;
  }
  if (at < text.length) out.push(textNode(text.slice(at), marks));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Plain text

/**
 * A document's text without formatting, for exports and ETL (API-011 (2)): blocks separated by
 * blank lines, one line per list item (nested ones indented), table cells separated by tabs.
 */
export function toPlainText(doc: PmJson): string {
  if (doc.type !== 'doc') throw new Error(`Expected a doc node, got "${doc.type}"`);
  const out: string[] = [];
  plainBlocks(doc.content ?? [], out);
  return out.filter((s) => s !== '').join('\n\n');
}

function plainBlocks(nodes: readonly PmJson[], out: string[]): void {
  for (const n of nodes) {
    switch (n.type) {
      case 'paragraph':
      case 'heading':
        out.push(plainInline(n.content ?? []));
        break;
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        out.push(plainList(n, '').join('\n'));
        break;
      case 'codeBlock':
        out.push((n.content ?? []).map((t) => t.text ?? '').join(''));
        break;
      case 'table':
        out.push(
          (n.content ?? [])
            .map((row) =>
              (row.content ?? [])
                .map((cell) => {
                  const parts: string[] = [];
                  plainBlocks(cell.content ?? [], parts);
                  return parts.filter((s) => s !== '').join(' ');
                })
                .join('\t'),
            )
            .join('\n'),
        );
        break;
      case 'unknownBlock':
        plainBlocks(readableBlocks(n.attrs?.adf as AdfNode | null), out);
        break;
      case 'attachmentRef':
        out.push(String(n.attrs?.name ?? ''));
        break;
      case 'expand':
        out.push(String(n.attrs?.title ?? ''));
        plainBlocks(n.content ?? [], out);
        break;
      case 'horizontalRule':
        break;
      default:
        plainBlocks(n.content ?? [], out);
    }
  }
}

function plainList(list: PmJson, indent: string): string[] {
  const lines: string[] = [];
  for (const item of list.content ?? []) {
    const parts: string[] = [];
    const nested: PmJson[] = [];
    for (const block of item.content ?? []) {
      if (isList(block)) nested.push(block);
      else plainBlocks([block], parts);
    }
    lines.push(indent + parts.filter((s) => s !== '').join(' '));
    for (const block of nested) lines.push(...plainList(block, `${indent}  `));
  }
  return lines;
}

function plainInline(nodes: readonly PmJson[]): string {
  return nodes
    .map((n) => {
      const a = n.attrs ?? {};
      switch (n.type) {
        case 'text':
          return n.text ?? '';
        case 'hardBreak':
          return '\n';
        case 'mention':
          return `@${String(a.label ?? a.id ?? '')}`;
        case 'emoji':
          return typeof a.text === 'string' && a.text !== '' ? a.text : String(a.shortName ?? '');
        case 'date':
          return dayOf(String(a.timestamp ?? ''));
        case 'status':
          return String(a.text ?? '');
        case 'ticketRef':
          return String(a.key ?? '');
        case 'unknownInline': {
          const adf = a.adf as AdfNode | null;
          const text = adf?.text ?? adf?.attrs?.text ?? adf?.attrs?.url;
          return typeof text === 'string' ? text : '';
        }
        default:
          return '';
      }
    })
    .join('');
}
