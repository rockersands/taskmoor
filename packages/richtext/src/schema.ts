import { type AnyExtension, Extension, getSchema, Mark, Node } from '@tiptap/core';
import Mention, { type MentionOptions } from '@tiptap/extension-mention';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TaskItem, { type TaskItemOptions } from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import type { Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { TICKET_KEY } from './adf';

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
      parseHTML: (element: unknown) =>
        (element as DomElement).querySelector('summary')?.textContent ?? '',
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

/** Blocks side by side (NTF-014): columns of equal width on a screen wide enough for them. */
const ColumnLayout = Node.create({
  name: 'columnLayout',
  group: 'block',
  content: 'column+',
  defining: true,
  parseHTML: () => [{ tag: 'div[data-columns]' }],
  renderHTML: () => ['div', { 'data-columns': '' }, 0],
});

const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  // The width the other format gave it: kept for export, not shown.
  addAttributes: () => ({ width: { default: null, rendered: false } }),
  parseHTML: () => [{ tag: 'div[data-column]' }],
  renderHTML: () => ['div', { 'data-column': '' }, 0],
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
  }),
  parseHTML: () => [
    {
      tag: 'div[data-attachment-ref]',
      getAttrs: (element: unknown) => ({
        name: (element as DomElement).getAttribute('data-attachment-ref') ?? '',
        image: (element as DomElement).getAttribute('data-image') === 'true',
      }),
    },
  ],
  renderHTML: ({ node }) => [
    'div',
    {
      'data-attachment-ref': String(node.attrs.name ?? ''),
      ...(node.attrs.image ? { 'data-image': 'true' } : {}),
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
}

/** The schema's extensions, set up for an editor. */
export function editorExtensions(options: EditorOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      codeBlock: { defaultLanguage: null },
      link: { openOnClick: false },
      ...(options.undoRedo === false ? { undoRedo: false as const } : {}),
    }),
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
