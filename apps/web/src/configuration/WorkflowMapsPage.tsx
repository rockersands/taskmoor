import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNotSetupAdmin } from '../admin/access';
import { NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
import { PageHeader } from '../shell/PageHeader';
import {
  type ConfigurationClient,
  configurationClient,
  type MapChange,
  type MappingImpact,
  type MappingNeeded,
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

export interface WorkflowMapsPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: ConfigurationClient;
}

/**
 * Workflow maps (M1-028, WF-001 (3)), for administrators: which workflow each ticket type uses,
 * and the one every other type uses. Shared maps serve any number of shared-mode tracks; the
 * default map serves tracks without one. A change that would leave tickets in statuses their
 * new workflow lacks asks first where they go (T-320).
 */
export function WorkflowMapsPage({ client = configurationClient }: WorkflowMapsPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const nameId = useId();
  const workflowId = useId();
  const notAdmin = useNotSetupAdmin();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; maps: WorkflowMapSummary[] }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
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
    if (notAdmin) return;
    void load();
    void Promise.allSettled([client.workflows(), client.ticketTypes()]).then(([w, ty]) => {
      if (w.status === 'fulfilled') {
        setWorkflows(w.value);
        setDefaultWorkflow(String(w.value[0]?.id ?? ''));
      }
      if (ty.status === 'fulfilled') setTypes(ty.value);
    });
  }, [load, notAdmin, client]);

  const refusal = useCallback(
    (error: unknown) => {
      if (!(error instanceof ApiError)) return t('admin.maps.problem.other');
      const body = error.body as { error?: string; statuses?: MappingNeeded[] } | null;
      if (body?.error === 'status_mapping_required') {
        const tickets = (body.statuses ?? []).reduce((n, m) => n + m.ticketCount, 0);
        return t('admin.maps.problem.mapping', { tickets });
      }
      if (body?.error === 'status_migration_running') return t('admin.maps.problem.migrating');
      if (body?.error === 'name_taken') return t('admin.maps.problem.nameTaken');
      if (body?.error === 'workflow_map_in_use') return t('admin.maps.problem.inUse');
      return t('admin.maps.problem.other');
    },
    [t],
  );
  const said = (text: string) => {
    setMessage(text);
    setProblem(null);
    void load();
  };

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        titleRef={title}
        title={t('admin.maps.title')}
        {...(state.status === 'forbidden'
          ? {}
          : {
              purpose: t('settings.workflowMapsHint'),
              about: t('admin.maps.intro'),
              actions: (
                <NewButton
                  label={t('admin.maps.new')}
                  open={creating.open}
                  onToggle={creating.toggle}
                  ref={creating.button}
                  data-tutorial="workflow-map-new"
                />
              ),
            })}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.maps.forbidden')}</p>
      ) : (
        <>
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
                      {m.isDefault && (
                        <span className="people-badge">{t('admin.maps.default')}</span>
                      )}
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
      )}
    </section>
  );
}

function MapPanel({
  id,
  client,
  workflows,
  types,
  onChanged,
  onDeleted,
  onProblem,
}: {
  id: number;
  client: ConfigurationClient;
  workflows: Named[];
  types: Named[];
  onChanged: (message: string) => void;
  onDeleted: (name: string) => void;
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
            onChange={(event) => setFallback(event.target.value)}
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
                onChange={(event) =>
                  setEntries((list) =>
                    list.map((e) =>
                      e.ticketTypeId === entry.ticketTypeId
                        ? { ...e, workflowId: Number(event.target.value) }
                        : e,
                    ),
                  )
                }
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
                onClick={() => setEntries((list) => list.filter((e) => e !== entry))}
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
                }}
              >
                {t('admin.maps.addShort')}
              </button>
            </span>
          </div>
        )}
        {map.tracks.length > 0 && (
          <p className="page-note">
            {t('admin.maps.usedBy', { tracks: map.tracks.map((tr) => tr.key).join(', ') })}
          </p>
        )}
        <div className="form-actions">
          <button ref={saveButton} type="submit" className="button-primary">
            {t('admin.maps.save')}
          </button>
          {/* Asks first, saying what will happen (D13); a refusal keeps the question open. */}
          {!map.isDefault && (
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
                onDeleted(map.name);
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
