import { MAX_COLUMNS, type PmJson, shownColumnWidth } from '@taskmoor/richtext';
import type { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { isInTable, selectedRect } from '@tiptap/pm/tables';
import type { MessageId } from '../i18n/messages.en';
import type { EditorTools } from './EditorTools';
import type { IconName } from './icons';

/**
 * Asks for what a block needs before it goes in: its language, a person's words, a file; or, for
 * the columns the caret is in, their widths.
 */
export type BlockPromptKind =
  | 'code'
  | 'emoji'
  | 'date'
  | 'status'
  | 'attachment'
  | 'ticket'
  | 'columns';

export interface SlashContext {
  tools: EditorTools;
  hasMentions: boolean;
  openPrompt: (kind: BlockPromptKind) => void;
  openLink: () => void;
  /** After a collapsible section went in: its title is the next thing to write. */
  focusTitle: () => void;
}

/** One entry of the menu that "/" opens (NTF-013). The list and its order are our own. */
export interface SlashTool {
  id: string;
  label: MessageId;
  values?: Record<string, string | number>;
  /** More words that find it, in no one language: what people type for it. */
  keywords: string;
  icon?: IconName;
  available?: (editor: Editor, context: SlashContext) => boolean;
  run: (editor: Editor, context: SlashContext) => void;
}

const chain = (editor: Editor) => editor.chain().focus();
const paragraph: PmJson = { type: 'paragraph' };

const heading = (level: 1 | 2 | 3 | 4 | 5 | 6): SlashTool => ({
  id: `heading${level}`,
  label: 'richtext.slash.heading',
  values: { level },
  keywords: `h${level} heading title`,
  ...(level === 2 || level === 3 ? { icon: `heading${level}` as IconName } : {}),
  run: (e) => chain(e).setHeading({ level }).run(),
});

const panel = (type: string, label: MessageId, keywords: string): SlashTool => ({
  id: `panel-${type}`,
  label,
  keywords: `panel callout ${keywords}`,
  run: (e) => chain(e).wrapIn('panel', { panelType: type }).run(),
});

const columns = (count: 2 | 3, label: MessageId): SlashTool => ({
  id: `columns-${count}`,
  label,
  keywords: 'columns layout side',
  available: (e) => !e.isActive('column'),
  run: (e) => {
    const from = e.state.selection.from;
    chain(e)
      .insertContent({
        type: 'columnLayout',
        content: Array.from({ length: count }, () => ({ type: 'column', content: [paragraph] })),
      })
      .run();
    // Writing goes on in the first column of what went in, not after it.
    let caret: number | null = null;
    e.state.doc.descendants((node, position) => {
      if (caret === null && node.type.name === 'column' && position >= from - 2) {
        caret = position + 2;
      }
      return caret === null;
    });
    if (caret !== null) e.commands.setTextSelection(caret);
  },
});

/**
 * Whether the row or column the caret is in (every one a selection of cells spans) can go: not
 * when that is all the table has, which would leave no table; Delete the table does that (T-120).
 */
export function tableLineDeletable(state: EditorState, line: 'row' | 'column'): boolean {
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  return line === 'row'
    ? rect.top > 0 || rect.bottom < rect.map.height
    : rect.left > 0 || rect.right < rect.map.width;
}

/** An edit of the table the caret is in, as the toolbar offers it there (T-120). */
const tableEdit = (
  id: string,
  label: MessageId,
  icon: IconName,
  keywords: string,
  run: (editor: Editor) => void,
  available: (editor: Editor) => boolean = (e) => e.isActive('table'),
): SlashTool => ({ id, label, icon, keywords: `table ${keywords}`, available, run });

export const SLASH_TOOLS: readonly SlashTool[] = [
  {
    id: 'paragraph',
    label: 'richtext.slash.paragraph',
    keywords: 'text plain',
    run: (e) => chain(e).setParagraph().run(),
  },
  heading(1),
  heading(2),
  heading(3),
  heading(4),
  heading(5),
  heading(6),
  {
    id: 'bulletList',
    label: 'richtext.bulletList',
    icon: 'bulletList',
    keywords: 'list ul bullet',
    run: (e) => chain(e).toggleBulletList().run(),
  },
  {
    id: 'orderedList',
    label: 'richtext.orderedList',
    icon: 'orderedList',
    keywords: 'list ol number',
    run: (e) => chain(e).toggleOrderedList().run(),
  },
  {
    id: 'taskList',
    label: 'richtext.taskList',
    icon: 'taskList',
    keywords: 'list todo check task',
    run: (e) => chain(e).toggleTaskList().run(),
  },
  {
    id: 'blockquote',
    label: 'richtext.blockquote',
    icon: 'blockquote',
    keywords: 'quote',
    run: (e) => chain(e).toggleBlockquote().run(),
  },
  {
    id: 'codeBlock',
    label: 'richtext.codeBlock',
    icon: 'codeBlock',
    keywords: 'code snippet language',
    run: (_e, context) => context.openPrompt('code'),
  },
  panel('info', 'richtext.slash.panel.info', 'info information'),
  panel('note', 'richtext.slash.panel.note', 'note'),
  panel('warning', 'richtext.slash.panel.warning', 'warning caution'),
  panel('success', 'richtext.slash.panel.success', 'success ok'),
  panel('error', 'richtext.slash.panel.error', 'error danger'),
  {
    id: 'expand',
    label: 'richtext.slash.expand',
    keywords: 'expand collapse collapsible details toggle',
    available: (e) => !e.isActive('expand'),
    run: (e, context) => {
      chain(e)
        .insertContent({ type: 'expand', attrs: { title: '' }, content: [paragraph] })
        .run();
      context.focusTitle();
    },
  },
  columns(2, 'richtext.slash.columns2'),
  columns(3, 'richtext.slash.columns3'),
  {
    id: 'columnWidths',
    label: 'richtext.slash.columnWidths',
    keywords: 'columns width wide narrow layout size',
    available: (e) => e.isActive('column'),
    run: (_e, context) => context.openPrompt('columns'),
  },
  {
    id: 'table',
    label: 'richtext.table',
    icon: 'table',
    keywords: 'table grid',
    available: (e) => !e.isActive('table'),
    run: (e) => chain(e).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  tableEdit('tableAddRow', 'richtext.table.addRow', 'addRow', 'row add insert below', (e) =>
    chain(e).addRowAfter().run(),
  ),
  tableEdit(
    'tableAddColumn',
    'richtext.table.addColumn',
    'addColumn',
    'column add insert right',
    (e) => chain(e).addColumnAfter().run(),
  ),
  tableEdit(
    'tableDeleteRow',
    'richtext.table.deleteRow',
    'deleteRow',
    'row delete remove',
    (e) => chain(e).deleteRow().run(),
    (e) => tableLineDeletable(e.state, 'row'),
  ),
  tableEdit(
    'tableDeleteColumn',
    'richtext.table.deleteColumn',
    'deleteColumn',
    'column delete remove',
    (e) => chain(e).deleteColumn().run(),
    (e) => tableLineDeletable(e.state, 'column'),
  ),
  tableEdit('tableDelete', 'richtext.table.delete', 'deleteTable', 'delete remove', (e) =>
    chain(e).deleteTable().run(),
  ),
  {
    id: 'rule',
    label: 'richtext.rule',
    icon: 'rule',
    keywords: 'divider rule line separator',
    run: (e) => chain(e).setHorizontalRule().run(),
  },
  {
    id: 'link',
    label: 'richtext.link',
    icon: 'link',
    keywords: 'link url address',
    run: (_e, context) => context.openLink(),
  },
  {
    id: 'mention',
    label: 'richtext.mention',
    icon: 'mention',
    keywords: 'mention person people user',
    available: (_e, context) => context.hasMentions,
    run: (e) => chain(e).insertContent('@').run(),
  },
  {
    id: 'ticket',
    label: 'richtext.slash.ticket',
    keywords: 'ticket reference issue key',
    available: (_e, context) => Boolean(context.tools.tickets),
    run: (_e, context) => context.openPrompt('ticket'),
  },
  {
    id: 'attachment',
    label: 'richtext.slash.attachment',
    keywords: 'image picture file attachment',
    available: (_e, context) => Boolean(context.tools.attachments),
    run: (_e, context) => context.openPrompt('attachment'),
  },
  {
    id: 'emoji',
    label: 'richtext.slash.emoji',
    keywords: 'emoji smile',
    run: (_e, context) => context.openPrompt('emoji'),
  },
  {
    id: 'date',
    label: 'richtext.slash.date',
    keywords: 'date day calendar',
    run: (_e, context) => context.openPrompt('date'),
  },
  {
    id: 'status',
    label: 'richtext.slash.status',
    keywords: 'status label lozenge',
    run: (_e, context) => context.openPrompt('status'),
  },
];

/** Case and accents do not matter when searching. */
const folded = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The tools for what was typed after "/", by their name in the reader's language and keywords. */
export function matchingTools(
  tools: readonly SlashTool[],
  query: string,
  label: (tool: SlashTool) => string,
): SlashTool[] {
  const wanted = folded(query.trim());
  if (wanted === '') return [...tools];
  return tools.filter((tool) => folded(`${label(tool)} ${tool.keywords}`).includes(wanted));
}

/** A language a code block's prompt offers (TT-8): the word that goes in, and its usual name. */
export interface CodeLanguage {
  id: string;
  name: string;
}

/**
 * Languages people often write code in, alphabetically. Any other one word still goes in; the
 * names are the languages' own, the same in every locale.
 */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  { id: 'bash', name: 'Bash' },
  { id: 'c', name: 'C' },
  { id: 'cpp', name: 'C++' },
  { id: 'csharp', name: 'C#' },
  { id: 'css', name: 'CSS' },
  { id: 'dart', name: 'Dart' },
  { id: 'diff', name: 'Diff' },
  { id: 'dockerfile', name: 'Dockerfile' },
  { id: 'go', name: 'Go' },
  { id: 'graphql', name: 'GraphQL' },
  { id: 'html', name: 'HTML' },
  { id: 'java', name: 'Java' },
  { id: 'javascript', name: 'JavaScript' },
  { id: 'json', name: 'JSON' },
  { id: 'kotlin', name: 'Kotlin' },
  { id: 'lua', name: 'Lua' },
  { id: 'markdown', name: 'Markdown' },
  { id: 'php', name: 'PHP' },
  { id: 'powershell', name: 'PowerShell' },
  { id: 'python', name: 'Python' },
  { id: 'r', name: 'R' },
  { id: 'ruby', name: 'Ruby' },
  { id: 'rust', name: 'Rust' },
  { id: 'scala', name: 'Scala' },
  { id: 'shell', name: 'Shell' },
  { id: 'sql', name: 'SQL' },
  { id: 'swift', name: 'Swift' },
  { id: 'typescript', name: 'TypeScript' },
  { id: 'xml', name: 'XML' },
  { id: 'yaml', name: 'YAML' },
];

/**
 * The languages for what was typed: by word or name, those that start with it first. Nothing
 * typed lists them all.
 */
export function matchingLanguages(
  languages: readonly CodeLanguage[],
  typed: string,
): CodeLanguage[] {
  const wanted = folded(typed.trim());
  if (wanted === '') return [...languages];
  const found = languages.filter((l) => folded(`${l.id} ${l.name}`).includes(wanted));
  const starts = (l: CodeLanguage) =>
    folded(l.id).startsWith(wanted) || folded(l.name).startsWith(wanted);
  return [...found.filter(starts), ...found.filter((l) => !starts(l))];
}

/** The columns the caret is in: where their layout starts, and each column's width. */
export function columnLayoutAt(
  state: EditorState,
): { pos: number; widths: (number | null)[] } | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== 'columnLayout') continue;
    const widths: (number | null)[] = [];
    node.forEach((column) => {
      widths.push(shownColumnWidth(column.attrs.width));
    });
    return { pos: $from.before(depth), widths };
  }
  return null;
}

/** Shares a layout of this many columns offers besides equal ones, as percentages. */
const SHARES: Record<number, number[][]> = {
  2: [
    [33.33, 66.67],
    [66.67, 33.33],
    [25, 75],
    [75, 25],
  ],
  3: [
    [25, 50, 25],
    [50, 25, 25],
    [25, 25, 50],
  ],
};

/**
 * The widths the prompt offers for a layout (TT-2): its widths now first when they are not one of
 * the others, then equal columns (null widths), then the shares for its number of columns.
 */
export function widthPresets(now: readonly (number | null)[]): (number | null)[][] {
  const count = Math.min(Math.max(now.length, 1), MAX_COLUMNS);
  const equal: (number | null)[] = Array.from({ length: count }, () => null);
  const presets = [equal, ...(SHARES[count] ?? [])];
  const shown = now.some((w) => w !== null) && now.every((w) => w !== null);
  return shown && !presets.some((p) => sameWidths(p, now)) ? [[...now], ...presets] : presets;
}

/** Whether two layouts' widths are the same, column by column. */
export const sameWidths = (a: readonly (number | null)[], b: readonly (number | null)[]) =>
  a.length === b.length && a.every((w, i) => w === b[i]);

/**
 * Which of the offered widths a layout has now: those it shows, or equal columns when it shows
 * none (some columns without a width also lay out equal).
 */
export function currentPreset(
  presets: readonly (readonly (number | null)[])[],
  now: readonly (number | null)[],
): number {
  const at = presets.findIndex((p) => sameWidths(p, now));
  return at >= 0 ? at : 0;
}

/**
 * Sets every column of the layout at `pos` in one step, so undo takes it back at once and the
 * others editing see one change.
 */
export function setColumnWidths(
  editor: Editor,
  pos: number,
  widths: readonly (number | null)[],
): void {
  const layout = editor.state.doc.nodeAt(pos);
  if (layout?.type.name !== 'columnLayout') return;
  const tr = editor.state.tr;
  layout.forEach((column, offset, index) => {
    const width = widths[index] ?? null;
    if (column.attrs.width === width) return;
    tr.setNodeMarkup(pos + 1 + offset, undefined, { ...column.attrs, width });
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}

/** Emoji the picker offers: common ones, each with a name in the catalogue. */
export const EMOJI: readonly { text: string; shortName: string; label: MessageId }[] = [
  { text: '🙂', shortName: ':smile:', label: 'richtext.emoji.smile' },
  { text: '😂', shortName: ':joy:', label: 'richtext.emoji.joy' },
  { text: '🤔', shortName: ':thinking:', label: 'richtext.emoji.thinking' },
  { text: '🎉', shortName: ':tada:', label: 'richtext.emoji.tada' },
  { text: '👍', shortName: ':thumbsup:', label: 'richtext.emoji.thumbsUp' },
  { text: '👎', shortName: ':thumbsdown:', label: 'richtext.emoji.thumbsDown' },
  { text: '✅', shortName: ':white_check_mark:', label: 'richtext.emoji.check' },
  { text: '❌', shortName: ':x:', label: 'richtext.emoji.cross' },
  { text: '⚠️', shortName: ':warning:', label: 'richtext.emoji.warning' },
  { text: '🔥', shortName: ':fire:', label: 'richtext.emoji.fire' },
  { text: '🚀', shortName: ':rocket:', label: 'richtext.emoji.rocket' },
  { text: '🐛', shortName: ':bug:', label: 'richtext.emoji.bug' },
  { text: '💡', shortName: ':bulb:', label: 'richtext.emoji.idea' },
  { text: '📌', shortName: ':pushpin:', label: 'richtext.emoji.pin' },
  { text: '⏳', shortName: ':hourglass_flowing_sand:', label: 'richtext.emoji.waiting' },
  { text: '❤️', shortName: ':heart:', label: 'richtext.emoji.heart' },
];

/** Colours a status label may take, from the format's own list. */
export const STATUS_COLORS: readonly { color: string; label: MessageId }[] = [
  { color: 'neutral', label: 'richtext.status.neutral' },
  { color: 'blue', label: 'richtext.status.blue' },
  { color: 'green', label: 'richtext.status.green' },
  { color: 'yellow', label: 'richtext.status.yellow' },
  { color: 'red', label: 'richtext.status.red' },
  { color: 'purple', label: 'richtext.status.purple' },
];
