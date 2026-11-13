import { type ReactNode, useEffect, useId, useRef } from 'react';

/**
 * The step between a destructive action and its effect (D13): one sentence saying what will
 * happen, the action itself in the danger style, and a way back. The action takes the focus, so
 * the keyboard is where the decision is.
 */
export function DangerConfirm({
  message,
  confirmLabel,
  cancelLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  message: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirm.current?.focus();
  }, []);
  return (
    <fieldset className="token-confirm danger-confirm" aria-labelledby={id}>
      <p id={id}>{message}</p>
      <div className="token-confirm-actions">
        <button
          ref={confirm}
          type="button"
          className="button-danger"
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </fieldset>
  );
}
