import type { PmJson } from '@taskmoor/richtext';
import type { Editor } from '@tiptap/core';
import type { MessageId } from '../i18n/messages.en';
import type { EditorTools } from './EditorTools';
import type { IconName } from './icons';

/** Asks for what a block needs before it goes in: its language, a person's words, a file. */
export type BlockPromptKind = 'code' | 'emoji' | 'date' | 'status' | 'attachment' | 'ticket';

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
    id: 'table',
    label: 'richtext.table',
    icon: 'table',
    keywords: 'table grid',
    available: (e) => !e.isActive('table'),
    run: (e) => chain(e).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
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
