import { useEffect, useId, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { RichTextEditor } from '../../richtext/RichTextEditor';
import { PersonPicker } from '../PersonPicker';
import type {
  FieldChoice,
  FieldValueOption,
  Named,
  SavedTemplate,
  TemplateClient,
  TemplateOptions,
} from './client';
import { bodyOf, draftOf, FORM_FIELD_TYPES, keptValues, refusalOf, SUBTICKET_RANK } from './draft';

const MAX_SUBTICKETS = 50;

/** A list to choose several from, one line per option. */
function Several({
  label,
  options,
  chosen,
  onChange,
}: {
  label: string;
  options: Named[];
  chosen: number[];
  onChange: (ids: number[]) => void;
}) {
  const id = useId();
  return (
    <div className="form-field">
      <label htmlFor={id} className="form-label">
        {label}
      </label>
      <select
        id={id}
        multiple
        size={Math.min(4, Math.max(options.length, 2))}
        value={chosen.map(String)}
        onChange={(e) => onChange([...e.target.selectedOptions].map((o) => Number(o.value)))}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Finding the person a track's template assigns, with the create form's person picker. */
function AssigneeChooser({
  client,
  track,
  chosen,
  onChange,
}: {
  client: TemplateClient;
  track: string;
  chosen: Named | null;
  onChange: (person: Named | null) => void;
}) {
  const t = useT();
  return (
    <div className="form-field">
      <PersonPicker
        label={t('workflow.field.assignee')}
        hint={t('tickets.templates.assigneeHint')}
        search={(typed) => client.people(track, typed)}
        chosen={chosen ? [chosen] : []}
        removeLabel={(name) => t('tickets.templates.removeAssignee', { name })}
        onChange={(people) => {
          const person = people[0];
          onChange(person ? { id: person.id, name: person.name } : null);
        }}
      />
    </div>
  );
}

/** One custom field's value, its control by the field's type. */
function FieldValue({
  field,
  options,
  value,
  onChange,
}: {
  field: FieldChoice;
  options: FieldValueOption[];
  value: string | string[];
  onChange: (value: string | string[]) => void;
}) {
  const t = useT();
  const id = useId();
  const text = typeof value === 'string' ? value : '';
  let control = (
    <input
      id={id}
      type={field.type === 'url' ? 'url' : 'text'}
      value={text}
      onChange={(e) => onChange(e.target.value)}
    />
  );
  if (field.type === 'date') {
    control = <input id={id} type="date" value={text} onChange={(e) => onChange(e.target.value)} />;
  } else if (field.type === 'number') {
    control = (
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={text}
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
      <select id={id} value={text} onChange={(e) => onChange(e.target.value)}>
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
      {field.type === 'labels' && <p className="form-hint">{t('tickets.create.labelsHint')}</p>}
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
 * template for every track, are set through the API.
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
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trackId = options.track?.id ?? null;
  const change = (part: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...part }));
  const offered = options.fields.filter((f) => FORM_FIELD_TYPES.has(f.type));
  const fieldIds = Object.keys(draft.fields);
  const chosenSelects = fieldIds.filter(
    (fieldId) => offered.find((f) => String(f.id) === fieldId)?.type === 'select',
  );
  const selectsKey = chosenSelects.join(',');

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

  const save = () => {
    if (draft.name.trim() === '') return;
    setBusy(true);
    setProblem(null);
    const body = bodyOf(draft, template, options.fields, track);
    (template ? client.update(template.id, body) : client.create(body)).then(onSaved, (error) => {
      setBusy(false);
      setProblem(t(refusalOf(error)));
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
          onChange={(e) => change({ name: e.target.value })}
        />
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
          onChange={(e) => change({ purpose: e.target.value })}
        />
      </div>
      <fieldset className="sets-choices">
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
      </fieldset>
      <div className="form-field">
        <label htmlFor={`${id}-summary`} className="form-label">
          {t('workflow.field.summary')}
        </label>
        <input
          id={`${id}-summary`}
          type="text"
          aria-describedby={`${id}-summary-hint`}
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
      </div>
      <div className="form-field">
        <span id={`${id}-description`} className="form-label rt-label">
          {t('workflow.field.description')}
        </span>
        <RichTextEditor
          labelledBy={`${id}-description`}
          initial={template?.description ?? null}
          onChange={(doc) => change({ description: doc })}
        />
      </div>
      <div className="ticket-template-grid">
        <div className="form-field">
          <label htmlFor={`${id}-priority`} className="form-label">
            {t('workflow.field.priority')}
          </label>
          <select
            id={`${id}-priority`}
            value={draft.priorityId}
            onChange={(e) => change({ priorityId: e.target.value })}
          >
            <option value="">{t('tickets.templates.priorityDefault')}</option>
            {options.priorities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-labels`} className="form-label">
            {t('workflow.field.labels')}
          </label>
          <input
            id={`${id}-labels`}
            type="text"
            value={draft.labels}
            onChange={(e) => change({ labels: e.target.value })}
          />
          <p className="form-hint">{t('tickets.create.labelsHint')}</p>
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
            onChange={(e) => change({ startInDays: e.target.value })}
          />
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
            onChange={(e) => change({ dueInDays: e.target.value })}
          />
        </div>
        {track !== null && (
          <AssigneeChooser
            client={client}
            track={track}
            chosen={draft.assignee}
            onChange={(assignee) => change({ assignee })}
          />
        )}
        {options.areas.length > 0 && (
          <Several
            label={t('workflow.field.area')}
            options={options.areas}
            chosen={draft.areaIds}
            onChange={(areaIds) => change({ areaIds })}
          />
        )}
        {options.releases.length > 0 && (
          <>
            <Several
              label={t('workflow.field.targetRelease')}
              options={options.releases}
              chosen={draft.targetReleaseIds}
              onChange={(targetReleaseIds) => change({ targetReleaseIds })}
            />
            <Several
              label={t('workflow.field.foundInRelease')}
              options={options.releases}
              chosen={draft.foundInReleaseIds}
              onChange={(foundInReleaseIds) => change({ foundInReleaseIds })}
            />
          </>
        )}
      </div>
      {offered.length > 0 && (
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
                {offered
                  .filter((f) => !fieldIds.includes(String(f.id)))
                  .map((f) => (
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
                const field = offered.find((f) => String(f.id) === adding);
                change({
                  fields: {
                    ...draft.fields,
                    [adding]: field?.type === 'select' && field.multiple ? [] : '',
                  },
                });
                setAdding('');
              }}
            >
              {t('tickets.templates.addField')}
            </button>
          </div>
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
                  onChange={(e) => set({ summary: e.target.value })}
                />
              </div>
              {subticketTypes.length > 1 && (
                <div className="form-field">
                  <label htmlFor={`${id}-sub-type-${i}`} className="form-label">
                    {t('tickets.templates.subticketType', { number })}
                  </label>
                  <select
                    id={`${id}-sub-type-${i}`}
                    value={sub.ticketTypeId}
                    onChange={(e) => set({ ticketTypeId: e.target.value })}
                  >
                    <option value="">{t('tickets.templates.subticketTypeFirst')}</option>
                    {subticketTypes.map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <button
                type="button"
                className="button-secondary"
                aria-label={t('tickets.templates.removeSubticket', { number })}
                onClick={() => change({ subtickets: draft.subtickets.filter((_, at) => at !== i) })}
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
      {problem && (
        <p role="alert" className="form-error">
          {problem}
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
