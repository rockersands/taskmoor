import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';

export interface DangerActionProps {
  /** The first step: the action alone, such as "Deactivate" or "Revoke". */
  label: string;
  /**
   * The first step's name when a list repeats it, such as "Deactivate Ana Ruiz" on each person's
   * row; the label alone otherwise.
   */
  name?: string;
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
 *
 * While the action runs, the question waits: both answers are dimmed and do nothing, Escape does
 * nothing, and a second press sends nothing more. A refusal leaves the question open to try again
 * or cancel; saying why is the caller's. A dimmed answer stays focusable (`aria-disabled`), and the
 * button gets focus back even while it is unavailable, so focus never falls to the page.
 *
 * Which removals use it (ADR-114 D13, T-267): one that loses what its page cannot put back (a
 * list's items, a saved draft, second-level options, a link the page cannot make again), or that
 * takes something from people beyond the row (an invitation, a release's place in a release across
 * tracks, a grant, a track made read-only). One the same page puts back at once, with nothing lost,
 * stays a plain `button-secondary` that acts on the first press.
 */
export function DangerAction({
  label,
  name,
  outcome,
  confirmLabel,
  onConfirm,
  busy = false,
  disabled = false,
}: DangerActionProps) {
  const t = useT();
  const outcomeId = useId();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  // Set at the first press, before React draws the dimmed answers: a double-click sends one.
  const running = useRef(false);
  // The button holds focus given back to it while it is unavailable, until focus moves on.
  const [holding, setHolding] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const waiting = busy || pending;
  const unavailable = disabled || busy;

  useEffect(() => {
    if (asking) {
      cancel.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      trigger.current?.focus();
    }
  }, [asking]);

  const stop = () => {
    if (waiting) return;
    returnFocus.current = true;
    setHolding(true);
    setAsking(false);
  };

  const confirm = async () => {
    if (waiting || running.current) return;
    running.current = true;
    setPending(true);
    try {
      await onConfirm();
    } catch {
      // Refused: the question stays, to try again or cancel. The caller says why, if it does.
      return;
    } finally {
      running.current = false;
      setPending(false);
    }
    // Done: the question is answered, and focus goes back to the button.
    returnFocus.current = true;
    setHolding(true);
    setAsking(false);
  };

  if (!asking) {
    const held = unavailable && holding;
    return (
      <button
        ref={trigger}
        type="button"
        className="button-danger-quiet"
        aria-label={name}
        disabled={unavailable && !held}
        aria-disabled={held || undefined}
        onBlur={() => setHolding(false)}
        onClick={() => {
          if (!unavailable) setAsking(true);
        }}
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
      aria-busy={waiting || undefined}
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
          aria-disabled={waiting || undefined}
          onClick={() => void confirm()}
        >
          {confirmLabel}
        </button>
        <button
          ref={cancel}
          type="button"
          className="button-secondary"
          aria-disabled={waiting || undefined}
          onClick={stop}
        >
          {t('danger.cancel')}
        </button>
      </div>
    </div>
  );
}
