import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import type { PickedTicket } from './client';

/** How long typing pauses before the picker asks the server. */
export const PICKER_DEBOUNCE_MS = 200;

export interface TicketPickerProps {
  label: string;
  /** Said under the field: where the picker looks. */
  hint?: string;
  /** Tickets for what was typed; never called with an empty text. */
  search: (typed: string) => Promise<PickedTicket[]>;
  onPick: (ticket: PickedTicket) => void;
  /** Tickets not to offer, by id: those already linked, for example. */
  exclude?: ReadonlySet<number>;
  disabled?: boolean;
  /** Focus the field when it appears. */
  autoFocus?: boolean;
  /** Escape in the field, with the list closed. */
  onCancel?: () => void;
  /** More said about the field after the hint: help or a refusal (the create form's parent). */
  describedBy?: string | undefined;
  required?: boolean;
  invalid?: boolean;
}

/**
 * Choosing a ticket by typing its number or name (CORE-031): a combobox whose list follows the
 * text after a short pause. Down and Up walk the list, Enter picks, Escape closes it. An answer
 * that arrives after newer typing is dropped, and the status line says how many were found.
 */
export function TicketPicker({
  label,
  hint,
  search,
  onPick,
  exclude,
  disabled = false,
  autoFocus = false,
  onCancel,
  describedBy,
  required = false,
  invalid = false,
}: TicketPickerProps) {
  const t = useT();
  const id = useId();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [found, setFound] = useState<PickedTicket[] | null>(null);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const asked = useRef(0);
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    // Also when it comes back from being busy, so the next one can be typed at once.
    if (autoFocus && !disabled) input.current?.focus();
  }, [autoFocus, disabled]);

  useEffect(() => {
    const typed = text.trim();
    const ask = ++asked.current;
    setFailed(false);
    if (typed === '') {
      setFound(null);
      setOpen(false);
      return;
    }
    const timer = window.setTimeout(() => {
      searchRef.current(typed).then(
        (tickets) => {
          if (ask !== asked.current) return;
          setFound(tickets);
          setActive(0);
          setOpen(true);
        },
        () => {
          if (ask !== asked.current) return;
          setFound([]);
          setFailed(true);
          setOpen(true);
        },
      );
    }, PICKER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const offered = (found ?? []).filter((ticket) => !exclude?.has(ticket.id));
  const showing = open && offered.length > 0;
  const choose = (ticket: PickedTicket) => {
    onPick(ticket);
    setText('');
    setFound(null);
    setOpen(false);
    input.current?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (open) setOpen(false);
      else onCancel?.();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open && found) {
        setOpen(true);
        return;
      }
      if (offered.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : offered.length - 1;
      setActive((now) => (now + step) % offered.length);
      return;
    }
    if (event.key === 'Enter') {
      // Enter never submits a form around the field: it picks, or waits for a list.
      event.preventDefault();
      const ticket = offered[active];
      if (showing && ticket) choose(ticket);
    }
  };

  const said = failed
    ? t('ticketTools.picker.failed')
    : found === null || !open
      ? ''
      : offered.length === 0
        ? t('ticketTools.picker.none')
        : t('ticketTools.picker.found', { count: offered.length });

  return (
    <div className="ticket-picker">
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
        aria-expanded={showing}
        aria-controls={showing ? listId : undefined}
        aria-activedescendant={showing ? `${listId}-${active}` : undefined}
        aria-describedby={
          [hint ? `${id}-hint` : '', describedBy ?? ''].filter(Boolean).join(' ') || undefined
        }
        aria-required={required || undefined}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKey}
        onBlur={() => setOpen(false)}
      />
      {hint && (
        <p id={`${id}-hint`} className="form-hint">
          {hint}
        </p>
      )}
      {showing && (
        <div id={listId} role="listbox" aria-label={label} className="ticket-picker-list">
          {offered.map((ticket, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the field's arrow keys and Enter pick
            <div
              key={ticket.id}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className="ticket-picker-option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(ticket)}
            >
              <span className="ticket-picker-key">{ticket.key}</span>
              <span className="ticket-picker-summary">{ticket.summary}</span>
              <span className="ticket-picker-status">{ticket.status.name}</span>
            </div>
          ))}
        </div>
      )}
      <p role="status" className={said ? 'form-hint' : 'visually-hidden'}>
        {said}
      </p>
    </div>
  );
}
