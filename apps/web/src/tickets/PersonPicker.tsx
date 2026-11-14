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
  /** What it finds: people, or groups for a custom group field (T-265); people by default. */
  kind?: 'people' | 'groups';
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
 * ticket templates' assignee and the create form's people fields use it, and the create form's
 * group fields too (`kind="groups"`, T-265), whose words speak of groups. Focus never falls
 * away with a control that goes: taking someone moves it to the search field, or to their
 * Remove button when the field gives way; removing someone moves it to the search field. The
 * status line says who was taken or removed.
 */
export function PersonPicker({
  label,
  search,
  chosen,
  onChange,
  multiple = false,
  kind = 'people',
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
  const [news, setNews] = useState('');
  const asked = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  /** Where focus goes once a choice has been drawn: the search field, or the chosen list. */
  const moveFocus = useRef<'search' | 'chosen' | null>(null);
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

  useEffect(() => {
    const to = moveFocus.current;
    if (to === null) return;
    moveFocus.current = null;
    if (to === 'search' && searchInput.current) searchInput.current.focus();
    else root.current?.querySelector<HTMLButtonElement>('.person-picker-chosen button')?.focus();
  });

  const searching = multiple || chosen.length === 0;
  const offered = (found ?? []).filter((p) => !chosen.some((c) => c.id === p.id));
  const groups = kind === 'groups';
  const searchSaid = failed
    ? t('tickets.pickers.peopleFailed')
    : found === null
      ? ''
      : offered.length === 0
        ? t(groups ? 'tickets.pickers.noGroups' : 'tickets.pickers.noPeople')
        : t(groups ? 'tickets.pickers.groupsFound' : 'tickets.pickers.peopleFound', {
            count: offered.length,
          });
  const take = (person: PickedPerson) => {
    setText('');
    setFound(null);
    setNews(t('tickets.pickers.personChosen', { name: person.name }));
    moveFocus.current = multiple ? 'search' : 'chosen';
    onChange(multiple ? [...chosen, person] : [person]);
  };
  const remove = (person: PickedPerson) => {
    setNews(t('tickets.pickers.personRemoved', { name: person.name }));
    moveFocus.current = 'search';
    onChange(chosen.filter((c) => c.id !== person.id));
  };
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;

  return (
    <div className="person-picker" ref={root}>
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
                onClick={() => remove(person)}
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
            ref={searchInput}
            value={text}
            onChange={(e) => {
              setNews('');
              setText(e.target.value);
            }}
            onKeyDown={(e) => {
              // Enter never submits the form around it: it takes the only match, if there is one.
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const only = offered.length === 1 ? offered[0] : undefined;
              if (only) take(only);
            }}
          />
          <p id={hintId} className="form-hint">
            {hint ?? t(groups ? 'tickets.pickers.groupHint' : 'tickets.pickers.personHint')}
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
        </>
      )}
      {/* Always there, so what was taken or removed is said even as the search field goes. */}
      <p role="status" className={searchSaid ? 'form-hint' : 'visually-hidden'}>
        {searchSaid || news}
      </p>
    </div>
  );
}
