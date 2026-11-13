import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { navigate, routeHref } from '../routing/router';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import {
  type Imported,
  type WorkflowSummary,
  type WorkflowsClient,
  workflowsClient,
} from './client';
import type { Status, WorkflowDefinition } from './definition';
import { StatusesSection } from './StatusesSection';
import { ImportReport, ImportWorkflowForm } from './WorkflowImport';

export interface WorkflowsPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: WorkflowsClient;
  /** Where a created workflow opens; the app changes the hash. */
  onOpen?: (workflowId: number) => void;
}

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'forbidden' }
  | { status: 'loaded'; workflows: WorkflowSummary[] };

export const workflowHref = (workflowId: number) => `#/admin/workflows/${workflowId}`;

const openByHash = (workflowId: number) => {
  navigate(workflowHref(workflowId));
};

/**
 * Workflows for administrators (#/admin/workflows; M1-030, WF-001, WF-002, CORE-014): the
 * workflows with their published version, draft and how many tracks use them, creating one
 * (empty or as a copy), deleting an unused one, and the workspace's statuses. Each workflow
 * downloads as a file, and a file comes back in as a new workflow or a draft, with a report
 * of what it names that this workspace lacks (M1-127, WF-011).
 */
export function WorkflowsPage({
  client = workflowsClient,
  onOpen = openByHash,
}: WorkflowsPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);
  const reportHeading = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [statuses, setStatuses] = useState<Status[] | null>(null);
  const [statusesFailed, setStatusesFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<{ result: Imported; draft: boolean } | null>(null);
  const [done, setDone] = useState('');

  useEffect(() => {
    if (imported) reportHeading.current?.focus();
  }, [imported]);

  const refuse = useCallback(
    (e: unknown) => {
      if (expired(e)) return true;
      if (e instanceof ApiError && e.status === 403) {
        setState({ status: 'forbidden' });
        return true;
      }
      return false;
    },
    [expired],
  );

  const load = useCallback(async () => {
    try {
      setState({ status: 'loaded', workflows: await client.list() });
    } catch (e) {
      if (!refuse(e)) setState({ status: 'failed' });
    }
  }, [client, refuse]);

  useEffect(() => {
    void load();
    client
      .statuses()
      .then(setStatuses)
      .catch((e: unknown) => {
        if (!refuse(e)) setStatusesFailed(true);
      });
  }, [client, load, refuse]);

  const header = (
    <PageHeader
      titleId={`${id}-title`}
      title={t('admin.workflows.title')}
      {...(state.status === 'forbidden'
        ? {}
        : { purpose: t('settings.workflowsHint'), about: t('admin.workflows.intro') })}
    />
  );

  if (state.status === 'forbidden') {
    return (
      <section aria-labelledby={`${id}-title`} className="page workflows-page">
        {header}
        <p className="page-note">{t('admin.workflows.forbidden')}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${id}-title`} className="page workflows-page">
      {header}
      <div className="sso-sections">
        <section aria-labelledby={`${id}-list`} className="glass-card account-section">
          <div className="sso-list-head">
            <h2 id={`${id}-list`} ref={heading} tabIndex={-1} className="facts-title">
              {t('admin.workflows.list')}
            </h2>
            {state.status === 'loaded' && (
              <div className="token-actions">
                <button
                  ref={importButton}
                  type="button"
                  className="button-secondary"
                  aria-expanded={importing}
                  onClick={() => {
                    setDone('');
                    setCreating(false);
                    setImported(null);
                    setImporting(true);
                  }}
                >
                  {t('admin.workflows.import')}
                </button>
                <button
                  ref={createButton}
                  type="button"
                  className="button-primary"
                  data-tutorial="workflow-new"
                  aria-expanded={creating}
                  onClick={() => {
                    setDone('');
                    setImporting(false);
                    setCreating(true);
                  }}
                >
                  {t('admin.workflows.create')}
                </button>
              </div>
            )}
          </div>
          {state.status === 'loaded' && importing && (
            <ImportWorkflowForm
              client={client}
              workflows={state.workflows}
              statuses={statuses ?? []}
              refuse={refuse}
              onImported={(result, draft) => {
                setImporting(false);
                setImported({ result, draft });
                void load();
                // Statuses the file named may be new here.
                client
                  .statuses()
                  .then(setStatuses)
                  .catch(() => {});
              }}
              onCancel={() => {
                setImporting(false);
                importButton.current?.focus();
              }}
            />
          )}
          {imported && (
            <ImportReport ref={reportHeading} imported={imported.result} draft={imported.draft} />
          )}
          {state.status === 'loaded' && creating && (
            <CreateWorkflowForm
              client={client}
              workflows={state.workflows}
              statuses={statuses ?? []}
              refuse={refuse}
              onCreated={(workflowId) => {
                setCreating(false);
                onOpen(workflowId);
              }}
              onCancel={() => {
                setCreating(false);
                createButton.current?.focus();
              }}
            />
          )}
          {state.status === 'loading' && (
            <p role="status" className="page-note">
              {t('admin.workflows.loading')}
            </p>
          )}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('admin.workflows.failed')}
            </p>
          )}
          {state.status === 'loaded' &&
            (state.workflows.length === 0 ? (
              <EmptyState title={t('admin.workflows.none')}>{t('empty.workflows.body')}</EmptyState>
            ) : (
              <ul className="workflow-list" aria-labelledby={`${id}-list`}>
                {state.workflows.map((workflow) => (
                  <WorkflowItem
                    key={workflow.id}
                    workflow={workflow}
                    client={client}
                    refuse={refuse}
                    onDeleted={async (message) => {
                      setDone(message);
                      await load();
                      heading.current?.focus();
                    }}
                  />
                ))}
              </ul>
            ))}
          <p role="status" className="form-status">
            {done}
          </p>
        </section>
        <StatusesSection
          statuses={statuses}
          failed={statusesFailed}
          client={client}
          onChanged={setStatuses}
          refuse={refuse}
        />
      </div>
    </section>
  );
}

function WorkflowItem({
  workflow,
  client,
  refuse,
  onDeleted,
}: {
  workflow: WorkflowSummary;
  client: WorkflowsClient;
  refuse: (e: unknown) => boolean;
  onDeleted: (message: string) => Promise<void>;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = t('common.value', { value: workflow.name });
  const deletable = !workflow.isDefault && workflow.trackCount === 0;

  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.remove(workflow.id);
      await onDeleted(t('admin.workflows.deleted', { name }));
    } catch (e) {
      if (refuse(e)) return;
      setConfirming(false);
      if (e instanceof ApiError && e.code === 'workflow_in_use') {
        const tracks = ((e.body as { tracks?: { key: string }[] }).tracks ?? []).map((x) =>
          t('common.value', { value: x.key }),
        );
        setError(t('admin.workflows.inUse', { name, tracks: intl.formatList(tracks) }));
      } else if (e instanceof ApiError && e.code === 'default_workflow') {
        setError(t('admin.workflows.defaultCannotDelete'));
      } else {
        setError(t('admin.workflows.actionFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="workflow-item">
      <div className="trash-main">
        <p className="trash-name">
          <a className="workflow-name-link" href={routeHref(workflowHref(workflow.id))}>
            {name}
          </a>{' '}
          {workflow.isDefault && (
            <span className="token-badge">{t('admin.workflows.default')}</span>
          )}{' '}
          {workflow.draftVersion !== null && (
            <span className="token-badge token-badge-replaced">
              {t('admin.workflows.draftBadge', { version: workflow.draftVersion })}
            </span>
          )}
        </p>
        {workflow.description && (
          <p className="trash-meta">{t('common.value', { value: workflow.description })}</p>
        )}
        <p className="trash-meta">
          <span>
            {t('admin.workflows.publishedVersion', { version: workflow.publishedVersion })}
          </span>
          <span>{t('admin.workflows.trackCount', { count: workflow.trackCount })}</span>
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
      {confirming ? (
        <div className="token-confirm">
          <p id={`${id}-confirm`}>{t('admin.workflows.confirmDelete', { name })}</p>
          <div className="token-confirm-actions">
            <button
              ref={confirmButton}
              type="button"
              className="button-danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t('admin.workflows.confirmDeleteButton')}
            </button>
            <button type="button" className="button-secondary" onClick={() => setConfirming(false)}>
              {t('admin.workflows.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="token-actions">
          <a
            className="button-secondary"
            href={routeHref(workflowHref(workflow.id))}
            aria-label={t('admin.workflows.editNamed', { name })}
          >
            {t('admin.workflows.edit')}
          </a>
          <a
            className="button-secondary"
            href={client.exportHref(workflow.id)}
            download
            aria-label={t('admin.workflows.exportNamed', { name })}
          >
            {t('admin.workflows.export')}
          </a>
          {deletable && (
            <button
              type="button"
              className="button-secondary button-danger-quiet"
              aria-label={t('admin.workflows.deleteNamed', { name })}
              onClick={() => setConfirming(true)}
            >
              {t('admin.workflows.delete')}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** A new workflow: moving freely from one initial status, or a copy of another's published version. */
function CreateWorkflowForm({
  client,
  workflows,
  statuses,
  refuse,
  onCreated,
  onCancel,
}: {
  client: WorkflowsClient;
  workflows: WorkflowSummary[];
  statuses: Status[];
  refuse: (e: unknown) => boolean;
  onCreated: (workflowId: number) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [start, setStart] = useState('free');
  const [initial, setInitial] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialId =
    initial || String(statuses.find((s) => s.stage === 'new')?.id ?? statuses[0]?.id ?? '');

  useEffect(() => {
    nameInput.current?.focus();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') {
      setError(t('admin.workflows.form.nameRequired'));
      nameInput.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let definition: WorkflowDefinition;
      if (start === 'free') {
        const statusId = Number(initialId);
        // No transitions asked for: the server gives each status its global one (WF-008 (4)).
        definition = { initialStatusId: statusId, statuses: [{ statusId }], transitions: [] };
      } else {
        definition = (await client.get(Number(start))).published.definition;
      }
      const created = await client.create({
        name: name.trim(),
        ...(description ? { description } : {}),
        definition,
      });
      onCreated(created.id);
    } catch (e) {
      if (refuse(e)) return;
      setError(
        e instanceof ApiError && e.code === 'name_taken'
          ? t('admin.workflows.form.nameTaken')
          : t('admin.workflows.form.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="form sso-editor"
      data-tutorial="workflow-new-form"
      onSubmit={submit}
      aria-label={t('admin.workflows.form.title')}
      noValidate
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`}>{t('admin.workflows.form.name')}</label>
        <input
          ref={nameInput}
          id={`${id}-name`}
          type="text"
          maxLength={255}
          value={name}
          aria-invalid={error === t('admin.workflows.form.nameRequired')}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-description`}>{t('admin.workflows.form.description')}</label>
        <textarea
          id={`${id}-description`}
          rows={2}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-start`}>{t('admin.workflows.form.start')}</label>
        <select id={`${id}-start`} value={start} onChange={(e) => setStart(e.target.value)}>
          <option value="free">{t('admin.workflows.form.free')}</option>
          {workflows.map((w) => (
            <option key={w.id} value={String(w.id)}>
              {t('admin.workflows.form.copyOf', { name: t('common.value', { value: w.name }) })}
            </option>
          ))}
        </select>
      </div>
      {start === 'free' && (
        <div className="form-field">
          <label htmlFor={`${id}-initial`}>{t('admin.workflows.form.initial')}</label>
          <select
            id={`${id}-initial`}
            value={initialId}
            aria-describedby={`${id}-initial-hint`}
            onChange={(e) => setInitial(e.target.value)}
          >
            {statuses.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {t('common.value', { value: s.name })}
              </option>
            ))}
          </select>
          <p id={`${id}-initial-hint`} className="form-hint">
            {t('admin.workflows.form.initialHint')}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button
          type="submit"
          className="button-primary"
          disabled={busy || (start === 'free' && !initialId)}
        >
          {t('admin.workflows.form.submit')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.workflows.cancel')}
        </button>
      </div>
    </form>
  );
}
