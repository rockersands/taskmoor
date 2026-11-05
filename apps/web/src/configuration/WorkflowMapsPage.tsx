import { useCallback, useEffect, useId, useState } from 'react';
import { useNotSetupAdmin } from '../admin/access';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { PageHeader } from '../shell/PageHeader';
import {
  type ConfigurationClient,
  configurationClient,
  type MappingNeeded,
  type Named,
  type WorkflowMap,
  type WorkflowMapSummary,
} from './client';

export interface WorkflowMapsPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: ConfigurationClient;
}

/**
 * Workflow maps (M1-028, WF-001 (3)), for administrators: which workflow each ticket type uses,
 * and the one every other type uses. Shared maps serve any number of shared-mode tracks; the
 * default map serves tracks without one. A change that would leave tickets in statuses their
 * new workflow lacks is refused here with the counts (status mapping through the API).
 */
export function WorkflowMapsPage({ client = configurationClient }: WorkflowMapsPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const titleId = useId();
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
        title={t('admin.maps.title')}
        {...(state.status === 'forbidden'
          ? {}
          : { purpose: t('settings.workflowMapsHint'), about: t('admin.maps.intro') })}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.maps.forbidden')}</p>
      ) : (
        <>
          <form
            className="glass-card people-card people-form"
            data-tutorial="workflow-map-new"
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
            </div>
          </form>
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
                        setOpen(null);
                        said(t('admin.maps.deleted', { name: deleted }));
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
  const [confirming, setConfirming] = useState(false);

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

  return (
    <form
      className="people-panel"
      aria-label={t('admin.maps.editOf', { name: map.name })}
      onSubmit={(event) => {
        event.preventDefault();
        client
          .updateWorkflowMap(id, { defaultWorkflowId: Number(fallback), entries })
          .then((saved) => {
            show(saved);
            onChanged(t('admin.maps.saved', { name: saved.name }));
          }, onProblem);
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
        <button type="submit" className="button-primary">
          {t('admin.maps.save')}
        </button>
        {!map.isDefault &&
          (confirming ? (
            <>
              <span className="people-confirm">
                {t('admin.maps.confirmDelete', { name: map.name })}
              </span>
              <button
                type="button"
                className="button-danger"
                onClick={() =>
                  void client.deleteWorkflowMap(id).then(() => onDeleted(map.name), onProblem)
                }
              >
                {t('admin.maps.confirmYes')}
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => setConfirming(false)}
              >
                {t('admin.maps.confirmNo')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button-secondary"
              aria-label={t('admin.maps.deleteOf', { name: map.name })}
              onClick={() => setConfirming(true)}
            >
              {t('admin.maps.delete')}
            </button>
          ))}
      </div>
    </form>
  );
}
