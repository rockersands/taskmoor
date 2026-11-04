import { type FormEvent, useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useNotSetupAdmin } from '../admin/access';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { PageHeader } from '../shell/PageHeader';
import {
  type LayoutSet,
  type LayoutSetSummary,
  type LayoutsClient,
  layoutsClient,
  type Owned,
} from './client';
import { LayoutCanvas } from './LayoutCanvas';
import { LayoutPreview } from './LayoutPreview';
import {
  type Draft,
  type DraftSet,
  draftSetOf,
  entriesOf,
  type FormChoice,
  formKey,
  layoutSource,
  OPERATIONS,
  type Operation,
  SYSTEM_FIELD_KEYS,
  sameLayouts,
  starterFor,
} from './model';

/** Where the field rules are edited: the other half of how a form comes out. */
export const FIELD_RULES_HREF = '#/admin/configuration-sets';

export interface LayoutEditorPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: LayoutsClient;
  /** The set to open first; the default set otherwise. */
  initialSetId?: number | null;
  /** How long the preview waits for typing to settle, in milliseconds. */
  previewDelay?: number;
}

/**
 * Layouts (UI-T15; ADR-114 section 8; CORE-008, CORE-013), for site and configuration
 * administrators: a layout set's create, edit and view forms, per ticket type or for every type.
 * Fields are dragged into tabs and sections, or moved with each grip's menu and Alt with the
 * arrow keys; a live preview shows the form the server would give. Saving sends the set's
 * layouts as a whole, and the server judges them as it judges any save.
 */
export function LayoutEditorPage({
  client = layoutsClient,
  initialSetId = null,
  previewDelay,
}: LayoutEditorPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const titleId = useId();
  const id = useId();
  const notAdmin = useNotSetupAdmin();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; sets: LayoutSetSummary[]; fields: Owned[] }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [selected, setSelected] = useState<number | null>(initialSetId);
  const [dirty, setDirty] = useState(false);
  const [newName, setNewName] = useState('');
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(
    async (choose?: number | null) => {
      try {
        const [sets, fields] = await Promise.all([client.layoutSets(), client.customFields()]);
        setState({ status: 'loaded', sets, fields });
        setSelected((current) => {
          const wanted = choose === undefined ? current : choose;
          if (wanted !== null && sets.some((s) => s.id === wanted)) return wanted;
          return (sets.find((s) => s.isDefault) ?? sets[0])?.id ?? null;
        });
      } catch (error) {
        if (expired(error)) return;
        setState({
          status: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed',
        });
      }
    },
    [client, expired],
  );
  useEffect(() => {
    if (!notAdmin) void load();
  }, [load, notAdmin]);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setProblem(null);
    client.createLayoutSet({ name }).then(
      (made) => {
        setNewName('');
        setMessage(t('layouts.added', { name: made.name }));
        void load(made.id);
      },
      (error) => {
        if (!expired(error)) setProblem(refusal(t, error));
      },
    );
  };

  const set =
    state.status === 'loaded' ? (state.sets.find((s) => s.id === selected) ?? null) : null;
  return (
    <section aria-labelledby={titleId} className="admin-page layout-editor-page">
      <PageHeader
        titleId={titleId}
        title={t('layouts.title')}
        purpose={t('layouts.purpose')}
        about={t('layouts.about')}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('layouts.forbidden')}</p>
      ) : (
        <>
          <p className="page-note">
            {t('layouts.combine')}{' '}
            <a href={routeHref(FIELD_RULES_HREF)}>{t('layouts.fieldRulesLink')}</a>
          </p>
          <p role="status" className="form-status">
            {message}
          </p>
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
          {state.status === 'loading' && <p className="page-note">{t('layouts.loading')}</p>}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('layouts.failed')}
            </p>
          )}
          {state.status === 'loaded' && (
            <>
              <div className="layout-set-bar">
                <div className="form-field">
                  <label htmlFor={`${id}-set`} className="form-label">
                    {t('layouts.set')}
                  </label>
                  <select
                    id={`${id}-set`}
                    value={selected ?? ''}
                    disabled={dirty}
                    aria-describedby={dirty ? `${id}-set-hint` : undefined}
                    onChange={(event) => {
                      setMessage('');
                      setProblem(null);
                      setSelected(Number(event.target.value));
                    }}
                  >
                    {state.sets.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.trackId !== null
                          ? t('layouts.ownSet', { name: s.name })
                          : s.isDefault
                            ? t('layouts.defaultSet', { name: s.name })
                            : s.name}
                      </option>
                    ))}
                  </select>
                  {dirty && (
                    <p id={`${id}-set-hint`} className="form-hint">
                      {t('layouts.setLocked')}
                    </p>
                  )}
                </div>
                <form className="layout-set-add" aria-label={t('layouts.add')} onSubmit={add}>
                  <div className="form-field">
                    <label htmlFor={`${id}-new`} className="form-label">
                      {t('layouts.newSetName')}
                    </label>
                    <input
                      id={`${id}-new`}
                      type="text"
                      required
                      maxLength={255}
                      value={newName}
                      onChange={(event) => setNewName(event.target.value)}
                    />
                  </div>
                  <button type="submit" className="button-secondary">
                    {t('layouts.add')}
                  </button>
                </form>
              </div>
              {set && (
                <SetLoader
                  key={set.id}
                  summary={set}
                  client={client}
                  fields={state.fields}
                  onDirty={setDirty}
                  previewDelay={previewDelay}
                  onSaved={(saved) => {
                    setMessage(t('layouts.saved', { name: saved.name }));
                    setProblem(null);
                    void load(saved.id);
                  }}
                  onDeleted={(name) => {
                    setDirty(false);
                    setMessage(t('layouts.deleted', { name }));
                    setProblem(null);
                    void load(null);
                  }}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

/** What a refused change says, from the server's answer. */
function refusal(t: ReturnType<typeof useT>, error: unknown): string {
  if (!(error instanceof ApiError)) return t('layouts.problem.other');
  const body = error.body as { error?: string; trackCount?: number; detail?: string } | null;
  if (body?.error === 'in_use') return t('layouts.problem.inUse', { tracks: body.trackCount ?? 0 });
  if (body?.error === 'default') return t('layouts.problem.default');
  if (body?.error === 'name_taken') return t('layouts.problem.nameTaken');
  if (error.status === 400) {
    return body?.detail
      ? t('layouts.problem.invalidDetail', { detail: body.detail })
      : t('layouts.problem.invalid');
  }
  if (error.status === 403) return t('layouts.problem.forbidden');
  if (error.status === 409) return t('layouts.problem.conflict');
  return t('layouts.problem.other');
}

interface SetLoaderProps {
  summary: LayoutSetSummary;
  client: LayoutsClient;
  fields: Owned[];
  onDirty: (dirty: boolean) => void;
  onSaved: (set: LayoutSet) => void;
  onDeleted: (name: string) => void;
  previewDelay?: number | undefined;
}

/** Reads a set and the ticket types it may name, then edits it. */
function SetLoader({ summary, client, ...rest }: SetLoaderProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const [loaded, setLoaded] = useState<{ set: LayoutSet; types: Owned[] } | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([client.layoutSet(summary.id), client.ticketTypes(summary.trackId)]).then(
      ([set, types]) => {
        if (live) setLoaded({ set, types });
      },
      (error) => {
        if (live && !expired(error)) setLoaded('failed');
      },
    );
    return () => {
      live = false;
    };
  }, [client, summary.id, summary.trackId, expired]);
  if (loaded === 'failed') {
    return (
      <p role="alert" className="form-error">
        {t('layouts.setFailed')}
      </p>
    );
  }
  if (!loaded) return <p className="page-note">{t('layouts.loading')}</p>;
  return (
    <SetEditor
      set={loaded.set}
      types={loaded.types}
      client={client}
      {...rest}
      onSaved={(saved) => {
        // The editor goes on from what was saved: its name and the tracks that use it.
        setLoaded({ set: saved, types: loaded.types });
        rest.onSaved(saved);
      }}
    />
  );
}

const OPERATION_LABELS: Record<Operation, MessageId> = {
  create: 'layouts.operation.create',
  edit: 'layouts.operation.edit',
  view: 'layouts.operation.view',
};

/** One layout set: its name, the form chosen, its layout, the preview, and saving. */
function SetEditor({
  set,
  types,
  client,
  fields,
  onDirty,
  onSaved,
  onDeleted,
  previewDelay,
}: Omit<SetLoaderProps, 'summary'> & { set: LayoutSet; types: Owned[] }) {
  const t = useT();
  const expired = useSessionExpiry();
  const id = useId();
  const [baseline, setBaseline] = useState<DraftSet>(() => draftSetOf(set.layouts));
  const [drafts, setDrafts] = useState<DraftSet>(baseline);
  const [name, setName] = useState(set.name);
  const [form, setForm] = useState<FormChoice>({ ticketTypeId: null, operation: 'create' });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState('');

  const dirty = name.trim() !== set.name || !sameLayouts(drafts, baseline);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // The fields this set may place: the system ones, then the custom fields it may name.
  const customs = useMemo(
    () => fields.filter((f) => f.trackId === null || f.trackId === set.trackId),
    [fields, set.trackId],
  );
  const fieldKeys = useMemo(
    () => [...SYSTEM_FIELD_KEYS, ...customs.map((f) => `cf[${f.id}]`)],
    [customs],
  );
  const fieldName = useCallback(
    (key: string) => {
      const custom = /^cf\[(\d+)\]$/.exec(key)?.[1];
      if (custom) {
        return (
          customs.find((f) => f.id === Number(custom))?.name ?? t('layouts.unknownField', { key })
        );
      }
      return t(`workflow.field.${key}` as MessageId);
    },
    [customs, t],
  );
  const typeName = (typeId: number | null) =>
    typeId === null
      ? t('layouts.everyType')
      : (types.find((x) => x.id === typeId)?.name ?? String(typeId));

  const key = formKey(form);
  const draft = drafts[key] ?? null;
  const source = layoutSource(drafts, form);
  const formName = t('layouts.formName', {
    operation: form.operation,
    type: form.ticketTypeId === null ? t('layouts.everyTypeInText') : typeName(form.ticketTypeId),
  });
  // Types with a layout of their own for this operation, so the chooser can say which.
  const ownTypes = new Set(
    Object.keys(drafts)
      .filter((k) => k.endsWith(`|${form.operation}`))
      .map((k) => Number(k.split('|')[0])),
  );

  const change = (next: Draft) => setDrafts((all) => ({ ...all, [key]: next }));
  const makeLayout = () => {
    setDrafts((all) => ({ ...all, [key]: starterFor(all, form, t('layouts.firstTab')) }));
    setSaid(t('layouts.made', { form: formName }));
  };
  const dropLayout = () => {
    setDrafts((all) => {
      const { [key]: _gone, ...rest } = all;
      return rest;
    });
    setSaid(t('layouts.dropped', { form: formName }));
  };

  const blankTab = draft?.tabs.some((tab) => tab.name.trim() === '') ?? false;
  const anyBlank = Object.values(drafts).some((d) => d.tabs.some((tab) => !tab.name.trim()));
  const save = async () => {
    setProblem(null);
    if (!name.trim()) {
      setProblem(t('layouts.problem.noName'));
      return;
    }
    if (anyBlank) {
      setProblem(t('layouts.problem.blankTab'));
      return;
    }
    setBusy(true);
    try {
      const changed = sameLayouts(drafts, baseline) ? {} : { layouts: entriesOf(drafts) };
      const saved = await client.updateLayoutSet(set.id, {
        ...(name.trim() !== set.name ? { name: name.trim() } : {}),
        ...changed,
      });
      setBaseline(drafts);
      onDirty(false);
      onSaved(saved);
    } catch (error) {
      if (!expired(error)) setProblem(refusal(t, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="layout-set-editor"
      aria-label={t('layouts.editorOf', { name: set.name })}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p role="status" className="visually-hidden">
        {said}
      </p>
      <div className="layout-set-head glass-card">
        <div className="form-field">
          <label htmlFor={`${id}-name`} className="form-label">
            {t('layouts.setName')}
          </label>
          <input
            id={`${id}-name`}
            type="text"
            required
            maxLength={255}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <p className="form-hint">
          {set.usedBy.length > 0
            ? t('layouts.usedBy', { tracks: set.usedBy.map((tr) => tr.key).join(', ') })
            : t('layouts.usedByNone')}
          {set.isDefault ? ` ${t('layouts.defaultHint')}` : ''}
        </p>
        <fieldset className="layout-form-choice">
          <legend>{t('layouts.form')}</legend>
          <div className="form-field">
            <label htmlFor={`${id}-type`} className="form-label">
              {t('layouts.ticketType')}
            </label>
            <select
              id={`${id}-type`}
              value={form.ticketTypeId ?? ''}
              onChange={(event) =>
                setForm({
                  ...form,
                  ticketTypeId: event.target.value === '' ? null : Number(event.target.value),
                })
              }
            >
              <option value="">
                {drafts[formKey({ ...form, ticketTypeId: null })]
                  ? t('layouts.typeOptionOwn', { type: t('layouts.everyType') })
                  : t('layouts.everyType')}
              </option>
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {ownTypes.has(type.id)
                    ? t('layouts.typeOptionOwn', { type: type.name })
                    : type.name}
                </option>
              ))}
            </select>
          </div>
          <div className="layout-operations" role="radiogroup" aria-label={t('layouts.operation')}>
            {OPERATIONS.map((operation) => (
              <label key={operation} className="layout-operation">
                <input
                  type="radio"
                  name={`${id}-operation`}
                  value={operation}
                  checked={form.operation === operation}
                  onChange={() => setForm({ ...form, operation })}
                />
                <span>{t(OPERATION_LABELS[operation])}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="layout-form-state">
        <p className="page-note">
          {source === 'own'
            ? t('layouts.source.own', { form: formName })
            : source === 'every_type'
              ? t('layouts.source.everyType', { form: formName })
              : t('layouts.source.none', { form: formName })}
        </p>
        {draft ? (
          <button type="button" className="button-secondary" onClick={dropLayout}>
            {t(form.ticketTypeId === null ? 'layouts.dropEvery' : 'layouts.dropOwn')}
          </button>
        ) : (
          <button type="button" className="button-primary" onClick={makeLayout}>
            {t(source === 'every_type' ? 'layouts.makeFromEvery' : 'layouts.make')}
          </button>
        )}
      </div>
      <div className="layout-workspace">
        {draft && (
          <div className="layout-edit">
            <LayoutCanvas
              draft={draft}
              onChange={change}
              fieldKeys={fieldKeys}
              fieldName={fieldName}
            />
            <div className="form-field form-field-inline layout-others">
              <input
                id={`${id}-omit`}
                type="checkbox"
                checked={draft.others === 'omit'}
                aria-describedby={`${id}-omit-hint`}
                onChange={(event) =>
                  change({ ...draft, others: event.target.checked ? 'omit' : 'show' })
                }
              />
              <label htmlFor={`${id}-omit`}>{t('layouts.onlyPlaced')}</label>
            </div>
            <p id={`${id}-omit-hint`} className="form-hint">
              {t('layouts.onlyPlacedHint')}
            </p>
            {blankTab && (
              <p className="form-error" role="alert">
                {t('layouts.problem.blankTab')}
              </p>
            )}
          </div>
        )}
        <LayoutPreview
          client={client}
          setId={set.id}
          drafts={drafts}
          form={form}
          types={types}
          tracks={set.usedBy}
          ownerTrackId={set.trackId}
          fieldName={fieldName}
          {...(previewDelay !== undefined ? { delay: previewDelay } : {})}
        />
      </div>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      <div className="form-actions layout-save-bar">
        <button type="submit" className="button-primary" disabled={busy || !dirty}>
          {t('layouts.save')}
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={busy || !dirty}
          onClick={() => {
            setDrafts(baseline);
            setName(set.name);
            setProblem(null);
            setSaid(t('layouts.discarded'));
          }}
        >
          {t('layouts.discard')}
        </button>
        {dirty && <span className="token-badge">{t('layouts.unsaved')}</span>}
        {!set.isDefault &&
          (confirming ? (
            <>
              <span className="people-confirm">
                {t('layouts.confirmDelete', { name: set.name })}
              </span>
              <button
                type="button"
                className="button-danger"
                onClick={() => {
                  setConfirming(false);
                  setProblem(null);
                  client.deleteLayoutSet(set.id).then(
                    () => onDeleted(set.name),
                    (error) => {
                      if (!expired(error)) setProblem(refusal(t, error));
                    },
                  );
                }}
              >
                {t('layouts.confirmYes')}
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => setConfirming(false)}
              >
                {t('layouts.confirmNo')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button-secondary layout-delete"
              aria-label={t('layouts.deleteOf', { name: set.name })}
              onClick={() => setConfirming(true)}
            >
              {t('layouts.delete')}
            </button>
          ))}
      </div>
    </form>
  );
}
