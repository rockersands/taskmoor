import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { ChevronDownIcon } from './icons';

export interface IconSelectOption {
  value: string;
  label: string;
  /** Beside the label, so decorative: the label names it. */
  icon: ReactNode;
}

export interface IconSelectProps {
  id?: string | undefined;
  value: string;
  options: readonly IconSelectOption[];
  onChange: (value: string) => void;
  /** What the button says while nothing is chosen. */
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-required'?: boolean | undefined;
  'aria-invalid'?: boolean | undefined;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}

/**
 * A single choice whose options show an icon and a name (CORE-012, CORE-014), which a native select
 * cannot draw. It is a combobox that only selects: focus stays on the button, the arrow keys, Home,
 * End and a letter move through the list, Enter or Space takes the option, Tab takes it and moves on,
 * Escape closes. It opens under the button in the page's flow of layers, without moving anything.
 */
export function IconSelect({
  id,
  value,
  options,
  onChange,
  placeholder,
  disabled,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  'aria-required': required,
  'aria-invalid': invalid,
  buttonRef,
}: IconSelectProps) {
  const listId = useId();
  const root = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const chosenAt = options.findIndex((o) => o.value === value);
  const chosen = options[chosenAt];

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, listId]);

  const show = () => {
    setActive(Math.max(chosenAt, 0));
    setOpen(true);
  };
  const take = (at: number) => {
    const option = options[at];
    setOpen(false);
    if (option && option.value !== value) onChange(option.value);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const opening = ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key);
    if (!open) {
      if (!opening) return;
      event.preventDefault();
      show();
      return;
    }
    const last = options.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        setActive((a) => Math.min(a + 1, last));
        break;
      case 'ArrowUp':
        setActive((a) => Math.max(a - 1, 0));
        break;
      case 'Home':
        setActive(0);
        break;
      case 'End':
        setActive(last);
        break;
      case 'Enter':
      case ' ':
        take(active);
        break;
      case 'Tab':
        // Not stopped: focus moves on, with the option taken.
        take(active);
        return;
      case 'Escape':
        setOpen(false);
        break;
      default: {
        if (event.key.length !== 1) return;
        const letter = event.key.toLocaleLowerCase();
        const at = options.findIndex((o) => o.label.toLocaleLowerCase().startsWith(letter));
        if (at >= 0) setActive(at);
      }
    }
    event.preventDefault();
    // A dialog or a cell under it has its own Escape and arrows: they are this list's while open.
    event.stopPropagation();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only notices focus leaving the control
    <span
      className="icon-select"
      ref={root}
      onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        id={id}
        type="button"
        role="combobox"
        className="icon-select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-required={required}
        aria-invalid={invalid}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        {chosen?.icon}
        <span className="icon-select-value">{chosen?.label ?? placeholder}</span>
        <ChevronDownIcon width={16} height={16} />
      </button>
      {open && (
        <div id={listId} role="listbox" className="icon-select-list thin-scroll">
          {options.map((option, at) => (
            // The keyboard is on the button (aria-activedescendant), so these take the pointer only.
            // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the combobox button
            <div
              key={option.value}
              id={`${listId}-${at}`}
              role="option"
              tabIndex={-1}
              aria-selected={at === chosenAt}
              data-active={at === active}
              className="icon-select-option"
              // Keeps focus on the button, or the blur would close the list before the click.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(at)}
              onClick={() => take(at)}
            >
              {option.icon}
              <span>{option.label}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
