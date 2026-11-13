import { type ReactNode, useCallback, useEffect, useId, useRef } from 'react';

/**
 * The step between a destructive action and its effect (D13): one sentence saying what will
 * happen, the action itself in the danger style, and a way back. The way back takes the focus,
 * and Escape takes it, so nothing is lost by a stray key. Local to Administration until the
 * shared `shell/DangerAction` (G6) lands; it behaves the same, so the switch is one for one.
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
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <fieldset
      className="token-confirm danger-confirm"
      aria-labelledby={id}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p id={id}>{message}</p>
      <div className="token-confirm-actions">
        <button type="button" className="button-danger" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button ref={cancel} type="button" className="button-secondary" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </fieldset>
  );
}

/**
 * Gives the focus back to the button that asked for a confirmation once the way back is taken
 * (Cancel or Escape), so it does not fall to the page. `returnTo(key)` before closing; `ref(key)`
 * on each trigger, which takes the focus when it is next in the page.
 */
export function useReturnFocus<K>() {
  const pending = useRef<K | null>(null);
  const returnTo = useCallback((key: K) => {
    pending.current = key;
  }, []);
  const ref = (key: K) => (element: HTMLElement | null) => {
    if (!element || pending.current !== key) return;
    pending.current = null;
    element.focus();
  };
  return { returnTo, ref };
}
