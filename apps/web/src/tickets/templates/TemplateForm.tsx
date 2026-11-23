import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { type EditorTools, EditorToolsProvider } from '../../richtext/EditorTools';
import { RichTextEditor } from '../../richtext/RichTextEditor';
import { PersonPicker } from '../PersonPicker';
import { pickerQuery, ticketToolsClient } from '../tools/client';
import type {
  FieldChoice,
  FieldRule,
  FieldValueOption,
  Named,
  SavedTemplate,
  TemplateClient,
  TemplateOptions,
  TrackChoice,
} from './client';
import {
  bodyOf,
  clearedRefusal,
  draftOf,
  editedSpots,
  FORM_FIELD_TYPES,
  foundByEach,
  keptValues,
  NAMED_VALUE_TYPES,
  type PersonSearch,
  type ProblemSpot,
  personSearchOf,
  type Refusal,
  SUBTICKET_RANK,
  saveRefusalOf,
  TRACK_VALUE_TYPES,
} from './draft';

const MAX_SUBTICKETS = 50;

/**
 * What the description's blocks reach (NTF-013, T-120): another ticket, through search, as the
 * person may see it. A template has no files of its own.
 */
const TEMPLATE_EDITOR_TOOLS: EditorTools = {
  tickets: (typed) => {
    const query = pickerQuery(typed);
    return query ? ticketToolsClient.pick(query) : Promise.resolve([]);
  },
};

/** Why the server refused a control's value, under it (T-291). */
function Problem({ id, text }: { id: string; text: string | undefined }) {
  return text ? (
    <p id={id} className="form-error">
      {text}
    </p>
  ) : null;
}

/** What a control with a refused value carries: marked invalid, described by the reason. */
function invalidProps(problemId: string, problem: string | undefined, hintId?: string) {
  const described = [hintId, problem ? problemId : undefined].filter(Boolean).join(' ');
  return {
    'aria-invalid': problem ? true : undefined,
    'aria-describedby': described === '' ? undefined : described,
  };
}

/** A track's releases or areas a list offers: the open ones, and archived ones already chosen. */
const listed = (options: TrackChoice[], chosen: number[]) =>
  options.filter((o) => !o.archived || chosen.includes(o.id));

/** A list to choose several from, one line per option. */
function Several({
  label,
  options,
  chosen,
  onChange,
  problem,
}: {
  label: string;
  options: TrackChoice[];
  chosen: number[];
  onChange: (ids: number[]) => void;
  problem: string | undefined;
}) {
  const t = useT();
  const id = useId();
  const shown = listed(options, chosen);
  return (
    <div className="form-field">
      <label htmlFor={id} className="form-label">
        {label}
      </label>
      <select
        id={id}
        multiple
        size={Math.min(4, Math.max(shown.length, 2))}
        value={chosen.map(String)}
        {...invalidProps(`${id}-problem`, problem)}
        onChange={(e) => onChange([...e.target.selectedOptions].map((o) => Number(o.value)))}
      >
        {shown.map((o) => (
          <option key={o.id} value={o.id}>
            {o.archived ? t('tickets.templates.archivedValue', { name: o.name }) : o.name}
          </option>
        ))}
      </select>
      <Problem id={`${id}-problem`} text={problem} />
    </div>
  );
}

/**
 * What a custom field's list offers to add (T-299): the track's open releases or areas it does
 * not hold yet, or, when the track has none open, the line saying so.
 */
interface ListPicker {
  options: TrackChoice[];
  /** Said when the track has no open release or area at all. */
  empty: string | null;
}

/**
 * What a custom person, group or team field finds to add (T-350): the create form's picker, its
 * search field named for the field, looking where the create form looks.
 */
interface Finder {
  label: string;
  kind: 'people' | 'groups' | 'teams';
  /** Said under the search field; the kind's own words by default. */
  hint?: string;
  find: (typed: string) => Promise<Named[]>;
  take: (found: Named) => void;
}

/**
 * The values a custom release, area, person, group or team field holds (T-291, T-299), each by
 * its name with a way to remove it; for a release or area field, a list of the track's open ones
 * to add, as the create form picks them (T-299); for a person, group or team field, the create
 * form's search to find one to add (T-350).
 */
function ListedValues({
  field,
  ids,
  nameOf,
  hint,
  picker,
  finder = null,
  onChange,
  problem,
}: {
  field: FieldChoice;
  ids: number[];
  /** A value's name; null while the names are still being read. */
  nameOf: ((value: number) => string) | null;
  hint: string;
  picker: ListPicker | null;
  finder?: Finder | null;
  onChange: (ids: number[]) => void;
  problem: string | undefined;
}) {
  const t = useT();
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const none = useRef<HTMLParagraphElement>(null);
  const adder = useRef<HTMLDivElement>(null);
  const focusAt = useRef<number | 'picker' | null>(null);
  const [choice, setChoice] = useState('');
  useEffect(() => {
    if (focusAt.current === null) return;
    if (focusAt.current === 'picker') {
      // Added: the list or search to add from keeps the focus, for the next one, or the new
      // value's button when the field holds one.
      const buttons = list.current?.querySelectorAll('button') ?? [];
      const control = adder.current?.querySelector<HTMLElement>('select, input');
      (control ?? buttons[buttons.length - 1])?.focus();
    } else {
      // The focus was on the button just removed: the next one takes it, or the line saying none.
      const buttons = list.current?.querySelectorAll('button') ?? [];
      const next = buttons[Math.min(focusAt.current, buttons.length - 1)];
      (next ?? none.current)?.focus();
    }
    focusAt.current = null;
  });
  const described = [`${id}-hint`, problem ? `${id}-problem` : undefined].filter(Boolean).join(' ');
  // A field that holds one offers another once its value is removed.
  const open = field.multiple || ids.length === 0;
  const offered = picker && open ? picker.options : [];
  const finding = finder !== null && open && nameOf !== null;
  const add = () => {
    const value = Number(choice);
    if (!value || ids.includes(value)) return;
    focusAt.current = 'picker';
    setChoice('');
    onChange([...ids, value]);
  };
  let values = (
    <p ref={none} tabIndex={-1} className="form-hint">
      {t('tickets.templates.noTrackValues')}
    </p>
  );
  if (ids.length > 0 && nameOf === null) {
    values = <p className="form-hint">{t('tickets.templates.loadingNames')}</p>;
  } else if (ids.length > 0 && nameOf !== null) {
    values = (
      <ul
        ref={list}
        className="ticket-template-values"
        aria-labelledby={`${id}-label`}
        aria-describedby={described}
      >
        {ids.map((value, at) => {
          const name = nameOf(value);
          return (
            <li key={value}>
              <span>{name}</span>
              <button
                type="button"
                className="button-secondary"
                aria-label={t('tickets.templates.removeValue', {
                  value: name,
                  field: field.name,
                })}
                onClick={() => {
                  focusAt.current = at;
                  onChange(ids.filter((x) => x !== value));
                }}
              >
                {t('tickets.templates.remove')}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className="form-field">
      <span id={`${id}-label`} className="form-label">
        {field.name}
      </span>
      {values}
      {offered.length > 0 && (
        <div ref={adder} className="ticket-template-row">
          <div className="form-field">
            <label htmlFor={`${id}-add`} className="form-label">
              {t('tickets.templates.addTrackValueLabel', { type: field.type, field: field.name })}
            </label>
            <select
              id={`${id}-add`}
              value={choice}
              {...invalidProps(`${id}-problem`, ids.length === 0 ? problem : undefined)}
              onChange={(e) => setChoice(e.target.value)}
            >
              <option value="">{t('tickets.create.none')}</option>
              {offered.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="button-secondary"
            disabled={choice === ''}
            aria-label={t('tickets.templates.addValueTo', { field: field.name })}
            onClick={add}
          >
            {t('tickets.templates.addValue')}
          </button>
        </div>
      )}
      {finding && (
        <div ref={adder} className="ticket-template-find">
          <PersonPicker
            label={finder.label}
            kind={finder.kind}
            {...(finder.hint ? { hint: finder.hint } : {})}
            // What the field holds already is not offered again.
            search={async (typed) =>
              (await finder.find(typed)).filter((found) => !ids.includes(found.id))
            }
            chosen={[]}
            multiple
            describedBy={ids.length === 0 && problem ? `${id}-problem` : undefined}
            invalid={ids.length === 0 && problem !== undefined}
            onChange={([found]) => {
              if (!found || ids.includes(found.id)) return;
              focusAt.current = 'picker';
              finder.take({ id: found.id, name: found.name });
            }}
          />
        </div>
      )}
      {picker?.empty && <p className="form-hint">{picker.empty}</p>}
      <p id={`${id}-hint`} className="form-hint">
        {hint}
      </p>
      <Problem id={`${id}-problem`} text={problem} />
    </div>
  );
}

/**
 * Finding the person a track's template assigns, with the create form's person picker and its
 * assignee search: only people who may be given tickets in the track (T-269). One the reader may
 * not see named, or who is gone, shows by number and can be removed (T-283).
 */
function AssigneeChooser({
  client,
  track,
  chosen,
  onChange,
  problem,
}: {
  client: TemplateClient;
  track: string;
  chosen: Named | null;
  onChange: (person: Named | null) => void;
  problem: string | undefined;
}) {
  const t = useT();
  const id = useId();
  return (
    <div className="form-field">
      <PersonPicker
        label={t('workflow.field.assignee')}
        hint={t('tickets.templates.assigneeHint')}
        search={(typed) => client.assignable(track, typed)}
        chosen={
          chosen
            ? [
                {
                  id: chosen.id,
                  name:
                    chosen.name ||
                    t('tickets.templates.unnamedValue', { type: 'user', id: chosen.id }),
                },
              ]
            : []
        }
        removeLabel={(name) => t('tickets.templates.removeAssignee', { name })}
        describedBy={problem ? `${id}-problem` : undefined}
        invalid={problem !== undefined}
        onChange={(people) => {
          const person = people[0];
          onChange(person ? { id: person.id, name: person.name } : null);
        }}
      />
      <Problem id={`${id}-problem`} text={problem} />
    </div>
  );
}

/** One custom field's value, its control by the field's type. */
function FieldValue({
  field,
  options,
  value,
  onChange,
  problem,
}: {
  field: FieldChoice;
  options: FieldValueOption[];
  value: string | string[];
  onChange: (value: string | string[]) => void;
  problem: string | undefined;
}) {
  const t = useT();
  const id = useId();
  const text = typeof value === 'string' ? value : '';
  const hintId = field.type === 'labels' ? `${id}-hint` : undefined;
  const marked = invalidProps(`${id}-problem`, problem, hintId);
  let control = (
    <input
      id={id}
      type={field.type === 'url' ? 'url' : 'text'}
      value={text}
      {...marked}
      onChange={(e) => onChange(e.target.value)}
    />
  );
  if (field.type === 'date') {
    control = (
      <input
        id={id}
        type="date"
        value={text}
        {...marked}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else if (field.type === 'number') {
    control = (
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={text}
        {...marked}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else if (field.type === 'select' && field.multiple) {
    control = (
      <select
        id={id}
        multiple
        size={Math.min(4, Math.max(options.length, 2))}
        value={Array.isArray(value) ? value : []}
        {...marked}
        onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.value}
          </option>
        ))}
      </select>
    );
  } else if (field.type === 'select') {
    control = (
      <select id={id} value={text} {...marked} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('tickets.create.none')}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.value}
          </option>
        ))}
      </select>
    );
  }
  return (
    <div className="form-field">
      <label htmlFor={id} className="form-label">
        {field.name}
      </label>
      {control}
      {hintId && (
        <p id={hintId} className="form-hint">
          {t('tickets.create.labelsHint')}
        </p>
      )}
      <Problem id={`${id}-problem`} text={problem} />
    </div>
  );
}

export interface TemplateFormProps {
  client: TemplateClient;
  track: string | null;
  options: TemplateOptions;
  /** The template to edit; null for a new one. */
  template: SavedTemplate | null;
  onSaved: (saved: SavedTemplate) => void;
  onCancel: () => void;
}

/**
 * A ticket template's form (CORE-029): what it holds, named as the create form names it. Values
 * it has no control for stay as they are: custom fields of other types, and the assignee of a
 * template for every track, are set through the API. A custom release or area field's values
 * show by name and can be removed (T-291) or added from the track's open ones (T-299); a custom
 * person, group or team field's show by name and can be removed (T-299) or found with the create
 * form's searches and added (T-350). A refused save says why next to each value (T-291), until
 * that value is edited (T-299).
 */
export function TemplateForm({
  client,
  track,
  options,
  template,
  onSaved,
  onCancel,
}: TemplateFormProps) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(template, options.fields));
  const [fieldOptions, setFieldOptions] = useState<Record<string, FieldValueOption[]>>({});
  const [adding, setAdding] = useState('');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  // The names of the people, groups and teams the template's values name; null while read.
  const [names, setNames] = useState<Record<string, Named[]> | null>(null);
  // Those found and added here, by field id, named as the search named them (T-350).
  const [picked, setPicked] = useState<Record<string, Named[]>>({});
  // The contexts of the person fields in use, to know whom each allows; 'failed' if unread.
  const [rules, setRules] = useState<Record<string, FieldRule[] | 'failed'>>({});
  // Whether the saved template names anyone: only then are names read before values show.
  const [namesSaved] = useState(
    () => Object.keys(draftOf(template, options.fields).namedValues).length > 0,
  );
  const trackId = options.track?.id ?? null;
  const trackKey = options.track?.key ?? null;
  // The draft as last rendered, for a control that keeps the change handler it was first given.
  const shownDraft = useRef(draft);
  shownDraft.current = draft;
  // An edited value's reason goes: the person is changing what was refused (T-299).
  const change = (part: Partial<typeof draft>) => {
    const before = shownDraft.current;
    setDraft((d) => ({ ...d, ...part }));
    setRefusal((r) => clearedRefusal(r, editedSpots(before, { ...before, ...part })));
  };
  const offered = options.fields.filter((f) => FORM_FIELD_TYPES.has(f.type));
  // A track's template can be given a custom release or area value from the track's lists.
  const listable =
    options.track === null ? [] : options.fields.filter((f) => TRACK_VALUE_TYPES.has(f.type));
  const fieldIds = Object.keys(draft.fields);
  const chosenSelects = fieldIds.filter(
    (fieldId) => offered.find((f) => String(f.id) === fieldId)?.type === 'select',
  );
  const selectsKey = chosenSelects.join(',');
  const fieldsOf = (values: Record<string, number[]>) =>
    Object.keys(values).flatMap((fieldId) => {
      const field = options.fields.find((f) => String(f.id) === fieldId);
      return field ? [field] : [];
    });
  const trackFields = fieldsOf(draft.trackValues);
  const namedFields = fieldsOf(draft.namedValues);
  // Any template can be given a person, group or team value, found as the create form finds it.
  const nameable = options.fields.filter((f) => NAMED_VALUE_TYPES.has(f.type));
  const addable = [...offered, ...listable, ...nameable].filter(
    (f) =>
      !fieldIds.includes(String(f.id)) &&
      draft.trackValues[String(f.id)] === undefined &&
      draft.namedValues[String(f.id)] === undefined,
  );
  const templateId = template?.id ?? null;
  const namesWanted = templateId !== null && namesSaved;
  const peopleKey = namedFields
    .filter((f) => f.type === 'user')
    .map((f) => f.id)
    .join(',');

  // The names of the people, groups and teams the template holds, as far as this person may see
  // them; one with no name is shown as hidden or gone.
  useEffect(() => {
    if (!namesWanted || templateId === null) return;
    let live = true;
    client.names(templateId).then(
      (found) => live && setNames(found),
      () => live && setNames({}),
    );
    return () => {
      live = false;
    };
  }, [client, templateId, namesWanted]);

  // The contexts of the person fields in use, as they join the form: whom each allows (T-350).
  useEffect(() => {
    let live = true;
    for (const fieldId of peopleKey === '' ? [] : peopleKey.split(',')) {
      client.fieldRules(Number(fieldId)).then(
        (list) => live && setRules((known) => ({ ...known, [fieldId]: list })),
        () => live && setRules((known) => ({ ...known, [fieldId]: 'failed' })),
      );
    }
    return () => {
      live = false;
    };
  }, [client, peopleKey]);

  // The options of the choice fields in use; loaded as they join the form.
  useEffect(() => {
    let live = true;
    for (const fieldId of selectsKey === '' ? [] : selectsKey.split(',')) {
      client.fieldOptions(Number(fieldId), trackId).then(
        (list) => live && setFieldOptions((known) => ({ ...known, [fieldId]: list })),
        () => {},
      );
    }
    return () => {
      live = false;
    };
  }, [client, trackId, selectsKey]);

  const subticketTypes = options.types.filter((type) => type.level?.rank === SUBTICKET_RANK);
  const kept = keptValues(template, options.fields);
  const showAreas = listed(options.areas, draft.areaIds).length > 0;
  const showReleases =
    listed(options.releases, [...draft.targetReleaseIds, ...draft.foundInReleaseIds]).length > 0;

  // Where this form shows a refused value's reason; one it has no place for keeps the general line.
  const spots = new Set<ProblemSpot>([
    'name',
    'purpose',
    'ticketTypeIds',
    'summary',
    'description',
    'priority',
    'labels',
    'startInDays',
    'dueInDays',
    ...(track !== null ? ['assignee'] : []),
    ...(showAreas ? ['areaIds'] : []),
    ...(showReleases ? ['targetReleaseIds', 'foundInReleaseIds'] : []),
    ...fieldIds.filter((f) => offered.some((o) => String(o.id) === f)).map((f) => `field:${f}`),
    ...trackFields.map((f) => `field:${f.id}`),
    ...namedFields.map((f) => `field:${f.id}`),
    ...draft.subtickets.flatMap((_, i) => [
      `subticket:${i}`,
      ...(subticketTypes.length > 1 ? [`subticket:${i}:type`] : []),
    ]),
  ]);
  const problemAt = (spot: ProblemSpot) => {
    const message = refusal?.at[spot];
    return message ? t(message) : undefined;
  };
  const general = refusal
    ? Object.keys(refusal.at).some((spot) => !spots.has(spot))
      ? t('tickets.templates.problem.invalid')
      : t(refusal.message)
    : null;

  // The types a ticket made from this template can have: those it names, or any of the track's.
  const typesFitted =
    draft.ticketTypeIds.length > 0 ? draft.ticketTypeIds : options.types.map((type) => type.id);

  /**
   * Where a person, group or team field finds values to add (T-350), as the create form looks:
   * the track's people, or only those the field allows for the types the template fits; the
   * site's groups and teams. A template for every track finds people in the whole site, unless
   * the field allows only some people somewhere: the server says whom only per track and type.
   * Null while the field's contexts are read, or when there is nowhere to look.
   */
  function finderOf(field: FieldChoice): Finder | null {
    const key = String(field.id);
    const take = (found: Named) => {
      setPicked((known) => ({ ...known, [key]: [...(known[key] ?? []), found] }));
      const held = shownDraft.current.namedValues[key] ?? [];
      change({
        namedValues: {
          ...shownDraft.current.namedValues,
          [key]: field.multiple ? [...held, found.id] : [found.id],
        },
      });
    };
    const label = t('tickets.templates.addNamedValueLabel', {
      type: field.type,
      field: field.name,
    });
    if (field.type === 'group') {
      return { label, kind: 'groups', find: (typed) => client.groups(field.id, typed), take };
    }
    if (field.type === 'team') {
      return { label, kind: 'teams', find: (typed) => client.teams(typed), take };
    }
    const known = rules[key];
    if (known === undefined || known === 'failed') return null;
    const search: PersonSearch = personSearchOf(known, trackId, typesFitted);
    if (search.kind === 'none') return null;
    if (search.kind === 'anyone') {
      return {
        label,
        kind: 'people',
        find: (typed) =>
          trackKey === null ? client.sitePeople(typed) : client.people(trackKey, typed),
        take,
      };
    }
    const inTrack = trackKey ?? '';
    return {
      label,
      kind: 'people',
      hint: t('tickets.create.restrictedHint'),
      find: async (typed) =>
        foundByEach(
          await Promise.all(
            search.typeIds.map((typeId) => client.fieldPeople(field.id, inTrack, typeId, typed)),
          ),
        ),
      take,
    };
  }

  /** What is said under a person, group or team field's values. */
  function namedHint(field: FieldChoice, finder: Finder | null) {
    if (finder !== null) return t('tickets.templates.namedValuesHint');
    const known = rules[String(field.id)];
    if (field.type === 'user' && known === undefined) return t('tickets.templates.namedValuesHint');
    if (field.type === 'user' && known !== 'failed') {
      return t('tickets.templates.restrictedEveryTrack');
    }
    return t('tickets.templates.apiValuesHint');
  }

  const save = () => {
    if (draft.name.trim() === '') return;
    setBusy(true);
    setRefusal(null);
    const body = bodyOf(draft, template, options.fields, track);
    (template ? client.update(template.id, body) : client.create(body)).then(onSaved, (error) => {
      setBusy(false);
      setRefusal(saveRefusalOf(error, draft, options.fields));
    });
  };

  return (
    <form
      className="glass-card ticket-template-form"
      aria-label={
        template
          ? t('tickets.templates.editOf', { name: template.name })
          : t('tickets.templates.new')
      }
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      noValidate
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('tickets.templates.name')}
        </label>
        <input
          id={`${id}-name`}
          type="text"
          required
          aria-required="true"
          maxLength={255}
          value={draft.name}
          {...invalidProps(`${id}-name-problem`, problemAt('name'))}
          onChange={(e) => change({ name: e.target.value })}
        />
        <Problem id={`${id}-name-problem`} text={problemAt('name')} />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-purpose`} className="form-label">
          {t('tickets.templates.purpose')}
        </label>
        <input
          id={`${id}-purpose`}
          type="text"
          maxLength={2000}
          value={draft.purpose}
          {...invalidProps(`${id}-purpose-problem`, problemAt('purpose'))}
          onChange={(e) => change({ purpose: e.target.value })}
        />
        <Problem id={`${id}-purpose-problem`} text={problemAt('purpose')} />
      </div>
      <fieldset
        className="sets-choices"
        aria-describedby={problemAt('ticketTypeIds') ? `${id}-types-problem` : undefined}
      >
        <legend>{t('tickets.templates.types')}</legend>
        {options.types.map((type) => (
          <div key={type.id} className="form-field form-field-inline">
            <input
              id={`${id}-type-${type.id}`}
              type="checkbox"
              checked={draft.ticketTypeIds.includes(type.id)}
              onChange={(e) =>
                change({
                  ticketTypeIds: e.target.checked
                    ? [...draft.ticketTypeIds, type.id]
                    : draft.ticketTypeIds.filter((x) => x !== type.id),
                })
              }
            />
            <label htmlFor={`${id}-type-${type.id}`}>{type.name}</label>
          </div>
        ))}
        <p className="form-hint">{t('tickets.templates.typesHint')}</p>
        <Problem id={`${id}-types-problem`} text={problemAt('ticketTypeIds')} />
      </fieldset>
      <div className="form-field">
        <label htmlFor={`${id}-summary`} className="form-label">
          {t('workflow.field.summary')}
        </label>
        <input
          id={`${id}-summary`}
          type="text"
          {...invalidProps(`${id}-summary-problem`, problemAt('summary'), `${id}-summary-hint`)}
          value={draft.summary}
          onChange={(e) => change({ summary: e.target.value })}
        />
        <p id={`${id}-summary-hint`} className="form-hint">
          {t('tickets.templates.summaryHint', {
            date: '{date}',
            track: '{track}',
            user: '{user}',
          })}
        </p>
        <Problem id={`${id}-summary-problem`} text={problemAt('summary')} />
      </div>
      <div className="form-field">
        <span id={`${id}-description`} className="form-label rt-label">
          {t('workflow.field.description')}
        </span>
        <EditorToolsProvider value={TEMPLATE_EDITOR_TOOLS}>
          <RichTextEditor
            labelledBy={`${id}-description`}
            initial={template?.description ?? null}
            onChange={(doc) => change({ description: doc })}
          />
        </EditorToolsProvider>
        <Problem id={`${id}-description-problem`} text={problemAt('description')} />
      </div>
      <div className="ticket-template-grid">
        <div className="form-field">
          <label htmlFor={`${id}-priority`} className="form-label">
            {t('workflow.field.priority')}
          </label>
          <select
            id={`${id}-priority`}
            value={draft.priorityId}
            {...invalidProps(`${id}-priority-problem`, problemAt('priority'))}
            onChange={(e) => change({ priorityId: e.target.value })}
          >
            <option value="">{t('tickets.templates.priorityDefault')}</option>
            {options.priorities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Problem id={`${id}-priority-problem`} text={problemAt('priority')} />
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-labels`} className="form-label">
            {t('workflow.field.labels')}
          </label>
          <input
            id={`${id}-labels`}
            type="text"
            value={draft.labels}
            {...invalidProps(`${id}-labels-problem`, problemAt('labels'), `${id}-labels-hint`)}
            onChange={(e) => change({ labels: e.target.value })}
          />
          <p id={`${id}-labels-hint`} className="form-hint">
            {t('tickets.create.labelsHint')}
          </p>
          <Problem id={`${id}-labels-problem`} text={problemAt('labels')} />
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-start`} className="form-label">
            {t('tickets.templates.startInDays')}
          </label>
          <input
            id={`${id}-start`}
            type="number"
            step={1}
            min={-3650}
            max={3650}
            value={draft.startInDays}
            {...invalidProps(`${id}-start-problem`, problemAt('startInDays'))}
            onChange={(e) => change({ startInDays: e.target.value })}
          />
          <Problem id={`${id}-start-problem`} text={problemAt('startInDays')} />
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-due`} className="form-label">
            {t('tickets.templates.dueInDays')}
          </label>
          <input
            id={`${id}-due`}
            type="number"
            step={1}
            min={-3650}
            max={3650}
            value={draft.dueInDays}
            {...invalidProps(`${id}-due-problem`, problemAt('dueInDays'))}
            onChange={(e) => change({ dueInDays: e.target.value })}
          />
          <Problem id={`${id}-due-problem`} text={problemAt('dueInDays')} />
        </div>
        {track !== null && (
          <AssigneeChooser
            client={client}
            track={track}
            chosen={draft.assignee}
            onChange={(assignee) => change({ assignee })}
            problem={problemAt('assignee')}
          />
        )}
        {showAreas && (
          <Several
            label={t('workflow.field.area')}
            options={options.areas}
            chosen={draft.areaIds}
            onChange={(areaIds) => change({ areaIds })}
            problem={problemAt('areaIds')}
          />
        )}
        {showReleases && (
          <>
            <Several
              label={t('workflow.field.targetRelease')}
              options={options.releases}
              chosen={draft.targetReleaseIds}
              onChange={(targetReleaseIds) => change({ targetReleaseIds })}
              problem={problemAt('targetReleaseIds')}
            />
            <Several
              label={t('workflow.field.foundInRelease')}
              options={options.releases}
              chosen={draft.foundInReleaseIds}
              onChange={(foundInReleaseIds) => change({ foundInReleaseIds })}
              problem={problemAt('foundInReleaseIds')}
            />
          </>
        )}
      </div>
      {(addable.length > 0 ||
        fieldIds.length > 0 ||
        trackFields.length > 0 ||
        namedFields.length > 0 ||
        kept > 0) && (
        <fieldset className="sets-choices ticket-template-fields">
          <legend>{t('tickets.templates.customFields')}</legend>
          {fieldIds.map((fieldId) => {
            const field = offered.find((f) => String(f.id) === fieldId);
            if (!field) return null;
            return (
              <div key={fieldId} className="ticket-template-row">
                <FieldValue
                  field={field}
                  options={fieldOptions[fieldId] ?? []}
                  value={draft.fields[fieldId] ?? ''}
                  onChange={(value) => change({ fields: { ...draft.fields, [fieldId]: value } })}
                  problem={problemAt(`field:${fieldId}`)}
                />
                <button
                  type="button"
                  className="button-secondary"
                  aria-label={t('tickets.templates.removeField', { name: field.name })}
                  onClick={() => {
                    const { [fieldId]: _gone, ...rest } = draft.fields;
                    change({ fields: rest });
                  }}
                >
                  {t('tickets.templates.remove')}
                </button>
              </div>
            );
          })}
          {trackFields.map((field) => {
            const ids = draft.trackValues[String(field.id)] ?? [];
            const list = field.type === 'area' ? options.areas : options.releases;
            const open = list.filter((o) => !o.archived);
            return (
              <ListedValues
                key={field.id}
                field={field}
                ids={ids}
                nameOf={(value) => {
                  const found = list.find((n) => n.id === value);
                  if (!found) {
                    return t('tickets.templates.valueNotInTrack', { type: field.type, id: value });
                  }
                  return found.archived
                    ? t('tickets.templates.archivedValue', { name: found.name })
                    : found.name;
                }}
                hint={t(
                  // A template for every track has no releases or areas to add from.
                  options.track === null
                    ? 'tickets.templates.apiValuesHint'
                    : 'tickets.templates.trackValuesHint',
                )}
                picker={
                  options.track === null
                    ? null
                    : {
                        options: open.filter((o) => !ids.includes(o.id)),
                        empty:
                          open.length === 0
                            ? t(
                                field.type === 'area'
                                  ? 'tickets.create.noAreas'
                                  : 'tickets.create.noReleases',
                              )
                            : null,
                      }
                }
                onChange={(next) =>
                  change({ trackValues: { ...draft.trackValues, [String(field.id)]: next } })
                }
                problem={problemAt(`field:${field.id}`)}
              />
            );
          })}
          {namedFields.map((field) => {
            const known = [...(names?.[`fields.${field.id}`] ?? []), ...(picked[field.id] ?? [])];
            const finder = finderOf(field);
            return (
              <ListedValues
                key={field.id}
                field={field}
                ids={draft.namedValues[String(field.id)] ?? []}
                nameOf={
                  names === null && namesWanted
                    ? null
                    : (value) =>
                        known.find((n) => n.id === value)?.name ??
                        t('tickets.templates.unnamedValue', { type: field.type, id: value })
                }
                hint={namedHint(field, finder)}
                picker={null}
                finder={finder}
                onChange={(next) =>
                  change({ namedValues: { ...draft.namedValues, [String(field.id)]: next } })
                }
                problem={problemAt(`field:${field.id}`)}
              />
            );
          })}
          {addable.length > 0 && (
            <div className="ticket-template-row">
              <div className="form-field">
                <label htmlFor={`${id}-add-field`} className="form-label">
                  {t('tickets.templates.addFieldLabel')}
                </label>
                <select
                  id={`${id}-add-field`}
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                >
                  <option value="">{t('tickets.create.none')}</option>
                  {addable.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="button-secondary"
                disabled={adding === ''}
                onClick={() => {
                  const field = addable.find((f) => String(f.id) === adding);
                  if (field && TRACK_VALUE_TYPES.has(field.type)) {
                    change({ trackValues: { ...draft.trackValues, [adding]: [] } });
                  } else if (field && NAMED_VALUE_TYPES.has(field.type)) {
                    change({ namedValues: { ...draft.namedValues, [adding]: [] } });
                  } else {
                    change({
                      fields: {
                        ...draft.fields,
                        [adding]: field?.type === 'select' && field.multiple ? [] : '',
                      },
                    });
                  }
                  setAdding('');
                }}
              >
                {t('tickets.templates.addField')}
              </button>
            </div>
          )}
          {kept > 0 && (
            <p className="form-hint">{t('tickets.templates.keptFields', { count: kept })}</p>
          )}
        </fieldset>
      )}
      <fieldset className="sets-choices ticket-template-fields">
        <legend>{t('tickets.templates.subtickets')}</legend>
        {draft.subtickets.map((sub, i) => {
          const number = i + 1;
          const set = (part: Partial<typeof sub>) =>
            change({
              subtickets: draft.subtickets.map((s, at) => (at === i ? { ...s, ...part } : s)),
            });
          const rowProblem = problemAt(`subticket:${i}`);
          const typeProblem = problemAt(`subticket:${i}:type`);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; removing one renumbers the rest
            <div key={i} className="ticket-template-row">
              <div className="form-field">
                <label htmlFor={`${id}-sub-${i}`} className="form-label">
                  {t('tickets.templates.subticketSummary', { number })}
                </label>
                <input
                  id={`${id}-sub-${i}`}
                  type="text"
                  value={sub.summary}
                  {...invalidProps(`${id}-sub-${i}-problem`, rowProblem)}
                  onChange={(e) => set({ summary: e.target.value })}
                />
                <Problem id={`${id}-sub-${i}-problem`} text={rowProblem} />
              </div>
              {subticketTypes.length > 1 && (
                <div className="form-field">
                  <label htmlFor={`${id}-sub-type-${i}`} className="form-label">
                    {t('tickets.templates.subticketType', { number })}
                  </label>
                  <select
                    id={`${id}-sub-type-${i}`}
                    value={sub.ticketTypeId}
                    {...invalidProps(`${id}-sub-type-${i}-problem`, typeProblem)}
                    onChange={(e) => set({ ticketTypeId: e.target.value })}
                  >
                    <option value="">{t('tickets.templates.subticketTypeFirst')}</option>
                    {subticketTypes.map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.name}
                      </option>
                    ))}
                  </select>
                  <Problem id={`${id}-sub-type-${i}-problem`} text={typeProblem} />
                </div>
              )}
              <button
                type="button"
                className="button-secondary"
                aria-label={t('tickets.templates.removeSubticket', { number })}
                onClick={() => {
                  // The rows after it move up: a reason shown on a row would land on another.
                  setRefusal(null);
                  change({ subtickets: draft.subtickets.filter((_, at) => at !== i) });
                }}
              >
                {t('tickets.templates.remove')}
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="button-secondary"
          disabled={draft.subtickets.length >= MAX_SUBTICKETS}
          onClick={() =>
            change({ subtickets: [...draft.subtickets, { summary: '', ticketTypeId: '' }] })
          }
        >
          {t('tickets.templates.addSubticket')}
        </button>
      </fieldset>
      {general && (
        <p role="alert" className="form-error">
          {general}
        </p>
      )}
      <div className="form-actions">
        <button
          type="submit"
          className="button-primary"
          disabled={busy || draft.name.trim() === ''}
        >
          {t('tickets.templates.save')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('tickets.templates.cancel')}
        </button>
      </div>
    </form>
  );
}
