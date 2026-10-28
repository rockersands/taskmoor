import {
  editorExtensions,
  fromMarkdown,
  isSafeHref,
  looksLikeMarkdown,
  type PmJson,
} from '@taskmoor/richtext';
import { type AnyExtension, type Editor, Extension, type Node as TiptapNode } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { Icon, type IconName } from './icons';
import type { MentionPerson, MentionSource } from './mentions';

/**
 * The rich text editor (M1-017; NTF-005, NTF-006; ADR-014): Tiptap on the shared schema of
 * `@taskmoor/richtext`, so what it writes is what the server checks and the importer makes.
 *
 * - A toolbar (one tab stop; arrow keys move along it) for marks, headings, lists, checklists,
 *   quotes, code, links, tables and mentions, with the usual shortcuts (Ctrl+B, Ctrl+K for a
 *   link). Markdown shortcuts work as you type (`## `, `- `, `1. `, `[] `, `> `, ```` ``` ````),
 *   and pasted Markdown (a table, say) turns into rich text.
 * - "@" offers people to mention (a listbox the arrow keys walk, Enter or Tab picks); someone
 *   who cannot see the ticket is marked so, and picking them says they will not be told.
 * - Tab indents list items and moves between table cells; Escape leaves the editor, so the
 *   next Tab moves on.
 * - Content the editor cannot show (kept whole from the other format) shows a placeholder and
 *   stays as it is.
 * - With `collaboration`, Yjs holds the document and its undo history (CollaborativeEditor).
 */
export interface RichTextEditorProps {
  /** The element that names the field (its label). */
  labelledBy: string;
  /** Elements that describe it (help, errors). */
  describedBy?: string | undefined;
  required?: boolean;
  invalid?: boolean;
  /** Starting content; the editor is uncontrolled. Ignored when collaborating. */
  initial?: PmJson | null;
  /** Every change, with null for an empty document. */
  onChange?: (doc: PmJson | null) => void;
  /** Where "@" finds people; without it there are no mentions. */
  mentions?: MentionSource | undefined;
  /** False shows the content without editing it. */
  editable?: boolean;
  /** Extensions that make the editor collaborative (they bring their own undo history). */
  collaboration?: AnyExtension[];
  /** Shown above the toolbar's end: presence, save state. */
  status?: ReactNode;
}

interface Suggesting {
  items: MentionPerson[];
  active: number;
  rect: DOMRect | null;
  pick: (person: MentionPerson) => void;
}

/** The document, or null when it is empty. */
export function docOf(editor: Editor): PmJson | null {
  return editor.isEmpty ? null : (editor.getJSON() as PmJson);
}

interface Tool {
  id: string;
  icon: IconName;
  label: MessageId;
  values?: Record<string, string | number>;
  run: (editor: Editor) => void;
  active?: (editor: Editor) => boolean;
  enabled?: (editor: Editor) => boolean;
}

const chain = (editor: Editor) => editor.chain().focus();

const TOOLS: Tool[] = [
  {
    id: 'bold',
    icon: 'bold',
    label: 'richtext.bold',
    run: (e) => chain(e).toggleBold().run(),
    active: (e) => e.isActive('bold'),
  },
  {
    id: 'italic',
    icon: 'italic',
    label: 'richtext.italic',
    run: (e) => chain(e).toggleItalic().run(),
    active: (e) => e.isActive('italic'),
  },
  {
    id: 'strike',
    icon: 'strike',
    label: 'richtext.strike',
    run: (e) => chain(e).toggleStrike().run(),
    active: (e) => e.isActive('strike'),
  },
  {
    id: 'code',
    icon: 'code',
    label: 'richtext.code',
    run: (e) => chain(e).toggleCode().run(),
    active: (e) => e.isActive('code'),
  },
  {
    id: 'heading2',
    icon: 'heading2',
    label: 'richtext.heading',
    values: { level: 2 },
    run: (e) => chain(e).toggleHeading({ level: 2 }).run(),
    active: (e) => e.isActive('heading', { level: 2 }),
  },
  {
    id: 'heading3',
    icon: 'heading3',
    label: 'richtext.heading',
    values: { level: 3 },
    run: (e) => chain(e).toggleHeading({ level: 3 }).run(),
    active: (e) => e.isActive('heading', { level: 3 }),
  },
  {
    id: 'bulletList',
    icon: 'bulletList',
    label: 'richtext.bulletList',
    run: (e) => chain(e).toggleBulletList().run(),
    active: (e) => e.isActive('bulletList'),
  },
  {
    id: 'orderedList',
    icon: 'orderedList',
    label: 'richtext.orderedList',
    run: (e) => chain(e).toggleOrderedList().run(),
    active: (e) => e.isActive('orderedList'),
  },
  {
    id: 'taskList',
    icon: 'taskList',
    label: 'richtext.taskList',
    run: (e) => chain(e).toggleTaskList().run(),
    active: (e) => e.isActive('taskList'),
  },
  {
    id: 'blockquote',
    icon: 'blockquote',
    label: 'richtext.blockquote',
    run: (e) => chain(e).toggleBlockquote().run(),
    active: (e) => e.isActive('blockquote'),
  },
  {
    id: 'codeBlock',
    icon: 'codeBlock',
    label: 'richtext.codeBlock',
    run: (e) => chain(e).toggleCodeBlock().run(),
    active: (e) => e.isActive('codeBlock'),
  },
  {
    id: 'rule',
    icon: 'rule',
    label: 'richtext.rule',
    run: (e) => chain(e).setHorizontalRule().run(),
  },
  {
    id: 'table',
    icon: 'table',
    label: 'richtext.table',
    run: (e) => chain(e).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    enabled: (e) => !e.isActive('table'),
  },
];

const TABLE_TOOLS: Tool[] = [
  {
    id: 'addRow',
    icon: 'addRow',
    label: 'richtext.table.addRow',
    run: (e) => chain(e).addRowAfter().run(),
  },
  {
    id: 'addColumn',
    icon: 'addColumn',
    label: 'richtext.table.addColumn',
    run: (e) => chain(e).addColumnAfter().run(),
  },
  {
    id: 'deleteTable',
    icon: 'deleteTable',
    label: 'richtext.table.delete',
    run: (e) => chain(e).deleteTable().run(),
  },
];

const HISTORY_TOOLS: Tool[] = [
  {
    id: 'undo',
    icon: 'undo',
    label: 'richtext.undo',
    run: (e) => chain(e).undo().run(),
    enabled: (e) => e.can().undo(),
  },
  {
    id: 'redo',
    icon: 'redo',
    label: 'richtext.redo',
    run: (e) => chain(e).redo().run(),
    enabled: (e) => e.can().redo(),
  },
];

/** A link target as typed: a bare host gets https; unsafe schemes are refused. */
export function linkTarget(typed: string): string | null {
  const value = typed.trim();
  if (value === '') return null;
  const withScheme =
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith('/') || value.startsWith('#')
      ? value
      : `https://${value}`;
  return isSafeHref(withScheme) ? withScheme : null;
}

export function RichTextEditor({
  labelledBy,
  describedBy,
  required = false,
  invalid = false,
  initial = null,
  onChange,
  mentions,
  editable = true,
  collaboration,
  status,
}: RichTextEditorProps) {
  const t = useT();
  const { locale } = useIntl();
  const editorId = useId();
  const listboxId = useId();
  const hintId = useId();
  const linkInputId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const exitRef = useRef<HTMLSpanElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [suggesting, setSuggesting] = useState<Suggesting | null>(null);
  const suggestingRef = useRef(suggesting);
  suggestingRef.current = suggesting;
  const mentionsRef = useRef(mentions);
  mentionsRef.current = mentions;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [notice, setNotice] = useState('');
  const [link, setLink] = useState<{ value: string; error: boolean } | null>(null);
  const openLinkRef = useRef<() => void>(() => {});
  const [focusIndex, setFocusIndex] = useState(0);

  const labels = {
    unknownBlock: t('richtext.unknownBlock'),
    unknownInline: t('richtext.unknownInline'),
    warning: (name: string) => t('richtext.mention.warning', { name }),
    checkbox: (text: string) =>
      text === '' ? t('richtext.taskItemEmpty') : t('richtext.taskItem', { text }),
  };
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  // The extensions are fixed for the editor's life; what they call back reads refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is built once
  const extensions = useMemo(() => {
    const base = editorExtensions({
      undoRedo: !collaboration,
      taskItem: { a11y: { checkboxLabel: (node) => labelsRef.current.checkbox(node.textContent) } },
      mention: {
        suggestion: {
          char: '@',
          allow: () => Boolean(mentionsRef.current),
          items: async ({ query }) => {
            const source = mentionsRef.current;
            if (!source) return [];
            try {
              return await source(query);
            } catch {
              return [];
            }
          },
          render: () => {
            const show = (props: {
              items: MentionPerson[];
              clientRect?: (() => DOMRect | null) | null;
              command: (attrs: { id: string; label: string }) => void;
            }) => {
              setSuggesting((now) => ({
                items: props.items,
                active: Math.min(now?.active ?? 0, Math.max(0, props.items.length - 1)),
                rect: props.clientRect?.() ?? null,
                pick: (person) => {
                  props.command({ id: String(person.id), label: person.name });
                  setNotice(person.canView ? '' : labelsRef.current.warning(person.name));
                },
              }));
            };
            return {
              onStart: show,
              onUpdate: show,
              onExit: () => setSuggesting(null),
              onKeyDown: ({ event }) => {
                const now = suggestingRef.current;
                if (!now || now.items.length === 0) return false;
                const count = now.items.length;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  const step = event.key === 'ArrowDown' ? 1 : count - 1;
                  setSuggesting({ ...now, active: (now.active + step) % count });
                  return true;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  const person = now.items[now.active];
                  if (person) now.pick(person);
                  return true;
                }
                return false;
              },
            };
          },
        },
      },
    });
    const shown = base.map((extension) => {
      if (extension.name === 'unknownBlock' || extension.name === 'unknownInline') {
        const block = extension.name === 'unknownBlock';
        return (extension as TiptapNode).extend({
          addNodeView: () => () => {
            const dom = document.createElement(block ? 'div' : 'span');
            dom.className = block ? 'rt-unknown rt-unknown-block' : 'rt-unknown';
            dom.textContent = block
              ? labelsRef.current.unknownBlock
              : labelsRef.current.unknownInline;
            dom.contentEditable = 'false';
            return { dom };
          },
        });
      }
      if (extension.name === 'date') {
        return (extension as TiptapNode).extend({
          addNodeView:
            () =>
            ({ node }) => {
              const dom = document.createElement('time');
              const ms = Number(node.attrs.timestamp);
              const date = Number.isFinite(ms) ? new Date(ms) : null;
              dom.className = 'rt-date';
              dom.textContent =
                date && !Number.isNaN(date.getTime())
                  ? new Intl.DateTimeFormat(locale, {
                      dateStyle: 'medium',
                      timeZone: 'UTC',
                    }).format(date)
                  : String(node.attrs.timestamp);
              if (date && !Number.isNaN(date.getTime())) {
                dom.dateTime = date.toISOString().slice(0, 10);
              }
              return { dom };
            },
        });
      }
      return extension;
    });
    // Ctrl+K for a link; Escape leaves the editor (after the mention list had its turn).
    const keys = Extension.create({
      name: 'taskmoorKeys',
      priority: 50,
      addKeyboardShortcuts: () => ({
        'Mod-k': () => {
          openLinkRef.current();
          return true;
        },
        Escape: () => {
          exitRef.current?.focus();
          return true;
        },
      }),
    });
    return [...shown, keys, ...(collaboration ?? [])];
  }, []);

  const editor = useEditor(
    {
      extensions,
      ...(collaboration ? {} : initial ? { content: initial } : {}),
      editable,
      editorProps: {
        attributes: {
          id: editorId,
          role: 'textbox',
          'aria-multiline': 'true',
          class: 'rt-content',
        },
        // Markdown pasted as plain text becomes rich text (NTF-006 (2)).
        handlePaste: (_view, event) => {
          const text = event.clipboardData?.getData('text/plain') ?? '';
          const html = event.clipboardData?.getData('text/html') ?? '';
          if (html !== '' || !looksLikeMarkdown(text)) return false;
          const content = fromMarkdown(text).content ?? [];
          editorRef.current?.chain().focus().insertContent(content).run();
          return true;
        },
      },
      onUpdate: ({ editor: changed }) => onChangeRef.current?.(docOf(changed)),
    },
    [],
  );
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable, false);
  }, [editor, editable]);

  // Names, descriptions and the mention list on the editable element itself.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    let dom: HTMLElement;
    try {
      dom = editor.view.dom;
    } catch {
      return;
    }
    const set = (name: string, value: string | null) =>
      value === null ? dom.removeAttribute(name) : dom.setAttribute(name, value);
    set('aria-labelledby', labelledBy);
    set(
      'aria-describedby',
      [describedBy, editable ? hintId : null].filter(Boolean).join(' ') || null,
    );
    set('aria-required', required ? 'true' : null);
    set('aria-invalid', invalid ? 'true' : null);
    set('aria-readonly', editable ? null : 'true');
    const open = suggesting !== null && suggesting.items.length > 0;
    set('aria-autocomplete', mentions ? 'list' : null);
    set('aria-controls', open ? listboxId : null);
    set('aria-activedescendant', open ? `${listboxId}-${suggesting.active}` : null);
  }, [
    editor,
    labelledBy,
    describedBy,
    required,
    invalid,
    editable,
    hintId,
    suggesting,
    listboxId,
    mentions,
  ]);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const tools = [
        ...TOOLS,
        ...(e.isActive('table') ? TABLE_TOOLS : []),
        ...(collaboration ? [] : HISTORY_TOOLS),
      ];
      return {
        tools: tools.map((tool) => ({
          id: tool.id,
          active: tool.active ? tool.active(e) : null,
          enabled: tool.enabled ? tool.enabled(e) : true,
        })),
        link: e.isActive('link'),
        href: String(e.getAttributes('link').href ?? ''),
      };
    },
  });

  openLinkRef.current = () => {
    if (!editable) return;
    const href = editorRef.current?.getAttributes('link').href;
    setLink({ value: typeof href === 'string' ? href : '', error: false });
  };

  const applyLink = () => {
    if (!editor || !link) return;
    const href = linkTarget(link.value);
    if (!href) {
      setLink({ ...link, error: true });
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    setLink(null);
  };
  const removeLink = () => {
    editor?.chain().focus().extendMarkRange('link').unsetLink().run();
    setLink(null);
  };
  const closeLink = () => {
    setLink(null);
    editor?.commands.focus();
  };

  const toolById = new Map(
    [...TOOLS, ...TABLE_TOOLS, ...HISTORY_TOOLS].map((tool) => [tool.id, tool]),
  );
  const visible = (state?.tools ?? []).flatMap((s) => {
    const tool = toolById.get(s.id);
    return tool ? [{ tool, ...s }] : [];
  });
  const buttons = [
    ...visible.slice(0, 4),
    {
      tool: {
        id: 'link',
        icon: 'link' as const,
        label: 'richtext.link' as const,
        run: () => openLinkRef.current(),
      },
      id: 'link',
      active: state?.link ?? false,
      enabled: true,
    },
    ...visible.slice(4),
    ...(mentions
      ? [
          {
            tool: {
              id: 'mention',
              icon: 'mention' as const,
              label: 'richtext.mention' as const,
              run: (e: Editor) => {
                // "@" opens the list after a space or at the start of a line.
                const { from } = e.state.selection;
                const before = e.state.doc.textBetween(Math.max(0, from - 1), from, '\n', '\n');
                chain(e)
                  .insertContent(before === '' || /\s/.test(before) ? '@' : ' @')
                  .run();
              },
            },
            id: 'mention',
            active: null,
            enabled: true,
          },
        ]
      : []),
  ];
  const tabStop = Math.min(focusIndex, Math.max(0, buttons.length - 1));

  const rove = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = Array.from(toolbarRef.current?.querySelectorAll('button') ?? []);
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    let next = at;
    if (event.key === 'ArrowRight') next = (at + 1) % all.length;
    else if (event.key === 'ArrowLeft') next = (at - 1 + all.length) % all.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = all.length - 1;
    else return;
    event.preventDefault();
    setFocusIndex(next);
    all[next]?.focus();
  };

  const popup = (() => {
    if (!suggesting) return null;
    const wrap = wrapperRef.current?.getBoundingClientRect();
    const rect = suggesting.rect;
    const top = wrap && rect ? rect.bottom - wrap.top + 4 : 0;
    const left = wrap && rect ? Math.max(0, Math.min(rect.left - wrap.left, wrap.width - 288)) : 0;
    if (suggesting.items.length === 0) {
      return (
        <p className="rt-mentions rt-mentions-empty" style={{ top, left }}>
          {t('richtext.mention.none')}
        </p>
      );
    }
    return (
      <div
        id={listboxId}
        role="listbox"
        aria-label={t('richtext.mention.list')}
        className="rt-mentions"
        style={{ top, left }}
      >
        {suggesting.items.map((person, i) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the editor's arrow keys and Enter pick
          <div
            key={person.id}
            id={`${listboxId}-${i}`}
            role="option"
            aria-selected={i === suggesting.active}
            tabIndex={-1}
            className="rt-mention-option"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => suggesting.pick(person)}
          >
            <span className="rt-mention-name">{person.name}</span>
            {!person.canView && (
              <span className="rt-mention-warning">{t('richtext.mention.cannotView')}</span>
            )}
          </div>
        ))}
      </div>
    );
  })();

  return (
    <div
      ref={wrapperRef}
      className={`rt-editor${editable ? '' : ' rt-readonly'}${invalid ? ' rt-invalid' : ''}`}
    >
      {editable && editor && (
        <div className="rt-bar">
          <div
            ref={toolbarRef}
            role="toolbar"
            aria-label={t('richtext.toolbar')}
            aria-controls={editorId}
            className="rt-toolbar"
            onKeyDown={rove}
          >
            {buttons.map((b, i) => (
              <button
                key={b.id}
                type="button"
                className="rt-tool"
                tabIndex={i === tabStop ? 0 : -1}
                aria-label={t(b.tool.label, b.tool.values)}
                title={t(b.tool.label, b.tool.values)}
                {...(b.active === null ? {} : { 'aria-pressed': b.active })}
                // Unavailable tools stay in the arrow-key order (APG toolbar).
                aria-disabled={b.enabled ? undefined : true}
                onFocus={() => setFocusIndex(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (b.enabled) b.tool.run(editor);
                }}
              >
                <Icon name={b.tool.icon} />
              </button>
            ))}
          </div>
          {status}
        </div>
      )}
      {link && (
        <div className="rt-link">
          <label htmlFor={linkInputId} className="form-label">
            {t('richtext.link.label')}
          </label>
          <input
            id={linkInputId}
            type="url"
            inputMode="url"
            // biome-ignore lint/a11y/noAutofocus: the form opens on purpose, from the toolbar or Ctrl+K
            autoFocus
            value={link.value}
            aria-invalid={link.error || undefined}
            aria-describedby={link.error ? `${linkInputId}-error` : undefined}
            onChange={(e) => setLink({ value: e.target.value, error: false })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyLink();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeLink();
              }
            }}
          />
          <button type="button" className="button-secondary" onClick={applyLink}>
            {t('richtext.link.apply')}
          </button>
          {state?.link && (
            <button type="button" className="button-secondary" onClick={removeLink}>
              {t('richtext.link.remove')}
            </button>
          )}
          <button type="button" className="button-secondary" onClick={closeLink}>
            {t('richtext.link.cancel')}
          </button>
          {link.error && (
            <p id={`${linkInputId}-error`} className="form-error">
              {t('richtext.link.invalid')}
            </p>
          )}
        </div>
      )}
      <EditorContent editor={editor} className="rt-body" />
      {popup}
      {editable && (
        <p id={hintId} className="visually-hidden">
          {t('richtext.hint')}
        </p>
      )}
      <p role="status" className="rt-notice">
        {notice}
      </p>
      {/* Where Escape puts the focus: the next Tab leaves the field. */}
      <span ref={exitRef} tabIndex={-1} className="rt-exit" />
    </div>
  );
}
