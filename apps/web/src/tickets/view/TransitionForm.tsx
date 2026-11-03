import { useEffect, useId, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { priorityName } from '../../shell/priorityName';
import type { Priority, TicketClient, Transition } from './client';

/** The fields a form like this can fill in; a transition asking for others goes to the ticket. */
export const FILLABLE_FIELDS: readonly string[] = ['close-reason', 'priority'];

/** The fields a transition asks for that the page can fill in: a close reason, a priority. */
export function TransitionForm({
  transition,
  client,
  onRun,
  onCancel,
}: {
  transition: Pick<Transition, 'name' | 'layout'>;
  client: Pick<TicketClient, 'closeReasons' | 'priorities'>;
  onRun: (fields: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const [options, setOptions] = useState<Record<string, Priority[]>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void Promise.all(
      transition.layout.map(async (field) => {
        const list =
          field === 'close-reason' ? await client.closeReasons() : await client.priorities();
        return [field, list] as const;
      }),
    ).then(
      (pairs) => {
        if (!live) return;
        setOptions(Object.fromEntries(pairs));
        setValues(Object.fromEntries(pairs.map(([f, list]) => [f, String(list[0]?.id ?? '')])));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [transition, client]);
  const labels: Record<string, Parameters<typeof t>[0]> = {
    'close-reason': 'workflow.field.closeReason',
    priority: 'workflow.field.priority',
  };
  return (
    <form
      className="ticket-transition-form"
      aria-label={t('ticketView.transitionForm', { name: transition.name })}
      onSubmit={(event) => {
        event.preventDefault();
        onRun(
          Object.fromEntries(
            Object.entries(values).map(([field, value]) => [field, value ? Number(value) : null]),
          ),
        );
      }}
    >
      {transition.layout.map((field) => (
        <div key={field} className="form-field">
          <label htmlFor={`${id}-${field}`} className="form-label">
            {t(labels[field] ?? 'workflow.field.closeReason')}
          </label>
          <select
            id={`${id}-${field}`}
            value={values[field] ?? ''}
            onChange={(event) => setValues((v) => ({ ...v, [field]: event.target.value }))}
          >
            {(options[field] ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {field === 'priority' ? priorityName(t, o.name) : o.name}
              </option>
            ))}
          </select>
        </div>
      ))}
      <div className="form-actions">
        {/* Ready once every list is in, so the values sent are the ones shown. */}
        <button
          type="submit"
          className="button-primary"
          disabled={!transition.layout.every((field) => field in options)}
        >
          {transition.name}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('ticketView.cancel')}
        </button>
      </div>
    </form>
  );
}
