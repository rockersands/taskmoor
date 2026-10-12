import { Extension, getSchema, Mark, Node } from '@tiptap/core';
import Mention from '@tiptap/extension-mention';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import type { Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';

/**
 * The document schema shared by the editor, the server and the importer. Everything the
 * Jira-compatible format can express maps onto it; node types we do not render yet are kept
 * whole in `unknownBlock` and `unknownInline`, so nothing is lost on a round trip.
 */

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
  addAttributes: () => ({ timestamp: { default: '' } }),
  parseHTML: () => [{ tag: 'time[data-date]' }],
  renderHTML: ({ HTMLAttributes }) => ['time', { 'data-date': HTMLAttributes.timestamp }],
});

const Emoji = Node.create({
  name: 'emoji',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({ shortName: { default: '' }, text: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-emoji]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'span',
    { 'data-emoji': HTMLAttributes.shortName },
    HTMLAttributes.text ?? '',
  ],
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
] as const;

export const MARK_TYPES_WITH_ADF_ATTRS = ['link', 'textColor', 'subsup'] as const;

const AdfAttrs = Extension.create({
  name: 'adfAttrs',
  addGlobalAttributes: () => [
    { types: [...NODE_TYPES_WITH_ADF_ATTRS, ...MARK_TYPES_WITH_ADF_ATTRS], attributes: ADF_ATTRS },
  ],
});

export const extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    codeBlock: { defaultLanguage: null },
    link: { openOnClick: false },
  }),
  Mention,
  Table,
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItem.configure({ nested: true }),
  Panel,
  Status,
  DateNode,
  Emoji,
  UnknownBlock,
  UnknownInline,
  TextColor,
  SubSup,
  UnknownMark,
  AdfAttrs,
];

export const schema: Schema = getSchema(extensions);
