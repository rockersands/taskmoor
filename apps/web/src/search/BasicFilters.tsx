import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { priorityName } from '../shell/priorityName';
import { typeName } from '../shell/seededNames';
import {
  type BasicQuery,
  CHOICE_FIELDS,
  type ChoiceField,
  DATE_FIELDS,
  DATE_OPS,
  type DateField,
  type DateFilter,
  type DateOp,
  isDay,
  ME,
} from './basic';
import type { SearchClient, SearchTrack } from './client';

/** Short, closed lists show as check boxes; the rest take a typed value with suggestions. */
const TICKED: ReadonlySet<ChoiceField> = new Set(['type', 'priority']);
const PEOPLE: ReadonlySet<ChoiceField> = new Set(['requester', 'creator']);

const isChoice = (field: string): field is ChoiceField =>
  (CHOICE_FIELDS as readonly string[]).includes(field);

export interface BasicFiltersProps {
  basic: BasicQuery;
  /** Every track the person sees. */
  tracks: readonly SearchTrack[];
  client: SearchClient;
  onChange: (basic: BasicQuery) => void;
}

/**
 * The basic mode's filters beyond the common ones (QRY-014, QRY-006): dates and values of a field,
 * each brought in with "Add a filter" and taken away with its own button. Each is plain query text
 * (`basic.ts`); these controls only choose what the text says.
 */
export function BasicFilters({ basic, tracks, client, onChange }: BasicFiltersProps) {
  const t = useT();
  const id = useId();
  const [adding, setAdding] = useState('');
  const added = useRef<string | null>(null);
  const addBox = useRef<HTMLSelectElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const shownChoices = CHOICE_FIELDS.filter((f) => basic.choices?.[f] !== undefined);
  const shownDates = DATE_FIELDS.filter((f) => basic.dates?.some((d) => d.field === f));
  const chosen = tracks.filter((track) => basic.tracks.includes(track.key));

  // A filter just added takes the focus, so the keyboard carries straight on into it.
  useEffect(() => {
    const field = added.current;
    if (!field) return;
    added.current = null;
    rows.current
      ?.querySelector<HTMLElement>(`[data-filter="${field}"] :is(input, select)`)
      ?.focus();
  });

  const add = () => {
    if (adding === '') return;
    added.current = adding;
    setAdding('');
    onChange(
      isChoice(adding)
        ? { ...basic, choices: { ...basic.choices, [adding]: [] } }
        : {
            ...basic,
            dates: [...(basic.dates ?? []), { field: adding as DateField, op: 'on', from: '' }],
          },
    );
  };
  const removeChoice = (field: ChoiceField) => {
    const { [field]: _gone, ...rest } = basic.choices ?? {};
    const { choices: _choices, ...others } = basic;
    onChange(Object.keys(rest).length > 0 ? { ...others, choices: rest } : others);
    addBox.current?.focus();
  };
  const removeDate = (field: DateField) => {
    const rest = (basic.dates ?? []).filter((d) => d.field !== field);
    const { dates: _dates, ...others } = basic;
    onChange(rest.length > 0 ? { ...others, dates: rest } : others);
    addBox.current?.focus();
  };

  const unusedChoices = CHOICE_FIELDS.filter((f) => !shownChoices.includes(f));
  const unusedDates = DATE_FIELDS.filter((f) => !shownDates.includes(f));
  return (
    <>
      <div ref={rows} className="search-filters">
        {shownChoices.map((field) => (
          <ChoiceFilter
            key={field}
            field={field}
            values={basic.choices?.[field] ?? []}
            chosenTracks={chosen}
            tracks={tracks}
            client={client}
            onChange={(values) =>
              onChange({ ...basic, choices: { ...basic.choices, [field]: values } })
            }
            onRemove={() => removeChoice(field)}
          />
        ))}
        {shownDates.map((field) => {
          const filter = basic.dates?.find((d) => d.field === field) as DateFilter;
          return (
            <DateFilterRow
              key={field}
              filter={filter}
              onChange={(next) =>
                onChange({
                  ...basic,
                  dates: (basic.dates ?? []).map((d) => (d.field === field ? next : d)),
                })
              }
              onRemove={() => removeDate(field)}
            />
          );
        })}
      </div>
      {(unusedChoices.length > 0 || unusedDates.length > 0) && (
        <div className="form-field search-filter-add">
          <label htmlFor={`${id}-add`} className="form-label">
            {t('search.filter.add')}
          </label>
          <span className="search-filter-add-row">
            <select
              ref={addBox}
              id={`${id}-add`}
              value={adding}
              onChange={(event) => setAdding(event.target.value)}
            >
              <option value="">{t('search.filter.choose')}</option>
              {unusedDates.length > 0 && (
                <optgroup label={t('search.filter.groupDates')}>
                  {unusedDates.map((f) => (
                    <option key={f} value={f}>
                      {t(`search.filter.${f}`)}
                    </option>
                  ))}
                </optgroup>
              )}
              {unusedChoices.length > 0 && (
                <optgroup label={t('search.filter.groupFields')}>
                  {unusedChoices.map((f) => (
                    <option key={f} value={f}>
                      {t(`search.filter.${f}`)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button
              type="button"
              className="button-secondary search-filter-button"
              disabled={adding === ''}
              onClick={add}
            >
              {t('search.filter.addButton')}
            </button>
          </span>
        </div>
      )}
    </>
  );
}

function RemoveFilter({ name, onRemove }: { name: string; onRemove: () => void }) {
  const t = useT();
  return (
    <button type="button" className="button-quiet search-filter-remove" onClick={onRemove}>
      {t('search.filter.remove', { name })}
    </button>
  );
}

function DateFilterRow({
  filter,
  onChange,
  onRemove,
}: {
  filter: DateFilter;
  onChange: (filter: DateFilter) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const id = useId();
  const name = t(`search.filter.${filter.field}`);
  const between = filter.op === 'between';
  const missing = !isDay(filter.from) || (between && !isDay(filter.to));
  const reversed = between && !missing && (filter.to as string) < filter.from;
  return (
    <fieldset className="search-filter" data-filter={filter.field}>
      <legend>{name}</legend>
      <div className="search-filter-body">
        <div className="form-field">
          <label htmlFor={`${id}-op`} className="form-label">
            {t('search.date.op')}
          </label>
          <select
            id={`${id}-op`}
            value={filter.op}
            onChange={(event) => {
              const op = event.target.value as DateOp;
              const { to: _to, ...rest } = filter;
              onChange(op === 'between' ? { ...filter, op } : { ...rest, op });
            }}
          >
            {DATE_OPS.map((op) => (
              <option key={op} value={op}>
                {t(`search.date.${op}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-from`} className="form-label">
            {between ? t('search.date.from') : t('search.date.day')}
          </label>
          <input
            id={`${id}-from`}
            type="date"
            value={filter.from}
            onChange={(event) => onChange({ ...filter, from: event.target.value })}
          />
        </div>
        {between && (
          <div className="form-field">
            <label htmlFor={`${id}-to`} className="form-label">
              {t('search.date.to')}
            </label>
            <input
              id={`${id}-to`}
              type="date"
              value={filter.to ?? ''}
              aria-invalid={reversed || undefined}
              onChange={(event) => onChange({ ...filter, to: event.target.value })}
            />
          </div>
        )}
        <RemoveFilter name={name} onRemove={onRemove} />
      </div>
      {missing && <p className="form-hint">{t('search.date.missing')}</p>}
      {reversed && <p className="form-hint">{t('search.date.reversed')}</p>}
    </fieldset>
  );
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function ChoiceFilter({
  field,
  values,
  chosenTracks,
  tracks,
  client,
  onChange,
  onRemove,
}: {
  field: ChoiceField;
  values: readonly string[];
  chosenTracks: readonly SearchTrack[];
  tracks: readonly SearchTrack[];
  client: SearchClient;
  onChange: (values: string[]) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const id = useId();
  const name = t(`search.filter.${field}`);
  const [typed, setTyped] = useState('');
  const [options, setOptions] = useState<string[] | null>([]);
  const trackKeys = chosenTracks.map((track) => track.key).join();
  const allKeys = tracks.map((track) => track.key).join();
  const needsTyped = field === 'labels' || PEOPLE.has(field);

  // What the person may see, from the routes the rest of the app uses; a failure only leaves the
  // box without suggestions, and the query is still judged by the server.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the track keys stand for the tracks
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(
      () => {
        client.choiceOptions(field, { typed, chosen: chosenTracks, all: tracks }).then(
          (found) => live && setOptions(found),
          () => live && setOptions([]),
        );
      },
      needsTyped && typed !== '' ? 200 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [client, field, needsTyped ? typed : '', trackKeys, allKeys]);

  const addValue = (raw: string) => {
    const value = raw.trim();
    setTyped('');
    if (value !== '' && !values.some((v) => same(v, value))) onChange([...values, value]);
  };
  const removeValue = (value: string) => onChange(values.filter((v) => v !== value));
  const label = (value: string) => (value === ME ? t('search.assignee.me') : value);
  const known = options ?? [];

  if (TICKED.has(field)) {
    const extras = values.filter((v) => !known.some((o) => same(o, v)));
    return (
      <fieldset className="search-filter" data-filter={field}>
        <legend>{name}</legend>
        <div className="search-filter-body">
          <div className="search-choices">
            {[...known, ...extras].map((option) => {
              const current = values.find((v) => same(v, option));
              return (
                <div key={option} className="form-field form-field-inline">
                  <input
                    id={`${id}-${option}`}
                    type="checkbox"
                    checked={current !== undefined}
                    onChange={(event) =>
                      event.target.checked
                        ? onChange([...values, option])
                        : removeValue(current as string)
                    }
                  />
                  <label htmlFor={`${id}-${option}`}>
                    {field === 'type' ? typeName(t, option) : priorityName(t, option)}
                  </label>
                </div>
              );
            })}
          </div>
          <RemoveFilter name={name} onRemove={onRemove} />
        </div>
      </fieldset>
    );
  }

  const listId = `${id}-options`;
  return (
    <fieldset className="search-filter" data-filter={field}>
      <legend>{name}</legend>
      <div className="search-filter-body">
        {values.length > 0 && (
          <ul className="search-filter-values">
            {values.map((value) => (
              <li key={value}>
                <button
                  type="button"
                  className="search-filter-value"
                  aria-label={t('search.filter.removeValue', { value: label(value), name })}
                  onClick={() => removeValue(value)}
                >
                  {label(value)}
                  <span aria-hidden="true"> ×</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="form-field search-filter-value-box">
          <label htmlFor={`${id}-value`} className="form-label">
            {t('search.filter.value', { name })}
          </label>
          <span className="search-filter-add-row">
            <input
              id={`${id}-value`}
              type="text"
              autoComplete="off"
              list={listId}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                // Enter with something typed adds it; with nothing, it searches as usual.
                if (event.key === 'Enter' && typed.trim() !== '') {
                  event.preventDefault();
                  addValue(typed);
                }
              }}
            />
            <datalist id={listId}>
              {known.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
            <button
              type="button"
              className="button-secondary search-filter-button"
              onClick={() => addValue(typed)}
            >
              {t('search.filter.addValue')}
            </button>
            {PEOPLE.has(field) && !values.includes(ME) && (
              <button
                type="button"
                className="button-secondary search-filter-button"
                onClick={() => onChange([...values, ME])}
              >
                {t('search.assignee.me')}
              </button>
            )}
          </span>
        </div>
        <RemoveFilter name={name} onRemove={onRemove} />
      </div>
      {options === null && <p className="form-hint">{t('search.filter.pickTrack')}</p>}
    </fieldset>
  );
}
