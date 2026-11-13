import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';

export interface DangerActionProps {
  /** The first step: the action alone, such as "Deactivate" or "Revoke". */
  label: string;
  /** What will happen, said before anything does: what is lost, who is locked out, for how long. */
  outcome: ReactNode;
  /** The button that does it: the action and what it acts on, such as "Deactivate Ana Ruiz". */
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  /** While the action runs, both steps wait. */
  busy?: boolean;
  disabled?: boolean;
}

/**
 * An action that removes something or locks someone out (D13, T-220): Deactivate, Erase, Delete,
 * Revoke. Its button has the danger look, and pressing it does nothing yet: a confirmation opens
 * in its place, says what will happen, and offers the action by name beside Cancel. Focus goes to
 * Cancel, the safe choice; Escape and Cancel put the button back and focus it.
 */
export function DangerAction({
  label,
  outcome,
  confirmLabel,
  onConfirm,
  busy = false,
  disabled = false,
}: DangerActionProps) {
  const t = useT();
  const outcomeId = useId();
  const [asking, setAsking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (asking) {
      cancel.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      trigger.current?.focus();
    }
  }, [asking]);

  const stop = () => {
    returnFocus.current = true;
    setAsking(false);
  };

  const confirm = async () => {
    try {
      await onConfirm();
    } finally {
      // Whatever it said, the question is answered; focus comes back if the button is still here.
      returnFocus.current = true;
      setAsking(false);
    }
  };

  if (!asking) {
    return (
      <button
        ref={trigger}
        type="button"
        className="button-danger-quiet"
        disabled={disabled || busy}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    );
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a question and its two answers, not a set of fields
    <div
      className="danger-confirm"
      role="group"
      aria-labelledby={outcomeId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        stop();
      }}
    >
      <p id={outcomeId} className="danger-confirm-outcome">
        {outcome}
      </p>
      <div className="danger-confirm-actions">
        <button
          type="button"
          className="button-danger"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {confirmLabel}
        </button>
        <button ref={cancel} type="button" className="button-secondary" onClick={stop}>
          {t('danger.cancel')}
        </button>
      </div>
    </div>
  );
}
