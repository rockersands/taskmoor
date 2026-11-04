import { useEffect, useId, useRef } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { leaveMotion } from '../../shell/motion';

/**
 * Whether the ticket view holds something a person typed and has not saved (NFR-005): text in
 * a form of the view, in the view itself and not in a dialog over it. It reads the page rather
 * than asking each part, so a form added to the ticket view is covered with no second edit. A
 * form that holds only what is already saved says so with `data-no-draft`. The description is
 * not a draft: it saves as it is typed. The pop-up (TicketPopup.tsx) and the full page
 * (TicketPage.tsx) ask by the same rule, with the same dialog.
 */
export function hasDraft(root: Element | null): boolean {
  if (!root) return false;
  const dialog = root.closest('[role="dialog"]');
  for (const form of root.querySelectorAll('form:not([data-no-draft])')) {
    if (form.closest('[role="dialog"]') !== dialog) continue;
    const fields = form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="number"]',
    );
    for (const field of fields) if (field.value.trim() !== '') return true;
    for (const editor of form.querySelectorAll('[contenteditable="true"]')) {
      if (editor.textContent?.trim() || editor.querySelector('img')) return true;
    }
  }
  return false;
}

/** What the dialog says, where a page other than a ticket asks (the layout sets page, UI-T15). */
export interface DraftDialogWords {
  title: string;
  text: string;
  keep: string;
  discard: string;
}

/**
 * Asks before unsaved text goes. Keeping it is the first choice and the Escape. `over` lifts it
 * above a ticket pop-up, for the full page beneath one. `words` replaces a ticket's wording.
 */
export function DraftDialog({
  onKeep,
  onDiscard,
  over = false,
  words,
}: {
  onKeep: () => void;
  onDiscard: () => void;
  over?: boolean;
  words?: DraftDialogWords;
}) {
  const t = useT();
  const titleId = useId();
  const textId = useId();
  const keep = useRef<HTMLButtonElement>(null);
  const discard = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keep.current?.focus();
    return () => opener?.focus();
  }, []);
  return (
    <div className={over ? 'ticket-dialog-backdrop ticket-dialog-over' : 'ticket-dialog-backdrop'}>
      <div
        ref={leaveMotion}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        className="ticket-dialog"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onKeep();
          } else if (event.key === 'Tab') {
            event.preventDefault();
            (document.activeElement === keep.current ? discard : keep).current?.focus();
          }
        }}
      >
        <h2 id={titleId} className="ticket-section-title">
          {words?.title ?? t('ticketPopup.draft.title')}
        </h2>
        <p id={textId}>{words?.text ?? t('ticketPopup.draft.text')}</p>
        <div className="form-actions">
          <button ref={keep} type="button" className="button-primary" onClick={onKeep}>
            {words?.keep ?? t('ticketPopup.draft.keep')}
          </button>
          <button ref={discard} type="button" className="button-secondary" onClick={onDiscard}>
            {words?.discard ?? t('ticketPopup.draft.discard')}
          </button>
        </div>
      </div>
    </div>
  );
}
