import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import {
  type CustomField,
  createBody,
  customId,
  EDITABLE_CUSTOM,
  EDITABLE_SYSTEM,
  errorMessage,
  type FormField,
  type FormValues,
  fieldErrors,
  SYSTEM_FIELDS,
  type TicketForm,
} from './form';

export interface TrackChoice {
  id: number;
  key: string;
  name: string;
}
export interface TypeChoice {
  id: number;
  name: string;
}

/** The endpoints the page uses. Stories and some tests pass their own. */
export interface CreateClient {
  tracks: () => Promise<TrackChoice[]>;
  ticketTypes: (track: string) => Promise<{ defaultTypeId: number | null; types: TypeChoice[] }>;
  form: (track: string, ticketTypeId: number) => Promise<TicketForm>;
  priorities: () => Promise<{ id: number; name: string }[]>;
  create: (body: Record<string, unknown>) => Promise<{ key: string }>;
}

export const createClient: CreateClient = {
  tracks: async () => (await api<{ tracks: TrackChoice[] }>('/tracks')).tracks,
  ticketTypes: async (track) => {
    const res = await api<{ defaultTypeId: number | null; ticketTypes: TypeChoice[] }>(
      `/tracks/${encodeURIComponent(track)}/ticket-types`,
    );
    return { defaultTypeId: res.defaultTypeId, types: res.ticketTypes };
  },
  form: (track, ticketTypeId) =>
    api<TicketForm>(
      `/tracks/${encodeURIComponent(track)}/layout?ticketTypeId=${ticketTypeId}&operation=create`,
    ),
  priorities: async () =>
    (await api<{ priorities: { id: number; name: string }[] }>('/priorities')).priorities,
  create: async (body) =>
    (await api<{ ticket: { key: string } }>('/tickets', { method: 'POST', body })).ticket,
};

type Loaded<T> = { status: 'loading' } | { status: 'failed' } | { status: 'loaded'; value: T };

export interface CreateTicketPageProps {
  client?: CreateClient;
}

/**
 * Creating a ticket (#/create; M1-012, CORE-008, CORE-013): the create form of the chosen
 * track and ticket type as the backend lays it out, required fields marked, hidden ones absent,
 * and the backend's refusals shown at each field. Fields this form cannot edit yet (people,
 * releases, areas) say so; they are set on the ticket once it exists.
 */
export function CreateTicketPage({ client = createClient }: CreateTicketPageProps) {
  const t = useT();
  const titleId = useId();
  const prefix = useId();
  const [tracks, setTracks] = useState<Loaded<TrackChoice[]>>({ status: 'loading' });
  const [track, setTrack] = useState('');
  const [types, setTypes] = useState<TypeChoice[]>([]);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [form, setForm] = useState<Loaded<TicketForm> | null>(null);
  const [priorities, setPriorities] = useState<{ id: number; name: string }[]>([]);
  const [values, setValues] = useState<FormValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([client.tracks(), client.priorities().catch(() => [])])
      .then(([list, prios]) => {
        if (!live) return;
        setTracks({ status: 'loaded', value: list });
        setPriorities(prios);
        if (list.length > 0) setTrack(list[0]?.key ?? '');
      })
      .catch(() => live && setTracks({ status: 'failed' }));
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(() => {
    if (track === '') return;
    let live = true;
    client
      .ticketTypes(track)
      .then((res) => {
        if (!live) return;
        setTypes(res.types);
        setTypeId(res.defaultTypeId ?? res.types[0]?.id ?? null);
      })
      .catch(() => live && setForm({ status: 'failed' }));
    return () => {
      live = false;
    };
  }, [client, track]);

  const loadForm = useCallback(async () => {
    if (track === '' || typeId === null) return;
    setForm({ status: 'loading' });
    setErrors({});
    try {
      setForm({ status: 'loaded', value: await client.form(track, typeId) });
    } catch {
      setForm({ status: 'failed' });
    }
  }, [client, track, typeId]);

  useEffect(() => {
    void loadForm();
  }, [loadForm]);

  const set = (key: string, value: string | string[]) => setValues((v) => ({ ...v, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (form?.status !== 'loaded' || typeId === null) return;
    setBusy(true);
    setProblem(null);
    setMessage('');
    setErrors({});
    try {
      const made = await client.create(createBody(track, typeId, form.value, values));
      setValues({});
      setMessage(t('tickets.create.created', { key: made.key }));
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { fields?: Record<string, string> }) : null;
      if (body?.fields) {
        setErrors(fieldErrors(body.fields));
        setProblem(t('tickets.create.fixErrors'));
      } else {
        setProblem(t('tickets.create.createFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const labelOf = (field: FormField, custom: CustomField | undefined) => {
    const system = SYSTEM_FIELDS[field.key];
    const name = custom ? custom.name : system ? t(system.label) : field.key;
    return field.required ? t('tickets.create.requiredLabel', { label: name }) : name;
  };

  function control(
    field: FormField,
    custom: CustomField | undefined,
    id: string,
    described: string,
  ) {
    const value = values[field.key];
    const text = typeof value === 'string' ? value : '';
    const common = {
      id,
      'aria-describedby': described || undefined,
      'aria-required': field.required || undefined,
      'aria-invalid': errors[field.key] ? true : undefined,
    };
    const type = custom?.type ?? field.key;
    if (type === 'description' || type === 'environment' || type === 'paragraph') {
      return (
        <textarea
          {...common}
          rows={4}
          value={text}
          onChange={(e) => set(field.key, e.target.value)}
        />
      );
    }
    if (type === 'startDate' || type === 'dueDate' || type === 'date') {
      return (
        <input
          {...common}
          type="date"
          value={text}
          onChange={(e) => set(field.key, e.target.value)}
        />
      );
    }
    if (type === 'datetime') {
      return (
        <input
          {...common}
          type="datetime-local"
          value={text}
          onChange={(e) => set(field.key, e.target.value)}
        />
      );
    }
    if (type === 'number') {
      return (
        <input
          {...common}
          type="text"
          inputMode="decimal"
          value={text}
          onChange={(e) => set(field.key, e.target.value)}
        />
      );
    }
    if (type === 'priority' || (type === 'select' && !custom?.multiple)) {
      const options =
        type === 'priority'
          ? priorities.map((p) => ({ id: p.id, value: p.name }))
          : (custom?.options ?? []);
      return (
        <select {...common} value={text} onChange={(e) => set(field.key, e.target.value)}>
          <option value="">{t('tickets.create.none')}</option>
          {options.map((o) => (
            <option key={o.id} value={String(o.id)}>
              {o.value}
            </option>
          ))}
        </select>
      );
    }
    if (type === 'cascading-select') {
      const parent = (custom?.options ?? []).find((o) => String(o.id) === text);
      const childValue = values[`${field.key}/child`];
      return (
        <div className="create-cascade">
          <select
            {...common}
            value={text}
            onChange={(e) => {
              set(field.key, e.target.value);
              set(`${field.key}/child`, '');
            }}
          >
            <option value="">{t('tickets.create.none')}</option>
            {(custom?.options ?? []).map((o) => (
              <option key={o.id} value={String(o.id)}>
                {o.value}
              </option>
            ))}
          </select>
          {parent && (parent.children?.length ?? 0) > 0 && (
            <select
              aria-label={t('tickets.create.childOption', { label: custom?.name ?? '' })}
              value={typeof childValue === 'string' ? childValue : ''}
              onChange={(e) => set(`${field.key}/child`, e.target.value)}
            >
              <option value="">{t('tickets.create.none')}</option>
              {(parent.children ?? []).map((o) => (
                <option key={o.id} value={String(o.id)}>
                  {o.value}
                </option>
              ))}
            </select>
          )}
        </div>
      );
    }
    return (
      <input
        {...common}
        type={type === 'url' ? 'url' : 'text'}
        value={text}
        onChange={(e) => set(field.key, e.target.value)}
      />
    );
  }

  function fieldRow(field: FormField, loaded: TicketForm) {
    const id = `${prefix}-${field.key}`;
    const fieldId = customId(field.key);
    const custom = fieldId === null ? undefined : loaded.customFields.find((f) => f.id === fieldId);
    const label = labelOf(field, custom);
    const help = field.description ?? (custom?.description || null);
    const error = errors[field.key];
    const helpId = help ? `${id}-help` : '';
    const errorId = error ? `${id}-error` : '';
    const editable = custom
      ? EDITABLE_CUSTOM.has(custom.type) && !(custom.type === 'select' && custom.multiple)
      : EDITABLE_SYSTEM.has(field.key);
    const multiple = custom?.type === 'select' && custom.multiple;
    const hint =
      field.key === 'labels' || custom?.type === 'labels' ? t('tickets.create.labelsHint') : null;
    return (
      <div key={field.key} className="form-field create-field">
        {multiple ? (
          <fieldset
            className="create-choices"
            aria-describedby={[helpId, errorId].filter(Boolean).join(' ') || undefined}
          >
            <legend className="form-label">{label}</legend>
            {(custom?.options ?? []).map((o) => {
              const chosen = values[field.key];
              const list = Array.isArray(chosen) ? chosen : [];
              return (
                <label key={o.id} className="create-choice">
                  <input
                    type="checkbox"
                    checked={list.includes(String(o.id))}
                    onChange={(e) =>
                      set(
                        field.key,
                        e.target.checked
                          ? [...list, String(o.id)]
                          : list.filter((x) => x !== String(o.id)),
                      )
                    }
                  />
                  {o.value}
                </label>
              );
            })}
          </fieldset>
        ) : (
          <>
            <label htmlFor={id} className="form-label">
              {label}
            </label>
            {editable ? (
              control(field, custom, id, [helpId, errorId].filter(Boolean).join(' '))
            ) : (
              <p id={id} className="page-note">
                {t('tickets.create.later')}
              </p>
            )}
          </>
        )}
        {(help || hint) && (
          <p id={helpId || undefined} className="form-hint">
            {help ?? hint}
          </p>
        )}
        {error && (
          <p id={errorId} className="form-error">
            {t(errorMessage(error))}
          </p>
        )}
      </div>
    );
  }

  return (
    <section aria-labelledby={titleId} className="create-page">
      <h1 id={titleId} className="page-title">
        {t('tickets.create.title')}
      </h1>
      {tracks.status === 'loading' && (
        <p role="status" className="page-note">
          {t('tickets.create.loading')}
        </p>
      )}
      {tracks.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('tickets.create.failed')}
        </p>
      )}
      {tracks.status === 'loaded' && tracks.value.length === 0 && (
        <p className="page-note">{t('tickets.create.noTracks')}</p>
      )}
      {tracks.status === 'loaded' && tracks.value.length > 0 && (
        <form className="create-form" onSubmit={(e) => void submit(e)} noValidate>
          <div className="create-choosers">
            <div className="form-field">
              <label htmlFor={`${prefix}-track`} className="form-label">
                {t('tickets.create.track')}
              </label>
              <select
                id={`${prefix}-track`}
                value={track}
                onChange={(e) => {
                  setTrack(e.target.value);
                  setValues({});
                  // The old track's types until the new ones arrive would let a choice made
                  // meanwhile be overwritten, or sent with a type of the wrong track.
                  setTypes([]);
                  setTypeId(null);
                }}
              >
                {tracks.value.map((k) => (
                  <option key={k.id} value={k.key}>
                    {t('tickets.create.trackName', { key: k.key, name: k.name })}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={`${prefix}-type`} className="form-label">
                {t('tickets.create.type')}
              </label>
              <select
                id={`${prefix}-type`}
                value={typeId ?? ''}
                onChange={(e) => setTypeId(Number(e.target.value))}
              >
                {types.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {form?.status === 'loading' && (
            <p role="status" className="page-note">
              {t('tickets.create.loading')}
            </p>
          )}
          {form?.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('tickets.create.failed')}
            </p>
          )}
          {form?.status === 'loaded' &&
            form.value.layout.tabs.map((tab, i) => {
              const headingId = `${prefix}-tab-${i}`;
              const only = form.value.layout.tabs.length === 1;
              const name = tab.name ?? (only ? null : t('tickets.create.moreFields'));
              return (
                <section
                  // biome-ignore lint/suspicious/noArrayIndexKey: tabs have no id; their order is fixed
                  key={i}
                  className="create-tab"
                  {...(name ? { 'aria-labelledby': headingId } : {})}
                >
                  {name && (
                    <h2 id={headingId} className="facts-title">
                      {name}
                    </h2>
                  )}
                  <div className="create-sections">
                    {tab.sections.map((section, j) => (
                      <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: sections have no id
                        key={j}
                        className={section.kind === 'context' ? 'create-context' : 'create-main'}
                      >
                        {section.fields.map((field) => fieldRow(field, form.value))}
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
          <p role="status" className="form-status">
            {message}
          </p>
          <div className="form-actions">
            <button
              type="submit"
              className="button-primary"
              disabled={busy || form?.status !== 'loaded'}
            >
              {busy ? t('tickets.create.creating') : t('tickets.create.submit')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
