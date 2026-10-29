import { useEffect, useId, useRef } from 'react';
import { useT } from '../i18n/I18nProvider';
import { type CreateClient, CreateTicketPage } from './CreateTicketPage';

export interface CreateTicketDialogProps {
  onClose: () => void;
  client?: CreateClient;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/**
 * Creating a ticket without leaving the page (M1-052): the create form in a modal dialog,
 * opened from the top bar, the C key or the command palette. Escape and the backdrop close it,
 * Tab stays inside, and focus goes back to where it was.
 */
export function CreateTicketDialog({ onClose, client }: CreateTicketDialogProps) {
  const t = useT();
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus();
    return () => opener?.focus();
  }, []);

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
        type="button"
        className="shell-backdrop create-backdrop"
        aria-label={t('tickets.create.close')}
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        ref={box}
        className="create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <CreateTicketPage
          {...(client ? { client } : {})}
          variant="dialog"
          titleId={titleId}
          onClose={onClose}
        />
      </div>
    </>
  );
}
