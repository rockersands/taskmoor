import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import {
  ScopeNote,
  type ScopeTrack,
  TrackScopeLine,
  useSetScope,
  useTrackPageTrail,
} from '../sets/trackScope';
import { DangerAction } from '../shell/DangerAction';
import { PageHeader } from '../shell/PageHeader';
import {
  type ConfigurationClient,
  configurationClient,
  type MapChange,
  type MappingImpact,
  type MappingNeeded,
  type MapWorkflow,
  type Named,
  type StatusMigration,
  type TypeStatusMapping,
  type WorkflowMap,
  type WorkflowMapSummary,
} from './client';
import {
  MigrationProgress,
  movedText,
  needsMapping,
  StatusMappingPanel,
} from './StatusMappingPanel';

/** A local-mode track's own workflow map, beside its Manage page (T-322; T-163a's pattern). */
export const ownMapHref = (trackId: number) => `#/manage/tracks/${trackId}/workflow-map`;

export interface WorkflowMapsPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: ConfigurationClient;
  /** A local-mode track's own page: the one map it owns (T-322). */
  trackId?: number | null;
}

type Translate = ReturnType<typeof useT>;

/** What the page says when the server refuses a change of a map. */
function mapRefusal(t: Translate, error: unknown): string {
  if (!(error instanceof ApiError)) return t('admin.maps.problem.other');
  const body = error.body as { error?: string; statuses?: MappingNeeded[] } | null;
  if (body?.error === 'status_mapping_required') {
    const tickets = (body.statuses ?? []).reduce((n, m) => n + m.ticketCount, 0);
    return t('admin.maps.problem.mapping', { tickets });
  }
  if (body?.error === 'status_migration_running') return t('admin.maps.problem.migrating');
  if (body?.error === 'name_taken') return t('admin.maps.problem.nameTaken');
  if (body?.error === 'workflow_map_in_use') return t('admin.maps.problem.inUse');
  if (body?.error === 'track_archived') return t('admin.maps.problem.archived');
  if (error.status === 403 || error.status === 404) return t('admin.maps.problem.forbidden');
  return t('admin.maps.problem.other');
}

/**
 * Workflow maps (M1-028, WF-001 (3)), for administrators: which workflow each ticket type uses,
 * and the one every other type uses. Shared maps serve any number of shared-mode tracks; the
 * default map serves tracks without one. A change that would leave tickets in statuses their
 * new workflow lacks asks first where they go (T-320).
 *
 * A local-mode track owns one map, made with it; on the track's own page (`trackId`; T-322)
 * whoever runs the track changes it, naming the shared workflows and the track's own, for the
 * types the track offers. Someone who runs tracks but is no administrator is offered those pages
 * instead (`sets/trackScope.tsx`).
 */
export function WorkflowMapsPage({
  client = configurationClient,
  trackId = null,
}: WorkflowMapsPageProps) {
  const t = useT();
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const scope = useSetScope(trackId, client);
  const track = scope.status === 'track' ? scope.track : null;
  const pageTitle = t(trackId === null ? 'admin.maps.title' : 'admin.maps.trackTitle');
  useTrackPageTrail(scope, pageTitle);
  /** The purpose shows only to someone who may be here; only the maps themselves can tell. */
  const header = (allowed: boolean, actions?: ReactNode) => (
    <PageHeader
      titleId={titleId}
      titleRef={title}
      title={pageTitle}
      {...(track ? { eyebrow: t('ownSets.trackName', { key: track.key, name: track.name }) } : {})}
      {...(allowed
        ? {
            purpose: t('settings.workflowMapsHint'),
            about: t(track ? 'admin.maps.trackAbout' : 'admin.maps.intro'),
            ...(actions ? { actions } : {}),
          }
        : {})}
    />
  );
  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      {scope.status === 'all' ? (
        <SharedMaps client={client} header={header} title={title} />
      ) : track ? (
        <OwnMap key={track.id} client={client} track={track} header={header} />
      ) : (
        <>
          {header(false)}
          <ScopeNote
            scope={scope}
            hrefOf={ownMapHref}
            words={{
              chooseIntro: t('admin.maps.choose.intro'),
              chooseNone: t('admin.maps.choose.none'),
              chooseOpen: (run) => t('admin.maps.choose.open', { key: run.key, name: run.name }),
              shared: (shared) => t('admin.maps.scope.shared', { key: shared.key }),
              none: t('admin.maps.forbidden'),
              failed: t('admin.maps.failed'),
            }}
          />
        </>
      )}
    </section>
  );
}

/** The shared maps, for site and configuration administrators. */
function SharedMaps({
  client,
  header,
  title,
}: {
  client: ConfigurationClient;
  header: (allowed: boolean, actions?: ReactNode) => ReactNode;
  /** The page's heading, which takes the focus when a map's row goes. */
  title: RefObject<HTMLHeadingElement | null>;
}) {
  const t = useT();
  const expired = useSessionExpiry();
  const nameId = useId();
  const workflowId = useId();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; maps: WorkflowMapSummary[] }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >({ status: 'loading' });
  const [workflows, setWorkflows] = useState<Named[]>([]);
  const [types, setTypes] = useState<Named[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const creating = useNewForm();
  const [name, setName] = useState('');
  const [defaultWorkflow, setDefaultWorkflow] = useState('');
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState({ status: 'loaded', maps: await client.workflowMaps() });
    } catch (error) {
      if (expired(error)) return;
      if (error instanceof ApiError && error.status === 403) setState({ status: 'forbidden' });
      else setState({ status: 'failed' });
    }
  }, [client, expired]);
  useEffect(() => {
    void load();
    void Promise.allSettled([client.workflows(), client.ticketTypes()]).then(([w, ty]) => {
      if (w.status === 'fulfilled') {
        setWorkflows(w.value);
        setDefaultWorkflow(String(w.value[0]?.id ?? ''));
      }
      if (ty.status === 'fulfilled') setTypes(ty.value);
    });
  }, [load, client]);

  const refusal = useCallback((error: unknown) => mapRefusal(t, error), [t]);
  const said = (text: string) => {
    setMessage(text);
    setProblem(null);
    void load();
  };

  if (state.status === 'forbidden') {
    return (
      <>
        {header(false)}
        <p className="page-note">{t('admin.maps.forbidden')}</p>
      </>
    );
  }
  return (
    <>
      {header(
        true,
        <NewButton
          label={t('admin.maps.new')}
          open={creating.open}
          onToggle={creating.toggle}
          ref={creating.button}
          data-tutorial="workflow-map-new"
        />,
      )}
      {creating.open && (
        <form
          className="glass-card people-card people-form"
          aria-label={t('admin.maps.add')}
          onSubmit={(event) => {
            event.preventDefault();
            const wanted = name.trim();
            if (!wanted || !defaultWorkflow) return;
            client
              .createWorkflowMap({ name: wanted, defaultWorkflowId: Number(defaultWorkflow) })
              .then(
                (made) => {
                  setName('');
                  creating.close();
                  said(t('admin.maps.added', { name: made.name }));
                  setOpen(made.id);
                },
                (error) => setProblem(refusal(error)),
              );
          }}
        >
          <div className="form-field">
            <label htmlFor={nameId} className="form-label">
              {t('admin.maps.name')}
            </label>
            <input
              id={nameId}
              type="text"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor={workflowId} className="form-label">
              {t('admin.maps.defaultWorkflow')}
            </label>
            <select
              id={workflowId}
              value={defaultWorkflow}
              onChange={(event) => setDefaultWorkflow(event.target.value)}
            >
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-actions">
            {/* Until the workflows are in, there is no default to give the map (M1-132). */}
            <button type="submit" className="button-primary" disabled={!defaultWorkflow}>
              {t('admin.maps.add')}
            </button>
            <button type="button" className="button-secondary" onClick={creating.close}>
              {t('admin.maps.cancelNew')}
            </button>
          </div>
        </form>
      )}
      <p role="status" className="form-status">
        {message}
      </p>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {state.status === 'loading' && <p className="page-note">{t('admin.maps.loading')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.maps.failed')}
        </p>
      )}
      {state.status === 'loaded' && (
        <ul className="people-list">
          {state.maps.map((m) => (
            <li key={m.id} className="people-item people-group">
              <div className="people-main">
                <p className="people-name">
                  {m.name}
                  {m.isDefault && <span className="people-badge">{t('admin.maps.default')}</span>}
                </p>
                <p className="people-meta">
                  {t('admin.maps.summary', {
                    workflow: m.defaultWorkflow.name,
                    entries: m.entryCount,
                    tracks: m.trackCount,
                  })}
                </p>
              </div>
              <div className="people-actions">
                <button
                  type="button"
                  className="button-secondary people-action"
                  aria-expanded={open === m.id}
                  aria-label={t('admin.maps.manageOf', { name: m.name })}
                  onClick={() => setOpen(open === m.id ? null : m.id)}
                >
                  {t('admin.maps.manage')}
                </button>
              </div>
              {open === m.id && (
                <MapPanel
                  id={m.id}
                  client={client}
                  workflows={workflows}
                  types={types}
                  onChanged={said}
                  onDeleted={(deleted) => {
                    // The map's row goes: the page's heading takes the focus.
                    setOpen(null);
                    said(t('admin.maps.deleted', { name: deleted }));
                    title.current?.focus();
                  }}
                  onProblem={(error) => setProblem(refusal(error))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** What a track's own map names, read once with the page. */
interface OwnLists {
  mapId: number;
  mapName: string;
  workflows: MapWorkflow[];
  types: Named[];
}

/**
 * A local-mode track's own map (T-322): the form of the shared page's Manage, open at once, with
 * the shared workflows and the track's own, for the types the track offers and those the map
 * already names. It is made with the track and goes with it, so it is neither added nor deleted.
 */
function OwnMap({
  client,
  track,
  header,
}: {
  client: ConfigurationClient;
  track: ScopeTrack;
  header: (allowed: boolean) => ReactNode;
}) {
  const t = useT();
  const expired = useSessionExpiry();
  const headingId = useId();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; lists: OwnLists }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >({ status: 'loading' });
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([client.trackWorkflowMap(track.id), client.trackWorkflows(track.id)]).then(
      ([read, workflows]) => {
        if (!live) return;
        const types = new Map<number, Named>();
        for (const { ticketType } of read.ticketTypes) types.set(ticketType.id, ticketType);
        // A type the map names that the track no longer offers can still be taken out.
        for (const { ticketType } of read.workflowMap.entries) types.set(ticketType.id, ticketType);
        setState({
          status: 'loaded',
          lists: {
            mapId: read.workflowMap.id,
            mapName: read.workflowMap.name,
            workflows,
            types: [...types.values()],
          },
        });
      },
      (error: unknown) => {
        if (!live || expired(error)) return;
        const refused = error instanceof ApiError && (error.status === 403 || error.status === 404);
        setState({ status: refused ? 'forbidden' : 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [client, track, expired]);

  if (state.status === 'forbidden') {
    return (
      <>
        {header(false)}
        <p className="page-note">{t('ownSets.notYours')}</p>
      </>
    );
  }
  return (
    <>
      {header(true)}
      <TrackScopeLine track={track} intro={t('admin.maps.trackIntro')} />
      <p role="status" className="form-status">
        {message}
      </p>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {state.status === 'loading' && <p className="page-note">{t('admin.maps.loading')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.maps.trackFailed')}
        </p>
      )}
      {state.status === 'loaded' && (
        <section aria-labelledby={headingId} className="glass-card admin-panel">
          <h2 id={headingId} className="section-title">
            {state.lists.mapName}
          </h2>
          <p className="page-note">{t('admin.maps.trackNote', { key: track.key })}</p>
          <MapPanel
            id={state.lists.mapId}
            client={client}
            // The track's own workflows say so, beside the shared ones of the same name.
            workflows={state.lists.workflows.map((w) => ({
              id: w.id,
              name:
                w.trackId === track.id
                  ? t('admin.maps.ownWorkflow', { name: w.name, key: track.key })
                  : w.name,
            }))}
            types={state.lists.types}
            own
            onChanged={(text) => {
              setMessage(text);
              setProblem(null);
            }}
            onProblem={(error) => {
              if (expired(error)) return;
              setMessage('');
              setProblem(mapRefusal(t, error));
            }}
          />
        </section>
      )}
    </>
  );
}

function MapPanel({
  id,
  client,
  workflows,
  types,
  own = false,
  onChanged,
  onDeleted,
  onProblem,
}: {
  id: number;
  client: ConfigurationClient;
  workflows: Named[];
  types: Named[];
  /** A track's own map, on its own page: it serves that track alone and is never deleted. */
  own?: boolean;
  onChanged: (message: string) => void;
  /** The map is gone; a track's own map has no Delete. */
  onDeleted?: (name: string) => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const formId = useId();
  const [map, setMap] = useState<WorkflowMap | null>(null);
  const [fallback, setFallback] = useState('');
  const [entries, setEntries] = useState<{ ticketTypeId: number; workflowId: number }[]>([]);
  const [newType, setNewType] = useState('');
  /** The change previewed, while its status mapping step is open (T-320). */
  const [mapping, setMapping] = useState<{
    change: MapChange;
    impact: MappingImpact;
    changed: boolean;
  } | null>(null);
  const [migration, setMigration] = useState<StatusMigration | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const saveButton = useRef<HTMLButtonElement>(null);

  const show = (found: WorkflowMap) => {
    setMap(found);
    setFallback(String(found.defaultWorkflow.id));
    setEntries(
      found.entries.map((e) => ({ ticketTypeId: e.ticketType.id, workflowId: e.workflow.id })),
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per map
  useEffect(() => {
    client.workflowMap(id).then(show, onProblem);
  }, [id]);

  if (!map) return <p className="page-note people-panel">{t('admin.maps.loading')}</p>;
  const typeName = (typeId: number) => types.find((ty) => ty.id === typeId)?.name ?? String(typeId);
  const unmapped = types.filter((ty) => !entries.some((e) => e.ticketTypeId === ty.id));

  /**
   * The map's form changed while its mapping step was open: the step was for the change as it
   * was previewed, so it closes, and Save the map previews the map as it is now.
   */
  const edited = () => {
    if (mapping) setMapping(null);
  };
  /** Closes the mapping step, its focus back on Save the map, and says why when it failed. */
  const stop = (error?: unknown) => {
    if (mapping) saveButton.current?.focus();
    setMapping(null);
    if (error !== undefined) onProblem(error);
  };
  const save = async (change: MapChange, typeStatusMapping?: TypeStatusMapping) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      const saved = await client.updateWorkflowMap(id, {
        ...change,
        ...(typeStatusMapping ? { typeStatusMapping } : {}),
      });
      show(saved.workflowMap);
      stop();
      const moving = saved.statusMigration;
      setMigration(moving && moving.status !== 'done' ? moving : null);
      onChanged(
        [t('admin.maps.saved', { name: saved.workflowMap.name }), movedText(t, moving)]
          .filter(Boolean)
          .join(' '),
      );
    } catch (error) {
      if (!needsMapping(error)) stop(error);
      else {
        // Tickets changed since the preview: read it again and ask again.
        await client.workflowMapImpact(id, change).then(
          (impact) => setMapping({ change, impact, changed: true }),
          (again) => stop(again),
        );
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  // A map no track uses moves no ticket; otherwise the preview says whether any must move.
  const submit = async () => {
    const change: MapChange = { defaultWorkflowId: Number(fallback), entries };
    setMigration(null);
    if (map.tracks.length === 0) return save(change);
    try {
      const impact = await client.workflowMapImpact(id, change);
      if (impact.ticketCount === 0) await save(change);
      else setMapping({ change, impact, changed: false });
    } catch (error) {
      stop(error);
    }
  };

  return (
    <>
      <form
        className="people-panel"
        aria-label={t('admin.maps.editOf', { name: map.name })}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="form-field">
          <label htmlFor={`${formId}-default`} className="form-label">
            {t('admin.maps.everyOtherType')}
          </label>
          <select
            id={`${formId}-default`}
            value={fallback}
            onChange={(event) => {
              setFallback(event.target.value);
              edited();
            }}
          >
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        {entries.map((entry) => (
          <div key={entry.ticketTypeId} className="form-field">
            <label htmlFor={`${formId}-type-${entry.ticketTypeId}`} className="form-label">
              {t('admin.maps.typeUses', { type: typeName(entry.ticketTypeId) })}
            </label>
            <span className="people-sublist-row">
              <select
                id={`${formId}-type-${entry.ticketTypeId}`}
                value={entry.workflowId}
                onChange={(event) => {
                  setEntries((list) =>
                    list.map((e) =>
                      e.ticketTypeId === entry.ticketTypeId
                        ? { ...e, workflowId: Number(event.target.value) }
                        : e,
                    ),
                  );
                  edited();
                }}
              >
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="button-secondary people-action"
                aria-label={t('admin.maps.removeEntry', { type: typeName(entry.ticketTypeId) })}
                onClick={() => {
                  setEntries((list) => list.filter((e) => e !== entry));
                  edited();
                }}
              >
                {t('admin.maps.remove')}
              </button>
            </span>
          </div>
        ))}
        {unmapped.length > 0 && (
          <div className="form-field">
            <label htmlFor={`${formId}-new`} className="form-label">
              {t('admin.maps.addType')}
            </label>
            <span className="people-sublist-row">
              <select
                id={`${formId}-new`}
                value={newType}
                onChange={(event) => setNewType(event.target.value)}
              >
                <option value="">{t('admin.maps.pickType')}</option>
                {unmapped.map((ty) => (
                  <option key={ty.id} value={ty.id}>
                    {ty.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="button-secondary people-action"
                disabled={!newType}
                onClick={() => {
                  setEntries((list) => [
                    ...list,
                    { ticketTypeId: Number(newType), workflowId: Number(fallback) },
                  ]);
                  setNewType('');
                  edited();
                }}
              >
                {t('admin.maps.addShort')}
              </button>
            </span>
          </div>
        )}
        {!own && map.tracks.length > 0 && (
          <p className="page-note">
            {t('admin.maps.usedBy', { tracks: map.tracks.map((tr) => tr.key).join(', ') })}
          </p>
        )}
        <div className="form-actions">
          <button ref={saveButton} type="submit" className="button-primary">
            {t('admin.maps.save')}
          </button>
          {/* Asks first, saying what will happen (D13); a refusal keeps the question open. */}
          {!map.isDefault && map.trackId == null && (
            <DangerAction
              label={t('admin.maps.delete')}
              name={t('admin.maps.deleteOf', { name: map.name })}
              outcome={t('admin.maps.confirmDelete', { name: map.name })}
              confirmLabel={t('admin.maps.deleteOf', { name: map.name })}
              onConfirm={async () => {
                try {
                  await client.deleteWorkflowMap(id);
                } catch (error) {
                  onProblem(error);
                  throw error;
                }
                onDeleted?.(map.name);
              }}
            />
          )}
        </div>
      </form>
      {(mapping || migration) && (
        // Under the map's form, across the row, as the form itself is.
        <div className="people-panel">
          {mapping && (
            <StatusMappingPanel
              impact={mapping.impact}
              title={t('admin.maps.mappingTitle', { name: map.name })}
              confirmLabel={t('admin.maps.mappingConfirm')}
              changed={mapping.changed}
              busy={saving}
              onConfirm={(typeStatusMapping) => void save(mapping.change, typeStatusMapping)}
              onCancel={() => stop()}
            />
          )}
          {migration && <MigrationProgress migration={migration} read={client.statusMigration} />}
        </div>
      )}
    </>
  );
}
