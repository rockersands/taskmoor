import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { guardLeave, routeHref } from '../routing/router';
import { useSessionExpiry } from '../session/useSessionExpiry';
import {
  ownLayoutsHref,
  ownSetsHref,
  ScopeNote,
  type ScopeTrack,
  TrackScopeLine,
  useSetScope,
  useTrackPageTrail,
} from '../sets/trackScope';
import { PageHeader } from '../shell/PageHeader';
import { DraftDialog } from '../tickets/view/drafts';
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
import { layoutRefusal } from './refusal';

/** Where the field rules are edited: the other half of how a form comes out. */
export const FIELD_RULES_HREF = '#/admin/configuration-sets';
/** This page's route; `?set=` opens a set. A track's own page is `ownLayoutsHref`. */
export const LAYOUTS_ROUTE = '#/admin/layouts';
const onPage = (route: string, base: string) => route === base || route.startsWith(`${base}?`);

export interface LayoutEditorPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: LayoutsClient;
  /** The set to open first; the default set otherwise, or the set the track uses. */
  initialSetId?: number | null;
  /** How long the preview waits for typing to settle, in milliseconds. */
  previewDelay?: number;
  /** A local-mode track's own page: only the sets it owns (T-163a). */
  trackId?: number | null;
}

/**
 * Layouts (UI-T15; ADR-114 section 8; CORE-008, CORE-013): a layout set's create, edit and view
 * forms, per ticket type or for every type. Fields are dragged into tabs and sections, or moved
 * with each grip's menu and Alt with the arrow keys; a live preview shows the form the server
 * would give. Saving sends the set's layouts as a whole, and the server judges them as it judges
 * any save.
 *
 * Site and configuration administrators see every set. On a local-mode track's own page
 * (`trackId`; T-163a), whoever runs the track sees only the sets it owns, adds sets for it, makes
 * it use one, and previews with its fields and ticket types. Someone who runs tracks but is no
 * administrator is offered those pages instead of every set (`sets/trackScope.tsx`).
 */
export function LayoutEditorPage({
  client = layoutsClient,
  initialSetId = null,
  previewDelay,
  trackId = null,
}: LayoutEditorPageProps) {
  const t = useT();
  const titleId = useId();
  const scope = useSetScope(trackId, client);
  const track = scope.status === 'track' ? scope.track : null;
  useTrackPageTrail(scope, t('layouts.title'));
  const [refused, setRefused] = useState(false);
  return (
    <section aria-labelledby={titleId} className="page page-full admin-page layout-editor-page">
      <PageHeader
        titleId={titleId}
        title={t('layouts.title')}
        {...(track
          ? { eyebrow: t('ownSets.trackName', { key: track.key, name: track.name }) }
          : {})}
        {...(refused || scope.status === 'none'
          ? {}
          : { purpose: t('layouts.purpose'), about: t('layouts.about') })}
      />
      {scope.status === 'all' || track ? (
        <LayoutSets
          key={track?.id ?? 'all'}
          client={client}
          track={track}
          initialSetId={initialSetId}
          previewDelay={previewDelay}
          onRefused={setRefused}
        />
      ) : (
        <ScopeNote
          scope={scope}
          hrefOf={ownLayoutsHref}
          words={{
            chooseIntro: t('layouts.choose.intro'),
            chooseNone: t('layouts.choose.none'),
            chooseOpen: (run) => t('layouts.choose.open', { key: run.key, name: run.name }),
            shared: (shared) => t('layouts.scope.shared', { key: shared.key }),
            none: t('layouts.forbidden'),
            failed: t('layouts.failed'),
          }}
        />
      )}
    </section>
  );
}

interface LayoutSetsProps {
  client: LayoutsClient;
  /** A local-mode track's own sets; every set when null. */
  track: ScopeTrack | null;
  initialSetId: number | null;
  previewDelay: number | undefined;
  /** The server refused the list: the page drops its purpose too, and only says so. */
  onRefused: (refused: boolean) => void;
}

/** The sets the page shows, the one open, adding one, and the editor of the open one. */
function LayoutSets({ client, track, initialSetId, previewDelay, onRefused }: LayoutSetsProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const id = useId();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; sets: LayoutSetSummary[]; fields: Owned[] }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >({ status: 'loading' });
  const [selected, setSelected] = useState<number | null>(initialSetId);
  const [dirty, setDirty] = useState(false);
  const unsaved = useRef(dirty);
  unsaved.current = dirty;
  // The set the track uses opens first; it changes when the person makes the track use another.
  const inUse = useRef(track?.layoutSetId ?? null);
  const [newName, setNewName] = useState('');
  const creating = useNewForm();
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const owner = track?.id ?? null;
  const base = track ? ownLayoutsHref(track.id) : LAYOUTS_ROUTE;

  const load = useCallback(
    async (choose?: number | null) => {
      try {
        const [listed, fields] = await Promise.all([
          client.layoutSets(owner),
          client.customFields(owner),
        ]);
        // On a track's own page, only the sets it owns: the shared ones are not its to change.
        const sets = owner === null ? listed : listed.filter((s) => s.trackId === owner);
        setState({ status: 'loaded', sets, fields });
        setSelected((current) => {
          // A draft begun while the list was being read keeps its set open: switching would drop
          // it without asking.
          const wanted = choose === undefined || unsaved.current ? current : choose;
          if (wanted !== null && sets.some((s) => s.id === wanted)) return wanted;
          const first =
            sets.find((s) => s.id === inUse.current) ?? sets.find((s) => s.isDefault) ?? sets[0];
          return first?.id ?? null;
        });
      } catch (error) {
        if (expired(error)) return;
        setState({
          status: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed',
        });
      }
    },
    [client, owner, expired],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    onRefused(state.status === 'forbidden');
  }, [state.status, onRefused]);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    // A new set opens at once, so it waits, as the set list does, for a draft to be saved or
    // discarded: opening it would drop the draft without asking.
    if (!name || unsaved.current) return;
    setProblem(null);
    client.createLayoutSet({ name, ...(owner === null ? {} : { trackId: owner }) }).then(
      (made) => {
        setNewName('');
        creating.close();
        setMessage(t('layouts.added', { name: made.name }));
        // A draft begun while the set was being made stays open; the new set is in the list.
        void load(unsaved.current ? undefined : made.id);
      },
      (error) => {
        if (!expired(error)) setProblem(refusal(t, error));
      },
    );
  };

  if (state.status === 'forbidden') return <p className="page-note">{t('layouts.forbidden')}</p>;
  const set =
    state.status === 'loaded' ? (state.sets.find((s) => s.id === selected) ?? null) : null;
  return (
    <>
      {track && <TrackScopeLine track={track} intro={t('layouts.trackIntro')} />}
      <p className="page-note">
        {t('layouts.combine')}{' '}
        {track ? (
          <a href={routeHref(ownSetsHref(track.id))}>
            {t('layouts.fieldRulesLinkTrack', { key: track.key })}
          </a>
        ) : (
          <a href={routeHref(FIELD_RULES_HREF)}>{t('layouts.fieldRulesLink')}</a>
        )}
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
          {track && state.sets.length === 0 && (
            <p className="page-note">{t('layouts.trackNoSets', { key: track.key })}</p>
          )}
          <div className="layout-set-bar">
            {state.sets.length > 0 && (
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
                      {track
                        ? s.name
                        : s.trackId !== null
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
            )}
            <NewButton
              label={t('layouts.new')}
              open={creating.open}
              onToggle={creating.toggle}
              ref={creating.button}
            />
          </div>
          {creating.open && (
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
                  disabled={dirty}
                  aria-describedby={dirty ? `${id}-set-hint` : undefined}
                  onChange={(event) => setNewName(event.target.value)}
                />
              </div>
              <div className="form-actions">
                <button
                  type="submit"
                  className="button-primary"
                  disabled={dirty}
                  aria-describedby={dirty ? `${id}-set-hint` : undefined}
                >
                  {t('layouts.add')}
                </button>
                <button type="button" className="button-secondary" onClick={creating.close}>
                  {t('layouts.cancelNew')}
                </button>
              </div>
            </form>
          )}
          {set && (
            <SetLoader
              key={set.id}
              summary={set}
              client={client}
              track={track}
              base={base}
              fields={state.fields}
              onDirty={setDirty}
              previewDelay={previewDelay}
              onSaved={(saved) => {
                setMessage(t('layouts.saved', { name: saved.name }));
                setProblem(null);
                void load(saved.id);
              }}
              onAssigned={(used) => {
                inUse.current = used.id;
                setMessage(t('layouts.usedFor', { key: track?.key ?? '', name: used.name }));
                setProblem(null);
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
  );
}

/**
 * What a refused change says, from the server's answer: a refused save in the catalogue's words
 * (`layoutRefusal`), with `nameOf` naming the custom fields it is about.
 */
function refusal(
  t: ReturnType<typeof useT>,
  error: unknown,
  nameOf: (key: string) => string | undefined = () => undefined,
): string {
  if (!(error instanceof ApiError)) return t('layouts.problem.other');
  const body = error.body as { error?: string; trackCount?: number } | null;
  if (body?.error === 'in_use') return t('layouts.problem.inUse', { tracks: body.trackCount ?? 0 });
  if (body?.error === 'default') return t('layouts.problem.default');
  if (body?.error === 'name_taken') return t('layouts.problem.nameTaken');
  if (error.status === 400) {
    const reason = layoutRefusal(t, body, nameOf);
    return reason ? t('layouts.problem.invalidBecause', { reason }) : t('layouts.problem.invalid');
  }
  if (error.status === 403) return t('layouts.problem.forbidden');
  if (error.status === 409) return t('layouts.problem.conflict');
  return t('layouts.problem.other');
}

interface SetLoaderProps {
  summary: LayoutSetSummary;
  client: LayoutsClient;
  /** A local-mode track's own page: the track the set belongs to. */
  track: ScopeTrack | null;
  /** The page's route, which the leave guard lets the person move within. */
  base: string;
  fields: Owned[];
  onDirty: (dirty: boolean) => void;
  onSaved: (set: LayoutSet) => void;
  /** The track now uses the set. */
  onAssigned: (set: LayoutSet) => void;
  onDeleted: (name: string) => void;
  previewDelay?: number | undefined;
}

/**
 * Reads a set and the ticket types it may name, then edits it. On a track's own page the types
 * are those the track offers, its type set's, when it has one.
 */
function SetLoader({ summary, client, track, ...rest }: SetLoaderProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const [loaded, setLoaded] = useState<{ set: LayoutSet; types: Owned[] } | 'failed' | null>(null);
  const typeSetId = track?.typeSetId ?? null;
  useEffect(() => {
    let live = true;
    Promise.all([
      client.layoutSet(summary.id),
      typeSetId === null ? client.ticketTypes(summary.trackId) : client.typeSetTypes(typeSetId),
    ]).then(
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
  }, [client, summary.id, summary.trackId, typeSetId, expired]);
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
      track={track}
      {...rest}
      onSaved={(saved) => {
        // The editor goes on from what was saved: its name and the tracks that use it.
        setLoaded({ set: saved, types: loaded.types });
        rest.onSaved(saved);
      }}
      onAssigned={(used) => {
        // The tracks that use it now name this track; the draft stays as it is.
        setLoaded({ set: used, types: loaded.types });
        rest.onAssigned(used);
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
  track,
  base,
  fields,
  onDirty,
  onSaved,
  onAssigned,
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
  // "Use this set for KEY" goes away once the track uses the set; the note that says which tracks
  // use it takes the keyboard focus it had, rather than the page (T-225).
  const usedByNote = useRef<HTMLParagraphElement>(null);
  const [focusUsedBy, setFocusUsedBy] = useState(false);
  useEffect(() => {
    if (!focusUsedBy) return;
    usedByNote.current?.focus();
    setFocusUsedBy(false);
  }, [focusUsedBy]);

  const dirty = name.trim() !== set.name || !sameLayouts(drafts, baseline);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  // Leaving the page with unsaved changes asks first: a link or command inside the app, and Back
  // or Forward, with the app's own question (the router holds the page meanwhile); a reload or
  // closing the tab, with the browser's.
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const unsaved = useRef(dirty);
  unsaved.current = dirty;
  useEffect(
    () =>
      guardLeave({
        holds: (route) => unsaved.current && !onPage(route, base),
        ask: (proceed) => setLeaving(() => proceed),
      }),
    [base],
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when a value is set.
      event.returnValue = '';
    };
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
  // A custom field's name when the page knows it, whichever track owns it, so a field this set
  // may not place is named as the server's refusal names it.
  const knownName = useCallback(
    (key: string) => {
      const custom = /^cf\[(\d+)\]$/.exec(key)?.[1];
      return custom ? fields.find((f) => f.id === Number(custom))?.name : undefined;
    },
    [fields],
  );
  const fieldName = useCallback(
    (key: string) => {
      if (/^cf\[\d+\]$/.test(key)) return knownName(key) ?? t('layouts.unknownField', { key });
      return t(`workflow.field.${key}` as MessageId);
    },
    [knownName, t],
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
      if (!expired(error)) setProblem(refusal(t, error, knownName));
    } finally {
      setBusy(false);
    }
  };

  // A track's own page offers to make the track use this set; the server says whether it may.
  const assignable = track !== null && !set.usedBy.some((used) => used.id === track.id);
  const assign = () => {
    if (!track) return;
    setProblem(null);
    client
      .assignLayoutSet(track.id, set.id)
      .then(() => client.layoutSet(set.id))
      .then(
        (used) => {
          onAssigned(used);
          setFocusUsedBy(true);
        },
        (error) => {
          if (!expired(error)) setProblem(refusal(t, error));
        },
      );
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
        <p ref={usedByNote} tabIndex={-1} className="form-hint">
          {set.usedBy.length > 0
            ? t('layouts.usedBy', { tracks: set.usedBy.map((tr) => tr.key).join(', ') })
            : t('layouts.usedByNone')}
          {set.isDefault ? ` ${t('layouts.defaultHint')}` : ''}
        </p>
        {track && assignable && (
          <div className="layout-assign">
            <button
              type="button"
              className="button-secondary"
              aria-describedby={`${id}-assign-hint`}
              onClick={assign}
            >
              {t('layouts.useFor', { key: track.key })}
            </button>
            <p id={`${id}-assign-hint`} className="form-hint">
              {t('ownSets.useHint')}
            </p>
          </div>
        )}
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
          fixedTrack={track}
          fieldName={fieldName}
          knownName={knownName}
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
      {leaving &&
        createPortal(
          <DraftDialog
            words={{
              title: t('layouts.leave.title'),
              text: t('layouts.leave.text', { name: set.name }),
              keep: t('layouts.leave.keep'),
              discard: t('layouts.leave.discard'),
            }}
            onKeep={() => setLeaving(null)}
            onDiscard={() => {
              setLeaving(null);
              leaving();
            }}
          />,
          document.body,
        )}
    </form>
  );
}
