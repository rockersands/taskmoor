import { type AnyExtension, Extension, getSchema, Mark, Node } from '@tiptap/core';
import Mention, { type MentionOptions } from '@tiptap/extension-mention';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TaskItem, { type TaskItemOptions } from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import type { Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { columnTracks, expandTitleLine, isAttachmentDigest, TICKET_KEY } from './adf';

/**
 * The document schema shared by the editor, the server and the importer. Everything the
 * Jira-compatible format can express maps onto it; node types we do not render yet are kept
 * whole in `unknownBlock` and `unknownInline`, so nothing is lost on a round trip.
 */

/** What pasted HTML is read through; this package runs on the server too, without the DOM's types. */
interface DomElement {
  getAttribute(name: string): string | null;
  querySelector(selector: string): { textContent: string | null } | null;
}

/** Original attributes of an imported node or mark, kept so exports stay faithful. */
const ADF_ATTRS = { adfAttrs: { default: null, rendered: false } };

const Panel = Node.create({
  name: 'panel',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes: () => ({ panelType: { default: 'info' } }),
  parseHTML: () => [{ tag: 'div[data-panel]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-panel': HTMLAttributes.panelType }, 0],
});

const Status = Node.create({
  name: 'status',
  group: 'inline',
  inline: true,
  atom: true,
  marks: '',
  addAttributes: () => ({ text: { default: '' }, color: { default: 'neutral' } }),
  parseHTML: () => [{ tag: 'span[data-status]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'span',
    { 'data-status': HTMLAttributes.color },
    HTMLAttributes.text,
  ],
});

const DateNode = Node.create({
  name: 'date',
  group: 'inline',
  inline: true,
  atom: true,
  marks: '',
  addAttributes: () => ({ timestamp: { default: '' } }),
  parseHTML: () => [{ tag: 'time[data-date]' }],
  renderHTML: ({ HTMLAttributes }) => ['time', { 'data-date': HTMLAttributes.timestamp }],
});

const Emoji = Node.create({
  name: 'emoji',
  group: 'inline',
  inline: true,
  atom: true,
  marks: '',
  addAttributes: () => ({ shortName: { default: '' }, text: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-emoji]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'span',
    { 'data-emoji': HTMLAttributes.shortName },
    HTMLAttributes.text ?? '',
  ],
});

/**
 * A collapsible section (NTF-014): a title and blocks, shown as the browser's own disclosure
 * element wherever a document is only read.
 */
const Expand = Node.create({
  name: 'expand',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes: () => ({
    title: {
      default: '',
      rendered: false,
      // One line within the length, as the editor's title field and the Markdown reader keep it:
      // pasted control characters would have the document refused on save.
      parseHTML: (element: unknown) =>
        expandTitleLine((element as DomElement).querySelector('summary')?.textContent ?? ''),
    },
  }),
  parseHTML: () => [{ tag: 'details[data-expand]', contentElement: 'div[data-expand-body]' }],
  renderHTML: ({ node }) => [
    'details',
    { 'data-expand': '' },
    ['summary', {}, String(node.attrs.title ?? '')],
    ['div', { 'data-expand-body': '' }, 0],
  ],
});

/**
 * Blocks side by side (NTF-014) on a screen wide enough for them, one under the other on a
 * narrow one. Columns are equal unless every one has a width (ADR-120, TT-2): then the layout's
 * `--rt-columns` property, made from those numbers only, sets their shares.
 */
const ColumnLayout = Node.create({
  name: 'columnLayout',
  group: 'block',
  content: 'column+',
  defining: true,
  parseHTML: () => [{ tag: 'div[data-columns]' }],
  renderHTML: ({ node }) => {
    const widths: unknown[] = [];
    node.forEach((column) => {
      widths.push(column.attrs.width);
    });
    const tracks = columnTracks(widths);
    return [
      'div',
      { 'data-columns': '', ...(tracks ? { style: `--rt-columns: ${tracks}` } : {}) },
      0,
    ];
  },
});

const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  // A percentage, as the other format holds it; the layout shows it (see `ColumnLayout`).
  addAttributes: () => ({
    width: {
      default: null,
      rendered: false,
      parseHTML: (element: unknown) => {
        const value = Number((element as DomElement).getAttribute('data-width') ?? Number.NaN);
        return Number.isFinite(value) ? value : null;
      },
    },
  }),
  parseHTML: () => [{ tag: 'div[data-column]' }],
  renderHTML: ({ node }) => [
    'div',
    {
      'data-column': '',
      ...(typeof node.attrs.width === 'number' ? { 'data-width': String(node.attrs.width) } : {}),
    },
    0,
  ],
});

/**
 * A file of the ticket, by name (NTF-014). The document holds no address: whoever shows it looks
 * the name up among the ticket's attachments, with the reader's rights, so a clone or an import
 * keeps working and nothing in a document can point anywhere else.
 */
const AttachmentRef = Node.create({
  name: 'attachmentRef',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes: () => ({
    name: { default: '', rendered: false },
    image: { default: false, rendered: false },
    // Which of two files of one name (TT-4): the first digits of its SHA-256, or null for the
    // first file of the name.
    digest: { default: null, rendered: false },
    // The other format's media node, when it held more than the file (a size, alt text,
    // marks): kept so an export writes it back, never shown and never read for the file.
    adfMedia: { default: null, rendered: false },
  }),
  parseHTML: () => [
    {
      tag: 'div[data-attachment-ref]',
      getAttrs: (element: unknown) => {
        const digest = (element as DomElement).getAttribute('data-digest');
        return {
          name: (element as DomElement).getAttribute('data-attachment-ref') ?? '',
          image: (element as DomElement).getAttribute('data-image') === 'true',
          digest: isAttachmentDigest(digest) ? digest : null,
        };
      },
    },
  ],
  renderHTML: ({ node }) => [
    'div',
    {
      'data-attachment-ref': String(node.attrs.name ?? ''),
      ...(node.attrs.image ? { 'data-image': 'true' } : {}),
      ...(isAttachmentDigest(node.attrs.digest) ? { 'data-digest': node.attrs.digest } : {}),
    },
    String(node.attrs.name ?? ''),
  ],
});

/** A reference to another ticket by its key (NTF-014); never its summary, which it may hide. */
const TicketRef = Node.create({
  name: 'ticketRef',
  group: 'inline',
  inline: true,
  atom: true,
  marks: '',
  addAttributes: () => ({ key: { default: '', rendered: false } }),
  parseHTML: () => [
    {
      tag: 'a[data-ticket-ref]',
      // Ahead of the link mark's `a[href]` (mark rules come first at equal priority), so a
      // copied, cut or dragged reference comes back as one, not as a link to its address.
      priority: 60,
      getAttrs: (element: unknown) => ({
        key: (element as DomElement).getAttribute('data-ticket-ref') ?? '',
      }),
    },
  ],
  renderHTML: ({ node }) => {
    const key = String(node.attrs.key ?? '');
    return [
      'a',
      {
        'data-ticket-ref': key,
        ...(TICKET_KEY.test(key) ? { href: `#/tickets/${encodeURIComponent(key)}` } : {}),
      },
      key,
    ];
  },
});

/** A block the editor does not understand yet; the whole subtree lives in `adf`. */
const UnknownBlock = Node.create({
  name: 'unknownBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes: () => ({ adf: { default: null } }),
  parseHTML: () => [{ tag: 'div[data-unknown-block]' }],
  renderHTML: () => ['div', { 'data-unknown-block': '' }],
});

const UnknownInline = Node.create({
  name: 'unknownInline',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({ adf: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-unknown-inline]' }],
  renderHTML: () => ['span', { 'data-unknown-inline': '' }],
});

const TextColor = Mark.create({
  name: 'textColor',
  addAttributes: () => ({ color: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-text-color]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', { style: `color: ${HTMLAttributes.color}` }, 0],
});

const SubSup = Mark.create({
  name: 'subsup',
  addAttributes: () => ({ type: { default: 'sub' } }),
  parseHTML: () => [{ tag: 'sub' }, { tag: 'sup' }],
  renderHTML: ({ HTMLAttributes }) => [HTMLAttributes.type === 'sup' ? 'sup' : 'sub', {}, 0],
});

/** A mark the editor does not understand; several may sit on one text run. */
const UnknownMark = Mark.create({
  name: 'unknownMark',
  excludes: '',
  addAttributes: () => ({ type: { default: '' }, attrs: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-unknown-mark]' }],
  renderHTML: () => ['span', { 'data-unknown-mark': '' }, 0],
});

export const NODE_TYPES_WITH_ADF_ATTRS = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'blockquote',
  'horizontalRule',
  'hardBreak',
  'mention',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'taskList',
  'taskItem',
  'panel',
  'status',
  'date',
  'emoji',
  'expand',
  'columnLayout',
  'column',
  'attachmentRef',
  'ticketRef',
] as const;

export const MARK_TYPES_WITH_ADF_ATTRS = ['link', 'textColor', 'subsup'] as const;

const AdfAttrs = Extension.create({
  name: 'adfAttrs',
  addGlobalAttributes: () => [
    { types: [...NODE_TYPES_WITH_ADF_ATTRS, ...MARK_TYPES_WITH_ADF_ATTRS], attributes: ADF_ATTRS },
  ],
});

/**
 * How an editor runs the schema. None of these change the schema: the server, the importer
 * and every editor read and write the same documents.
 */
export interface EditorOptions {
  /** ProseMirror's own undo history; off when Yjs keeps it (collaboration, ADR-014). */
  undoRedo?: boolean;
  /** The mention node's behaviour in an editor: its suggestion popup, how it renders. */
  mention?: Partial<MentionOptions>;
  /** Checklist items in an editor: their checkboxes' accessible names. */
  taskItem?: Partial<TaskItemOptions>;
  /**
   * When an empty paragraph goes in after a last block that is not one, so there is a line to
   * type on below a list, a code block or a table: after any change (`any-change`, the
   * default), or only after the person's own edits (`own-edits`). A collaborative editor needs
   * the second: the document arriving from the server is no edit, and adding the paragraph
   * then would save the ticket for someone who only opened it (T-250).
   */
  trailingParagraph?: 'any-change' | 'own-edits';
}

/**
 * The trailing paragraph of a collaborative editor: added in answer to an edit made in this
 * editor, never to what Yjs brings in (the document as loaded, others' changes, undo).
 */
const OwnTrailingParagraph = Extension.create({
  name: 'ownTrailingParagraph',
  addProseMirrorPlugins: () => [
    new Plugin({
      key: new PluginKey('ownTrailingParagraph'),
      appendTransaction: (transactions, _before, state) => {
        const edited = transactions.some((tr) => tr.docChanged && !tr.getMeta(ySyncPluginKey));
        const last = state.doc.lastChild;
        const paragraph = state.schema.nodes.paragraph;
        if (!edited || !last || !paragraph || last.type === paragraph) return null;
        return state.tr.insert(state.doc.content.size, paragraph.create());
      },
    }),
  ],
});

/** The schema's extensions, set up for an editor. */
export function editorExtensions(options: EditorOptions = {}): AnyExtension[] {
  const ownEdits = options.trailingParagraph === 'own-edits';
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      codeBlock: { defaultLanguage: null },
      link: { openOnClick: false },
      ...(options.undoRedo === false ? { undoRedo: false as const } : {}),
      ...(ownEdits ? { trailingNode: false as const } : {}),
    }),
    ...(ownEdits ? [OwnTrailingParagraph] : []),
    // Inline atoms take no marks: the other format gives them none, and Yjs keeps marks on
    // text only, so a mark on one would not reach the other people editing.
    Mention.extend({ marks: '' }).configure(options.mention ?? {}),
    Table,
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ ...options.taskItem, nested: true }),
    Panel,
    Status,
    DateNode,
    Emoji,
    Expand,
    ColumnLayout,
    Column,
    AttachmentRef,
    TicketRef,
    UnknownBlock,
    UnknownInline,
    TextColor,
    SubSup,
    UnknownMark,
    AdfAttrs,
  ];
}

export const extensions = editorExtensions();

export const schema: Schema = getSchema(extensions);
