import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';

export interface CardTitleEditorProps {
  ticketKey: string;
  title: string;
  /** Saves the title; resolves to why it was refused, in plain words, or null once saved. */
  onSave: (title: string) => Promise<string | null>;
  onCancel: () => void;
}

/**
 * A card's title in place (AGL-006): Enter saves, Escape cancels, a refusal stays beside the field in
 * plain words. Typing stays in here: the board around it, which can hold thousands of cards, is
 * not drawn again per keystroke, and the keys never reach the card's move shortcuts.
 */
export function CardTitleEditor({ ticketKey, title, onSave, onCancel }: CardTitleEditorProps) {
  const t = useT();
  const problemId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const next = value.trim();
    if (next === '') {
      setProblem(t('boards.card.titleEmpty'));
      return;
    }
    if (next === title) {
      onCancel();
      return;
    }
    setSaving(true);
    const refused = await onSave(next);
    // Once saved this editor is gone.
    if (refused !== null) {
      setProblem(refused);
      setSaving(false);
    }
  };

  return (
    <form
      className="board-card-title-form"
      aria-label={t('boards.card.editTitle', { key: ticketKey })}
      onSubmit={save}
      onKeyDown={(event) => {
        // The card moves with Alt and the arrows, and the app has its own keys: none while typing.
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <input
        ref={input}
        type="text"
        value={value}
        aria-label={t('boards.card.titleLabel', { key: ticketKey })}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? problemId : undefined}
        disabled={saving}
        onChange={(event) => {
          setValue(event.target.value);
          setProblem(null);
        }}
      />
      {problem && (
        <p id={problemId} role="alert" className="form-error board-card-title-problem">
          {problem}
        </p>
      )}
      <span className="board-card-title-actions">
        <button type="submit" className="button-primary" disabled={saving}>
          {t('boards.card.saveTitle')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('boards.card.cancelTitle')}
        </button>
      </span>
    </form>
  );
}
