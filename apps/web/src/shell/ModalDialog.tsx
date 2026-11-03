import { type ReactNode, useEffect, useRef } from 'react';
import { leaveMotion, useLeaveMotion } from './motion';

export interface ModalDialogProps {
  onClose: () => void;
  /** The id of the heading that names the dialog. */
  labelledBy: string;
  /** What the backdrop, a button without text, is called. */
  closeLabel: string;
  /** Starts in the first field rather than on the dialog itself. */
  focusFirstField?: boolean;
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog over the page, full width on phones and scrolling inside itself. Escape and the
 * backdrop close it, Tab stays inside, and focus goes back to where it was.
 */
export function ModalDialog({
  onClose,
  labelledBy,
  closeLabel,
  focusFirstField = false,
  children,
}: ModalDialogProps) {
  const box = useRef<HTMLDivElement>(null);
  const boxRef = useLeaveMotion(box);

  // biome-ignore lint/correctness/useExhaustiveDependencies: where focus starts is decided once
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = focusFirstField ? box.current?.querySelector('input') : null;
    (first ?? box.current)?.focus();
    return () => opener?.focus();
  }, []);

  // A button that turns disabled while it works drops focus to the page. The dialog is still open
  // and modal, so Escape still closes it and Tab goes back in.
  useEffect(() => {
    const lost = (event: KeyboardEvent) => {
      const inside = box.current?.contains(document.activeElement);
      if (inside || !box.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        box.current.focus();
      }
    };
    document.addEventListener('keydown', lost);
    return () => document.removeEventListener('keydown', lost);
  }, [onClose]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === box.current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <button
        ref={leaveMotion}
        type="button"
        className="shell-backdrop create-backdrop"
        aria-label={closeLabel}
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        ref={boxRef}
        className="create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </>
  );
}
