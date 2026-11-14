import { useEffect, useId, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import type { TicketForm } from '../form';
import type { AppliedTemplate, PickerClient, SavedTemplate } from './client';
import { type FormFill, fillForm, labelOfKey } from './start';

/** The template the create form started from. */
export interface PickedTemplate {
  template: SavedTemplate;
  start: Record<string, unknown>;
  extras: string[];
  /** Body keys it filled into the form's pickers (T-265): cleared there, they are left out. */
  picked: string[];
  /** Extras the person turned off: left out of the ticket. */
  off: ReadonlySet<string>;
  /** Whether its subtickets are made too. */
  subtickets: boolean;
}

function useFieldName(form: TicketForm | null) {
  const t = useT();
  return (key: string) => {
    const label = labelOfKey(key, form);
    if ('id' in label) return t(label.id);
    if ('name' in label) return label.name;
    return t('tickets.templates.fieldNumber', { id: label.fieldId });
  };
}

export interface TemplatePickerProps {
  client: PickerClient;
  track: string;
  typeId: number | null;
  /** The form as laid out now; a template can be chosen once it is here. */
  form: TicketForm | null;
  picked: PickedTemplate | null;
  /**
   * The fields whose pickers the form has, which a template's people, groups, teams, releases and
   * areas fill (custom ones as `cf[12]`).
   */
  pickable?: ReadonlySet<string>;
  /** The ids each release and area picker offers, by field key, once its list is here. */
  offered?: Readonly<Record<string, readonly number[]>>;
  /** A template was chosen (with what it fills in), or none. */
  onPick: (picked: PickedTemplate | null, fill: FormFill | null) => void;
  onChange: (picked: PickedTemplate) => void;
}

/**
 * Starting a ticket from a template (CORE-030): the templates that fit the track and ticket type
 * in the create form, shown only when there are some. Choosing one fills the form for review,
 * its pickers too (its assignee, releases and areas, T-265; its custom people, groups, teams,
 * releases and areas, T-276). Values the form cannot edit, and the subtickets, are listed with a
 * checkbox each.
 */
export function TemplatePicker({
  client,
  track,
  typeId,
  form,
  picked,
  pickable,
  offered,
  onPick,
  onChange,
}: TemplatePickerProps) {
  const t = useT();
  const id = useId();
  const fieldName = useFieldName(form);
  const [templates, setTemplates] = useState<SavedTemplate[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setTemplates([]);
    if (track === '' || typeId === null) return;
    let live = true;
    client.list(track, typeId).then(
      (list) => live && setTemplates(list),
      // A form without templates still works: the picker just does not show.
      () => live && setTemplates([]),
    );
    return () => {
      live = false;
    };
  }, [client, track, typeId]);

  if (templates.length === 0) return null;

  const choose = async (value: string) => {
    setFailed(false);
    const template = templates.find((x) => String(x.id) === value);
    if (!template || !form) {
      onPick(null, null);
      return;
    }
    try {
      const { start, names } = await client.start(template.id, track);
      const fill = fillForm(start, form, {
        keys: pickable ?? new Set(),
        assignee: template.assignee,
        names,
        ...(offered ? { offered } : {}),
      });
      onPick(
        {
          template,
          start,
          extras: fill.extras,
          picked: fill.picked,
          off: new Set(),
          subtickets: true,
        },
        fill,
      );
    } catch {
      setFailed(true);
    }
  };

  const count = picked?.template.subtickets.length ?? 0;
  return (
    <div className="ticket-template-picker">
      <div className="form-field">
        <label htmlFor={`${id}-template`} className="form-label">
          {t('tickets.templates.pick')}
        </label>
        <select
          id={`${id}-template`}
          value={picked?.template.id ?? ''}
          disabled={!form}
          onChange={(e) => void choose(e.target.value)}
        >
          <option value="">{t('tickets.templates.pickNone')}</option>
          {templates.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </div>
      {failed && (
        <p role="alert" className="form-error">
          {t('tickets.templates.pickFailed')}
        </p>
      )}
      {picked?.template.purpose && <p className="form-hint">{picked.template.purpose}</p>}
      {picked && picked.extras.length + count > 0 && (
        <fieldset className="sets-choices">
          <legend>{t('tickets.templates.also')}</legend>
          {picked.extras.map((key) => (
            <div key={key} className="form-field form-field-inline">
              <input
                id={`${id}-${key}`}
                type="checkbox"
                checked={!picked.off.has(key)}
                onChange={(e) => {
                  const off = new Set(picked.off);
                  if (e.target.checked) off.delete(key);
                  else off.add(key);
                  onChange({ ...picked, off });
                }}
              />
              <label htmlFor={`${id}-${key}`}>{fieldName(key)}</label>
            </div>
          ))}
          {count > 0 && (
            <div className="form-field form-field-inline">
              <input
                id={`${id}-subtickets`}
                type="checkbox"
                checked={picked.subtickets}
                onChange={(e) => onChange({ ...picked, subtickets: e.target.checked })}
              />
              <label htmlFor={`${id}-subtickets`}>
                {t('tickets.templates.alsoSubtickets', { count })}
              </label>
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}

/** What making a ticket from a template left out, and the subtickets that failed. */
export function TemplateOutcome({
  outcome,
  form,
}: {
  outcome: AppliedTemplate;
  form: TicketForm | null;
}) {
  const t = useT();
  const fieldName = useFieldName(form);
  const made = outcome.subtickets.filter((s) => s.key !== null);
  const failed = outcome.subtickets.filter((s) => s.key === null);
  return (
    <>
      {made.length > 0 && (
        <p className="page-note">
          {t('tickets.templates.subticketsMade', {
            count: made.length,
            keys: made.map((s) => s.key).join(', '),
          })}
        </p>
      )}
      {outcome.left.length > 0 && (
        <p className="page-note">
          {t('tickets.templates.left', { fields: outcome.left.map(fieldName).join(', ') })}
        </p>
      )}
      {failed.length > 0 && (
        <div role="alert" className="form-error">
          <p>{t('tickets.templates.subticketsFailed')}</p>
          <ul>
            {failed.map((s) => (
              <li key={s.summary}>{s.summary}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
