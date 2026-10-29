import type { PmJson } from '@taskmoor/richtext';
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { lockOfField, useLockText } from '../locks/useLockText';
import { type MentionSource, mentionSource } from '../richtext/mentions';
import { RichTextEditor } from '../richtext/RichTextEditor';
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
  /** People to mention in rich text fields (M1-017); none when left out. */
  mentions?: (track: string) => MentionSource;
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
  mentions: (track) => mentionSource({ track }),
};

/** Fields written in the rich text editor (M1-017). */
const RICH_TYPES = new Set(['description', 'environment', 'paragraph']);

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
  const lockText = useLockText();
  const titleId = useId();
  const prefix = useId();
  const [tracks, setTracks] = useState<Loaded<TrackChoice[]>>({ status: 'loading' });
  const [track, setTrack] = useState('');
  const [types, setTypes] = useState<TypeChoice[]>([]);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [form, setForm] = useState<Loaded<TicketForm> | null>(null);
  const [priorities, setPriorities] = useState<{ id: number; name: string }[]>([]);
  const [values, setValues] = useState<FormValues>({});
  // Rich text fields' documents, by field key; a new form key gives empty editors.
  const [docs, setDocs] = useState<Record<string, PmJson | null>>({});
  const [formKey, setFormKey] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  /** The ticket just created, to open it (M1-051). */
  const [created, setCreated] = useState<string | null>(null);
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
        // A type chosen while the track's list was on its way stays when the track offers it.
        setTypeId((chosen) =>
          chosen !== null && res.types.some((type) => type.id === chosen)
            ? chosen
            : (res.defaultTypeId ?? res.types[0]?.id ?? null),
        );
      })
      .catch(() => live && setForm({ status: 'failed' }));
    return () => {
      live = false;
    };
  }, [client, track]);

  // The form of the track and type chosen now: an answer for an earlier choice that comes late
  // is dropped, or it would show another type's fields under this one's name.
  const latestForm = useRef(0);
  const loadForm = useCallback(async () => {
    if (track === '' || typeId === null) return;
    const asked = ++latestForm.current;
    setForm({ status: 'loading' });
    setErrors({});
    try {
      const value = await client.form(track, typeId);
      if (asked === latestForm.current) setForm({ status: 'loaded', value });
    } catch {
      if (asked === latestForm.current) setForm({ status: 'failed' });
    }
  }, [client, track, typeId]);

  useEffect(() => {
    void loadForm();
  }, [loadForm]);

  const set = (key: string, value: string | string[]) => setValues((v) => ({ ...v, [key]: value }));
  const mentions = useMemo(
    () => (track === '' ? undefined : client.mentions?.(track)),
    [client, track],
  );
  const clearForm = () => {
    setValues({});
    setDocs({});
    setFormKey((k) => k + 1);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (form?.status !== 'loaded' || typeId === null) return;
    setBusy(true);
    setProblem(null);
    setMessage('');
    setCreated(null);
    setErrors({});
    try {
      const made = await client.create(createBody(track, typeId, form.value, values, docs));
      clearForm();
      setMessage(t('tickets.create.created', { key: made.key }));
      setCreated(made.key);
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
    locked: boolean,
  ) {
    const value = values[field.key];
    const text = typeof value === 'string' ? value : '';
    const common = {
      id,
      'aria-describedby': described || undefined,
      'aria-required': field.required || undefined,
      'aria-invalid': errors[field.key] ? true : undefined,
      // A field the person may not set (M1-029) shows, read-only, with the reason beside it.
      disabled: locked || undefined,
    };
    const type = custom?.type ?? field.key;
    if (RICH_TYPES.has(type)) {
      return (
        <RichTextEditor
          key={`${formKey}:${field.key}`}
          labelledBy={`${id}-label`}
          describedBy={described || undefined}
          required={field.required}
          invalid={Boolean(errors[field.key])}
          editable={!locked}
          onChange={(doc) => setDocs((d) => ({ ...d, [field.key]: doc }))}
          mentions={mentions}
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
              disabled={locked}
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
    const hint =
      field.key === 'labels' || custom?.type === 'labels' ? t('tickets.create.labelsHint') : null;
    const lock = lockOfField(loaded.locks, field.key);
    const helpId = help || hint ? `${id}-help` : '';
    const lockId = lock ? `${id}-lock` : '';
    const errorId = error ? `${id}-error` : '';
    const described = [helpId, lockId, errorId].filter(Boolean).join(' ');
    const editable = custom
      ? EDITABLE_CUSTOM.has(custom.type) && !(custom.type === 'select' && custom.multiple)
      : EDITABLE_SYSTEM.has(field.key);
    const multiple = custom?.type === 'select' && custom.multiple;
    return (
      <div key={field.key} className="form-field create-field">
        {multiple ? (
          <fieldset
            className="create-choices"
            aria-describedby={described || undefined}
            disabled={lock !== null}
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
            {RICH_TYPES.has(custom?.type ?? field.key) && editable ? (
              // A rich text editor is no form control: it names itself by this text's id.
              <span id={`${id}-label`} className="form-label rt-label">
                {label}
              </span>
            ) : (
              <label htmlFor={id} className="form-label">
                {label}
              </label>
            )}
            {editable ? (
              control(field, custom, id, described, lock !== null)
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
        {lock && (
          <p id={lockId} className="form-hint">
            {lockText(lock)}
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
                  clearForm();
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
          {created && (
            <p className="page-note">
              <a href={`#/tickets/${encodeURIComponent(created)}`}>
                {t('tickets.create.open', { key: created })}
              </a>
            </p>
          )}
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
