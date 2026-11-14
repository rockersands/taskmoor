import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { PICKER_DEBOUNCE_MS } from './tools/TicketPicker';

/** A person as a picker offers one. */
export interface PickedPerson {
  id: number;
  name: string;
}

export interface PersonPickerProps {
  /** The field's name; it names the search field and the group. */
  label: string;
  /** People for what was typed; never called with an empty text. */
  search: (typed: string) => Promise<PickedPerson[]>;
  chosen: readonly PickedPerson[];
  onChange: (people: PickedPerson[]) => void;
  /** Several people (a custom person field that holds several); one by default. */
  multiple?: boolean;
  /** What the Remove button beside a chosen person is called; "Remove Sam" by default. */
  removeLabel?: (name: string) => string;
  /** Said under the search field; "Type a name to find someone." by default. */
  hint?: string;
  /** Help, a lock or a refusal said about the field as a whole. */
  describedBy?: string | undefined;
  required?: boolean;
  invalid?: boolean;
  disabled?: boolean;
}

/**
 * Choosing people by name (T-253): a search field whose matches follow the text after a short
 * pause, each a button that takes the person, and the people taken, each with a Remove button.
 * With one person to choose, the search field gives way to the choice until it is removed. The
 * ticket templates' assignee and the create form's people fields use it.
 */
export function PersonPicker({
  label,
  search,
  chosen,
  onChange,
  multiple = false,
  removeLabel,
  hint,
  describedBy,
  required = false,
  invalid = false,
  disabled = false,
}: PersonPickerProps) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState('');
  const [found, setFound] = useState<PickedPerson[] | null>(null);
  const [failed, setFailed] = useState(false);
  const asked = useRef(0);
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    const typed = text.trim();
    const ask = ++asked.current;
    setFailed(false);
    if (typed === '') {
      setFound(null);
      return;
    }
    const timer = window.setTimeout(() => {
      searchRef.current(typed).then(
        (people) => ask === asked.current && setFound(people),
        () => {
          if (ask !== asked.current) return;
          setFound([]);
          setFailed(true);
        },
      );
    }, PICKER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const searching = multiple || chosen.length === 0;
  const offered = (found ?? []).filter((p) => !chosen.some((c) => c.id === p.id));
  const said = failed
    ? t('tickets.pickers.peopleFailed')
    : found === null
      ? ''
      : offered.length === 0
        ? t('tickets.pickers.noPeople')
        : t('tickets.pickers.peopleFound', { count: offered.length });
  const take = (person: PickedPerson) => {
    setText('');
    setFound(null);
    onChange(multiple ? [...chosen, person] : [person]);
  };
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;

  return (
    <div className="person-picker">
      {/* The search field's own label while it shows; otherwise the name of the list chosen. */}
      {searching ? (
        <label id={labelId} htmlFor={`${id}-search`} className="form-label">
          {label}
        </label>
      ) : (
        <span id={labelId} className="form-label">
          {label}
        </span>
      )}
      {chosen.length > 0 && (
        <ul
          className="person-picker-chosen"
          aria-labelledby={labelId}
          aria-describedby={searching ? undefined : describedBy || undefined}
        >
          {chosen.map((person) => (
            <li key={person.id}>
              <span>{person.name}</span>
              <button
                type="button"
                className="button-secondary"
                disabled={disabled}
                aria-label={
                  removeLabel?.(person.name) ?? t('tickets.pickers.remove', { name: person.name })
                }
                onClick={() => onChange(chosen.filter((c) => c.id !== person.id))}
              >
                {t('tickets.pickers.removeShort')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {searching && (
        <>
          <input
            id={`${id}-search`}
            type="search"
            autoComplete="off"
            aria-describedby={[hintId, describedBy].filter(Boolean).join(' ')}
            aria-required={required || undefined}
            aria-invalid={invalid || undefined}
            disabled={disabled}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter never submits the form around it: it takes the only match, if there is one.
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const only = offered.length === 1 ? offered[0] : undefined;
              if (only) take(only);
            }}
          />
          <p id={hintId} className="form-hint">
            {hint ?? t('tickets.pickers.personHint')}
          </p>
          {offered.length > 0 && (
            <ul className="person-picker-found">
              {offered.map((person) => (
                <li key={person.id}>
                  <button type="button" className="button-secondary" onClick={() => take(person)}>
                    {person.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p role="status" className={said ? 'form-hint' : 'visually-hidden'}>
            {said}
          </p>
        </>
      )}
    </div>
  );
}
