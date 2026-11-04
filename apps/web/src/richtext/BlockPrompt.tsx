import { DIGEST_LENGTH, isAttachmentDigest, type PmJson } from '@taskmoor/richtext';
import type { Editor } from '@tiptap/core';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { formatSize } from '../attachments/format';
import { useT } from '../i18n/I18nProvider';
import { TicketPicker } from '../tickets/tools/TicketPicker';
import { type EditorAttachment, useEditorTools } from './EditorTools';
import {
  type BlockPromptKind,
  CODE_LANGUAGES,
  type CodeLanguage,
  columnLayoutAt,
  currentPreset,
  EMOJI,
  matchingLanguages,
  STATUS_COLORS,
  setColumnWidths,
  widthPresets,
} from './slashTools';

export interface BlockPromptProps {
  kind: BlockPromptKind;
  editor: Editor;
  /** Done or cancelled: the caret goes back to the text. */
  onClose: () => void;
}

/** The languages a code block's fence and the wiki markup can both carry. */
const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,40}$/;

/** Today where the reader is, as a date field holds it. */
const today = () => {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
};

/**
 * Enter in a prompt's field applies it. These are not forms: the editor they open from often sits
 * inside a comment's or a new ticket's form, which Enter must not send.
 */
const onEnter = (apply: () => void) => (event: KeyboardEvent<HTMLElement>) => {
  if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
    event.preventDefault();
    apply();
  }
};

/**
 * What a block asks for before it goes in at the caret (NTF-013): a code block's language, a status
 * label's words and colour, a date, an emoji, one of the ticket's files, another ticket. Each works
 * by keyboard, and Escape goes back to the text with nothing added.
 */
export function BlockPrompt({ kind, editor, onClose }: BlockPromptProps) {
  const insert = (content: PmJson | PmJson[]) => {
    editor.chain().focus().insertContent(content).run();
    onClose();
  };
  const onEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from any of its fields
    <div className="rt-link rt-prompt" onKeyDown={onEscape}>
      {kind === 'code' && (
        <CodePrompt
          onApply={(language) => {
            editor
              .chain()
              .focus()
              .setCodeBlock(language === null ? undefined : { language })
              .run();
            onClose();
          }}
          onCancel={onClose}
        />
      )}
      {kind === 'date' && <DatePrompt onInsert={insert} onCancel={onClose} />}
      {kind === 'status' && <StatusPrompt onInsert={insert} onCancel={onClose} />}
      {kind === 'emoji' && <EmojiPrompt onInsert={insert} onCancel={onClose} />}
      {kind === 'attachment' && <AttachmentPrompt onInsert={insert} onCancel={onClose} />}
      {kind === 'ticket' && <TicketPrompt onInsert={insert} onCancel={onClose} />}
      {kind === 'columns' && <ColumnsPrompt editor={editor} onClose={onClose} />}
    </div>
  );
}

/**
 * Keeps the option the arrow keys reached in sight: a prompt's list shows only a few at a time,
 * and a browser does not scroll a list for its field's `aria-activedescendant` (TT-8).
 */
function useKeptInView(listId: string, at: number) {
  useEffect(() => {
    if (at < 0) return;
    document.getElementById(`${listId}-${at}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [listId, at]);
}

interface PartProps {
  onInsert: (content: PmJson | PmJson[]) => void;
  onCancel: () => void;
}

function Cancel({ onCancel }: { onCancel: () => void }) {
  const t = useT();
  return (
    <button type="button" className="button-secondary" onClick={onCancel}>
      {t('richtext.link.cancel')}
    </button>
  );
}

/**
 * A code block's language (TT-8): any one word, as before, with a list of common ones that the
 * typing narrows. Down and Up walk the list and Enter takes the one chosen; with none chosen,
 * Enter takes what was typed. The list only helps: the editor does not highlight by language.
 */
function CodePrompt({
  onApply,
  onCancel,
}: {
  onApply: (language: string | null) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const listId = useId();
  const [language, setLanguage] = useState('');
  const [bad, setBad] = useState(false);
  /** The language the arrow keys chose, or -1 for what was typed. */
  const [active, setActive] = useState(-1);
  const shown = matchingLanguages(CODE_LANGUAGES, language);
  const at = active < shown.length ? active : -1;
  useKeptInView(listId, at);
  const apply = (value: string) => {
    if (value !== '' && !LANGUAGE.test(value)) {
      setBad(true);
      return;
    }
    onApply(value === '' ? null : value);
  };
  const pick = (choice: CodeLanguage) => apply(choice.id);
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && shown.length > 0) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      // From what was typed, Down goes to the first and Up to the last.
      if (at === -1) setActive(step === 1 ? 0 : shown.length - 1);
      else setActive((at + step + shown.length) % shown.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const choice = shown[at];
      if (choice) pick(choice);
      else apply(language.trim());
    }
  };
  return (
    <fieldset className="rt-prompt-form">
      <label htmlFor={id} className="form-label">
        {t('richtext.prompt.language')}
      </label>
      <input
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        // biome-ignore lint/a11y/noAutofocus: the form opens on purpose, from the menu
        autoFocus
        value={language}
        aria-autocomplete="list"
        aria-expanded={shown.length > 0}
        aria-controls={listId}
        aria-activedescendant={at >= 0 ? `${listId}-${at}` : undefined}
        aria-invalid={bad || undefined}
        aria-describedby={bad ? `${id}-error` : undefined}
        onChange={(event) => {
          setLanguage(event.target.value);
          setActive(-1);
          setBad(false);
        }}
        onKeyDown={onKey}
      />
      <button type="button" className="button-secondary" onClick={() => apply(language.trim())}>
        {t('richtext.prompt.insert')}
      </button>
      <Cancel onCancel={onCancel} />
      {bad && (
        <p id={`${id}-error`} className="form-error">
          {t('richtext.prompt.languageInvalid')}
        </p>
      )}
      <div
        id={listId}
        role="listbox"
        aria-label={t('richtext.prompt.languages')}
        className="rt-prompt-list"
      >
        {shown.map((choice, i) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the field's arrow keys and Enter pick
          <div
            key={choice.id}
            id={`${listId}-${i}`}
            role="option"
            tabIndex={-1}
            aria-selected={i === at}
            className="rt-mention-option rt-language-option"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pick(choice)}
          >
            <span>{choice.name}</span>
            {choice.name.toLowerCase() !== choice.id && (
              <span className="rt-language-word">{choice.id}</span>
            )}
          </div>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * The widths of the columns the caret is in (TT-2): equal, one of a few shares for their number,
 * or the widths they have now when those are none of these. Applying sets every column at once.
 */
function ColumnsPrompt({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [layout] = useState(() => columnLayoutAt(editor.state));
  const [presets] = useState(() => (layout ? widthPresets(layout.widths) : []));
  // The widths it has now are chosen first, so Enter alone changes nothing.
  const [choice, setChoice] = useState(() => (layout ? currentPreset(presets, layout.widths) : 0));
  if (!layout) return null;
  const label = (widths: readonly (number | null)[]) =>
    widths.every((w) => w === null)
      ? t('richtext.columns.equal')
      : intl.formatList(
          widths.map((w) =>
            intl.formatNumber((w ?? 0) / 100, { style: 'percent', maximumFractionDigits: 1 }),
          ),
          { type: 'unit', style: 'short' },
        );
  const apply = () => {
    const widths = presets[choice];
    // Where the layout is now: someone editing at the same time may have moved it.
    const at = columnLayoutAt(editor.state);
    if (!widths || !at || at.widths.length !== widths.length) return onClose();
    setColumnWidths(editor, at.pos, widths);
    onClose();
  };
  return (
    <fieldset className="rt-prompt-form">
      <label htmlFor={id} className="form-label">
        {t('richtext.columns.widths', { count: layout.widths.length })}
      </label>
      <select
        id={id}
        // biome-ignore lint/a11y/noAutofocus: the form opens on purpose, from the menu
        autoFocus
        value={choice}
        onChange={(event) => setChoice(Number(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            apply();
          }
        }}
      >
        {presets.map((widths, i) => (
          <option key={widths.join('/')} value={i}>
            {label(widths)}
          </option>
        ))}
      </select>
      <button type="button" className="button-secondary" onClick={apply}>
        {t('richtext.columns.apply')}
      </button>
      <Cancel onCancel={onClose} />
    </fieldset>
  );
}

function DatePrompt({ onInsert, onCancel }: PartProps) {
  const t = useT();
  const id = useId();
  const [day, setDay] = useState(today);
  const submit = () => {
    const ms = Date.parse(`${day}T00:00:00Z`);
    if (Number.isFinite(ms)) {
      onInsert({ type: 'date', attrs: { timestamp: String(ms) } });
    }
  };
  return (
    <fieldset className="rt-prompt-form" onKeyDown={onEnter(submit)}>
      <label htmlFor={id} className="form-label">
        {t('richtext.slash.date')}
      </label>
      <input
        id={id}
        type="date"
        // biome-ignore lint/a11y/noAutofocus: the form opens on purpose, from the menu
        autoFocus
        value={day}
        onChange={(event) => setDay(event.target.value)}
      />
      <button type="button" className="button-secondary" disabled={day === ''} onClick={submit}>
        {t('richtext.prompt.insert')}
      </button>
      <Cancel onCancel={onCancel} />
    </fieldset>
  );
}

function StatusPrompt({ onInsert, onCancel }: PartProps) {
  const t = useT();
  const textId = useId();
  const colorId = useId();
  const [text, setText] = useState('');
  const [color, setColor] = useState('neutral');
  const submit = () => {
    if (text.trim() !== '') {
      onInsert({ type: 'status', attrs: { text: text.trim().slice(0, 60), color } });
    }
  };
  return (
    <fieldset className="rt-prompt-form" onKeyDown={onEnter(submit)}>
      <label htmlFor={textId} className="form-label">
        {t('richtext.slash.status')}
      </label>
      <input
        id={textId}
        type="text"
        maxLength={60}
        // biome-ignore lint/a11y/noAutofocus: the form opens on purpose, from the menu
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <label htmlFor={colorId} className="form-label">
        {t('richtext.prompt.color')}
      </label>
      <select id={colorId} value={color} onChange={(event) => setColor(event.target.value)}>
        {STATUS_COLORS.map((choice) => (
          <option key={choice.color} value={choice.color}>
            {t(choice.label)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="button-secondary"
        disabled={text.trim() === ''}
        onClick={submit}
      >
        {t('richtext.prompt.insert')}
      </button>
      <Cancel onCancel={onCancel} />
    </fieldset>
  );
}

/** A field that filters a list: Down and Up walk it, Enter picks. */
function FilterList<T>({
  label,
  items,
  name,
  keyOf,
  onPick,
  onCancel,
  empty,
}: {
  label: string;
  items: readonly T[];
  name: (item: T) => string;
  keyOf: (item: T) => string;
  onPick: (item: T) => void;
  onCancel: () => void;
  empty: string;
}) {
  const id = useId();
  const listId = useId();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const wanted = text.trim().toLowerCase();
  const shown = items.filter((item) => name(item).toLowerCase().includes(wanted));
  const at = Math.min(active, Math.max(0, shown.length - 1));
  useKeptInView(listId, at);
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && shown.length > 0) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : shown.length - 1;
      setActive((at + step) % shown.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = shown[at];
      if (item) onPick(item);
    }
  };
  return (
    <div className="rt-prompt-form">
      <label htmlFor={id} className="form-label">
        {label}
      </label>
      <input
        ref={input}
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={shown.length > 0}
        aria-controls={listId}
        aria-activedescendant={shown.length > 0 ? `${listId}-${at}` : undefined}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKey}
      />
      <Cancel onCancel={onCancel} />
      <div id={listId} role="listbox" aria-label={label} className="rt-prompt-list">
        {shown.map((item, i) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the field's arrow keys and Enter pick
          <div
            key={keyOf(item)}
            id={`${listId}-${i}`}
            role="option"
            tabIndex={-1}
            aria-selected={i === at}
            className="rt-mention-option"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(item)}
          >
            {name(item)}
          </div>
        ))}
      </div>
      {shown.length === 0 && <p className="form-hint">{empty}</p>}
    </div>
  );
}

function EmojiPrompt({ onInsert, onCancel }: PartProps) {
  const t = useT();
  return (
    <FilterList
      label={t('richtext.slash.emoji')}
      items={EMOJI}
      name={(emoji) => `${emoji.text} ${t(emoji.label)}`}
      keyOf={(emoji) => emoji.shortName}
      empty={t('richtext.prompt.noEmoji')}
      onPick={(emoji) =>
        onInsert({ type: 'emoji', attrs: { shortName: emoji.shortName, text: emoji.text } })
      }
      onCancel={onCancel}
    />
  );
}

/** The first digits of a file's SHA-256 that a reference holds, when the list gave it one. */
const digestOf = (file: EditorAttachment): string | null => {
  const digest = file.sha256?.toLowerCase().slice(0, DIGEST_LENGTH) ?? null;
  return isAttachmentDigest(digest) ? digest : null;
};

/**
 * One of the ticket's files (NTF-014). A reference holds the file's name and the first digits of
 * its SHA-256, so two files of one name are two choices (TT-4): each says its size, when it came
 * and who added it, and the reference shows the one picked.
 */
function AttachmentPrompt({ onInsert, onCancel }: PartProps) {
  const t = useT();
  const intl = useIntl();
  const tools = useEditorTools();
  const [files, setFiles] = useState<EditorAttachment[] | null>(null);
  useEffect(() => {
    let live = true;
    tools.attachments?.(true).then(
      (list) => {
        if (live) setFiles(list);
      },
      () => {
        if (live) setFiles([]);
      },
    );
    return () => {
      live = false;
    };
  }, [tools]);
  if (files === null) return <p role="status">{t('richtext.prompt.loading')}</p>;
  const sameName = (file: EditorAttachment) => files.filter((f) => f.name === file.name);
  /** A name alone, or with what tells it from another file of that name. */
  const name = (file: EditorAttachment) => {
    const named = sameName(file);
    if (named.length < 2) return file.name;
    const details = [
      file.size === undefined ? '' : formatSize(t, intl, file.size),
      file.createdAt
        ? intl.formatDate(file.createdAt, { dateStyle: 'medium', timeStyle: 'short' })
        : '',
      file.author ? t('richtext.prompt.fileBy', { author: file.author }) : '',
    ].filter((part) => part !== '');
    // With nothing else to tell them by, their place in the list does.
    if (details.length === 0) {
      details.push(t('richtext.prompt.fileNumber', { number: named.indexOf(file) + 1 }));
    }
    return t('richtext.prompt.file', {
      name: file.name,
      details: intl.formatList(details, { type: 'unit', style: 'short' }),
    });
  };
  return (
    <FilterList
      label={t('richtext.slash.attachment')}
      items={files}
      name={name}
      keyOf={(file) => file.href}
      empty={t('richtext.prompt.noFiles')}
      onPick={(file) =>
        onInsert({
          type: 'attachmentRef',
          attrs: { name: file.name, image: file.image, digest: digestOf(file) },
        })
      }
      onCancel={onCancel}
    />
  );
}

function TicketPrompt({ onInsert, onCancel }: PartProps) {
  const t = useT();
  const tools = useEditorTools();
  return (
    <div className="rt-prompt-form">
      <TicketPicker
        label={t('richtext.slash.ticket')}
        autoFocus
        search={(typed) => tools.tickets?.(typed) ?? Promise.resolve([])}
        onPick={(ticket) =>
          onInsert([
            { type: 'ticketRef', attrs: { key: ticket.key } },
            { type: 'text', text: ' ' },
          ])
        }
        onCancel={onCancel}
      />
      <Cancel onCancel={onCancel} />
    </div>
  );
}
