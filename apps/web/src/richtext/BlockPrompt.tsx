import type { PmJson } from '@taskmoor/richtext';
import type { Editor } from '@tiptap/core';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { TicketPicker } from '../tickets/tools/TicketPicker';
import { useEditorTools } from './EditorTools';
import { type BlockPromptKind, EMOJI, STATUS_COLORS } from './slashTools';

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
    </div>
  );
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

function CodePrompt({
  onApply,
  onCancel,
}: {
  onApply: (language: string | null) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const [language, setLanguage] = useState('');
  const [bad, setBad] = useState(false);
  const submit = () => {
    const value = language.trim();
    if (value !== '' && !LANGUAGE.test(value)) {
      setBad(true);
      return;
    }
    onApply(value === '' ? null : value);
  };
  return (
    <fieldset className="rt-prompt-form" onKeyDown={onEnter(submit)}>
      <label htmlFor={id} className="form-label">
        {t('richtext.prompt.language')}
      </label>
      <input
        id={id}
        type="text"
        // biome-ignore lint/a11y/noAutofocus: the form opens on purpose, from the menu
        autoFocus
        value={language}
        aria-invalid={bad || undefined}
        aria-describedby={bad ? `${id}-error` : undefined}
        onChange={(event) => {
          setLanguage(event.target.value);
          setBad(false);
        }}
      />
      <button type="button" className="button-secondary" onClick={submit}>
        {t('richtext.prompt.insert')}
      </button>
      <Cancel onCancel={onCancel} />
      {bad && (
        <p id={`${id}-error`} className="form-error">
          {t('richtext.prompt.languageInvalid')}
        </p>
      )}
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

function AttachmentPrompt({ onInsert, onCancel }: PartProps) {
  const t = useT();
  const tools = useEditorTools();
  const [files, setFiles] = useState<{ name: string; image: boolean }[] | null>(null);
  useEffect(() => {
    let live = true;
    tools.attachments?.(true).then(
      (list) => {
        // A reference holds a name, and two files of one name are the same choice: the first.
        if (live) setFiles(list.filter((f, i) => list.findIndex((g) => g.name === f.name) === i));
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
  return (
    <FilterList
      label={t('richtext.slash.attachment')}
      items={files}
      name={(file) => file.name}
      keyOf={(file) => file.name}
      empty={t('richtext.prompt.noFiles')}
      onPick={(file) =>
        onInsert({ type: 'attachmentRef', attrs: { name: file.name, image: file.image } })
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
