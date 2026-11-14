import {
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

/**
 * The one way to add something on an Administration list page (D11, AD-18, AD-19): a filled
 * "New …" button among the page's actions, or at the head of a section's card, that opens the
 * form above the list, as Ticket templates and Webhooks do. The list comes first; the form shows
 * only when asked for.
 *
 * In a page's header it has one place on every page, at every width: under the title and its
 * purpose line, at the start (`admin-new` in admin.css). The header's own wrapping once put it at
 * the right of a short purpose line and under a long one.
 */
export function NewButton({
  label,
  open,
  onToggle,
  ref,
  'data-tutorial': tutorial,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  /** From `useNewForm`, so the focus comes back here when the form closes. */
  ref?: Ref<HTMLButtonElement>;
  /** The tutorial step that points here, if one does. */
  'data-tutorial'?: string;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className="button-primary admin-new"
      aria-expanded={open}
      onClick={onToggle}
      {...(tutorial ? { 'data-tutorial': tutorial } : {})}
    >
      {label}
    </button>
  );
}

export interface NewForm {
  /** Whether the form is showing. */
  open: boolean;
  /** The New button's handler: opens the form, or closes it again. */
  toggle: () => void;
  /**
   * Closes the form after Cancel or once the thing is added, and gives the focus back to the
   * New button when it was in the form, so it does not fall to the page.
   */
  close: () => void;
  /** For the New button's `ref`. */
  button: RefObject<HTMLButtonElement | null>;
}

/** The state behind a New button and its form, with the focus returned when the form closes. */
export function useNewForm(): NewForm {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    // Only when the focus fell with the form: someone who has moved on keeps their place.
    const active = document.activeElement;
    if (active === null || active === document.body) button.current?.focus();
  }, [open]);
  const toggle = useCallback(() => setOpen((was) => !was), []);
  const close = useCallback(() => {
    refocus.current = true;
    setOpen(false);
  }, []);
  return { open, toggle, close, button };
}

/** A section's card heading with its New button at the end (D11). */
export function CardHead({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <div className="admin-card-head">
      {children}
      {action}
    </div>
  );
}
