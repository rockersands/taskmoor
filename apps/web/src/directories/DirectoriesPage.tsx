import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { type Translate, useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import {
  busy,
  type DirectoriesClient,
  type Directory,
  type DirectoryInput,
  type DirectoryKind,
  type DirectoryRun,
  directoriesClient,
  type KindPreset,
  type RunWarning,
} from './client';
import { DirectoryForm, KIND_LABELS } from './DirectoryForm';

export interface DirectoriesPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: DirectoriesClient;
  /** How long to wait before looking again while a sync waits, runs or is still to come. */
  pollMs?: number;
}

type State =
  | {
      status: 'loaded';
      directories: Directory[];
      presets: Partial<Record<DirectoryKind, KindPreset>>;
    }
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'forbidden' };

type Editing = 'new' | number | null;

/** Counts a run reports, in the order the summary names them. */
const COUNTS: [string, MessageId][] = [
  ['usersCreated', 'admin.directories.run.usersCreated'],
  ['usersLinked', 'admin.directories.run.usersLinked'],
  ['usersUpdated', 'admin.directories.run.usersUpdated'],
  ['usersDeactivated', 'admin.directories.run.usersDeactivated'],
  ['usersReactivated', 'admin.directories.run.usersReactivated'],
  ['usersRemoved', 'admin.directories.run.usersRemoved'],
  ['groupsCreated', 'admin.directories.run.groupsCreated'],
  ['groupsUpdated', 'admin.directories.run.groupsUpdated'],
  ['groupsDeleted', 'admin.directories.run.groupsDeleted'],
  ['warnings', 'admin.directories.run.warnings'],
];

/** Why a run failed, in words where Taskmoor knows the reason; the directory's own otherwise. */
function failureReason(t: Translate, error: string | null): string {
  if (!error) return t('admin.directories.error.unknown');
  if (error.startsWith('safety_stop')) return t('admin.directories.error.safetyStop');
  const known: Record<string, MessageId> = {
    worker_lost: 'admin.directories.error.workerLost',
    worker_stopped: 'admin.directories.error.workerStopped',
    directory_disabled: 'admin.directories.error.directoryDisabled',
    directory_deleted: 'admin.directories.error.directoryDeleted',
  };
  const id = known[error];
  return id ? t(id) : error;
}

/**
 * What Sync and remove will do, with the counts the safety stop gave when it gave them (the
 * server's text reads "safety_stop: the run would remove 812 of 1200 people; ...").
 */
function removalsOutcome(t: Translate, name: string, error: string | null): string {
  const counts = /^safety_stop: the run would remove (\d+) of (\d+) (people|groups)\b/.exec(
    error ?? '',
  );
  if (!counts) return t('admin.directories.confirmRemovalsOutcomeUncounted', { name });
  return t('admin.directories.confirmRemovalsOutcome', {
    name,
    removed: Number(counts[1]),
    known: Number(counts[2]),
    what: counts[3] ?? 'people',
  });
}

const WARNINGS: Record<string, MessageId> = {
  no_email: 'admin.directories.warning.noEmail',
  duplicate_email: 'admin.directories.warning.duplicateEmail',
  email_taken: 'admin.directories.warning.emailTaken',
  service_account_email: 'admin.directories.warning.serviceAccount',
  break_glass_account: 'admin.directories.warning.breakGlass',
  managed_by_other_directory: 'admin.directories.warning.otherDirectory',
  kept_last_admin: 'admin.directories.warning.lastAdmin',
  kept_break_glass: 'admin.directories.warning.keptBreakGlass',
  nesting_cycle: 'admin.directories.warning.nestingCycle',
  no_identifier: 'admin.directories.warning.noIdentifier',
};

/** The first ten different warnings of a run. */
function uniqueWarnings(warnings: RunWarning[]): RunWarning[] {
  const seen = new Map<string, RunWarning>();
  for (const w of warnings) seen.set(`${w.code}:${w.dn ?? ''}:${w.detail ?? ''}`, w);
  return [...seen.values()].slice(0, 10);
}

/** One line about a run: what it was, how it ended, what it changed. */
function runSummary(
  t: Translate,
  formatDate: (value: string) => string,
  run: DirectoryRun,
): string {
  const kind = t(
    run.mode === 'full' ? 'admin.directories.run.full' : 'admin.directories.run.incremental',
  );
  if (run.status === 'queued') return t('admin.directories.run.queued', { kind });
  if (run.status === 'running') return t('admin.directories.run.running', { kind });
  const when = formatDate(run.finishedAt ?? run.createdAt);
  if (run.status === 'failed') {
    return t('admin.directories.run.failed', { kind, when, reason: failureReason(t, run.error) });
  }
  const counts = COUNTS.filter(([key]) => (run.stats[key] ?? 0) > 0).map(([key, id]) =>
    t(id, { count: run.stats[key] ?? 0 }),
  );
  return counts.length > 0
    ? t('admin.directories.run.succeeded', { kind, when, changes: counts.join(', ') })
    : t('admin.directories.run.unchanged', { kind, when });
}

/**
 * LDAP and Active Directory for site administrators (#/admin/directories; M1-082, IAM-005):
 * the directories in precedence order with what they manage and how their last sync went;
 * adding, editing, testing, ordering and deleting them; asking for a sync and reading the
 * history. While a sync waits or runs, the page looks again every few seconds.
 */
export function DirectoriesPage({
  client = directoriesClient,
  pollMs = 3000,
}: DirectoriesPageProps) {
  const t = useT();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const listId = useId();
  const listHeading = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [state, setState] = useState<State>(
    notAdmin ? { status: 'forbidden' } : { status: 'loading' },
  );
  const [editing, setEditing] = useState<Editing>(null);
  const [done, setDone] = useState('');

  const refuse = useCallback(
    (error: unknown): boolean => {
      if (expired(error)) return true;
      if (error instanceof ApiError && error.status === 403) {
        setState({ status: 'forbidden' });
        return true;
      }
      return false;
    },
    [expired],
  );

  const load = useCallback(async () => {
    try {
      const { directories, presets } = await client.list();
      setState({ status: 'loaded', directories, presets });
    } catch (error) {
      if (!refuse(error)) setState({ status: 'failed' });
    }
  }, [client, refuse]);

  useEffect(() => {
    if (!notAdmin) void load();
  }, [notAdmin, load]);

  // Look again while a sync waits or runs, or a new directory waits for its first one, so the
  // outcome shows up without a reload.
  const waiting =
    state.status === 'loaded' &&
    state.directories.some((d) => busy(d.lastRun) || (d.enabled && d.lastRun === null));
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [waiting, load, pollMs]);

  const save = async (target: Directory | null, input: Partial<DirectoryInput>) => {
    setDone('');
    if (target && Object.keys(input).length === 0) {
      setEditing(null);
      setDone(t('admin.directories.unchanged'));
      listHeading.current?.focus();
      return;
    }
    try {
      const saved = target
        ? await client.update(target.id, input)
        : await client.create(input as DirectoryInput);
      setEditing(null);
      setDone(
        t(target ? 'admin.directories.saved' : 'admin.directories.added', { name: saved.name }),
      );
      await load();
      listHeading.current?.focus();
    } catch (error) {
      if (!refuse(error)) throw error;
    }
  };

  const test = async (input: Partial<DirectoryInput> & { id?: number }) => {
    try {
      return await client.test(input);
    } catch (error) {
      if (refuse(error)) return { ok: false as const, error: 'unreachable' as const };
      throw error;
    }
  };

  const move = async (directories: Directory[], index: number, by: -1 | 1) => {
    const ids = directories.map((d) => d.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + by, 0, moved as number);
    setDone('');
    await client.order(ids);
    setDone(t('admin.directories.moved', { name: directories[index]?.name ?? '' }));
    await load();
  };

  return (
    <section aria-labelledby={titleId} className="page sso-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.directories.title')}
        {...(state.status === 'forbidden'
          ? {}
          : { purpose: t('settings.directoriesHint'), about: t('admin.directories.intro') })}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.directories.forbidden')}</p>
      ) : (
        <>
          <div className="sso-sections">
            <section aria-labelledby={listId} className="glass-card account-section">
              <div className="sso-list-head">
                <h2 id={listId} ref={listHeading} tabIndex={-1} className="facts-title">
                  {t('admin.directories.list')}
                </h2>
                {state.status === 'loaded' && (
                  <button
                    ref={addButton}
                    type="button"
                    className="button-primary"
                    aria-expanded={editing === 'new'}
                    onClick={() => {
                      setDone('');
                      setEditing('new');
                    }}
                  >
                    {t('admin.directories.add')}
                  </button>
                )}
              </div>
              {state.status === 'loaded' && editing === 'new' && (
                <div className="sso-editor">
                  <DirectoryForm
                    presets={state.presets}
                    onSave={(input) => save(null, input)}
                    onTest={test}
                    onCancel={() => {
                      setEditing(null);
                      addButton.current?.focus();
                    }}
                  />
                </div>
              )}
              {state.status === 'loading' && (
                <p role="status" className="page-note">
                  {t('admin.directories.loading')}
                </p>
              )}
              {state.status === 'failed' && (
                <p role="alert" className="form-error">
                  {t('admin.directories.failed')}
                </p>
              )}
              {state.status === 'loaded' &&
                (state.directories.length === 0 ? (
                  <EmptyState title={t('empty.directories.title')}>
                    {t('empty.directories.body')}
                  </EmptyState>
                ) : (
                  <>
                    {state.directories.length > 1 && (
                      <p className="page-note">{t('admin.directories.precedence')}</p>
                    )}
                    <ol className="sso-provider-list" aria-labelledby={listId}>
                      {state.directories.map((directory, index) => (
                        <DirectoryItem
                          key={directory.id}
                          directory={directory}
                          presets={state.presets}
                          first={index === 0}
                          last={index === state.directories.length - 1}
                          editing={editing === directory.id}
                          client={client}
                          onEdit={() => {
                            setDone('');
                            setEditing(directory.id);
                          }}
                          onCancelEdit={() => setEditing(null)}
                          onSave={(input) => save(directory, input)}
                          onTest={test}
                          onMove={(by) => move(state.directories, index, by)}
                          onChanged={async (message) => {
                            setDone(message);
                            if (editing === directory.id) setEditing(null);
                            await load();
                          }}
                          onDeleted={async (message) => {
                            setDone(message);
                            if (editing === directory.id) setEditing(null);
                            await load();
                            // The directory's row is gone: the list's heading takes the focus.
                            listHeading.current?.focus();
                          }}
                          refuse={refuse}
                        />
                      ))}
                    </ol>
                  </>
                ))}
              <p role="status" className="form-status">
                {done}
              </p>
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function DirectoryItem({
  directory,
  presets,
  first,
  last,
  editing,
  client,
  onEdit,
  onCancelEdit,
  onSave,
  onTest,
  onMove,
  onChanged,
  onDeleted,
  refuse,
}: {
  directory: Directory;
  presets: Partial<Record<DirectoryKind, KindPreset>>;
  first: boolean;
  last: boolean;
  editing: boolean;
  client: DirectoriesClient;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (input: Partial<DirectoryInput>) => Promise<void>;
  onTest: DirectoriesClient['test'];
  onMove: (by: -1 | 1) => Promise<void>;
  onChanged: (message: string) => Promise<void>;
  onDeleted: (message: string) => Promise<void>;
  refuse: (error: unknown) => boolean;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const fullSyncButton = useRef<HTMLButtonElement>(null);
  // Set when Sync and remove was asked for; focus moves once Full sync is drawn usable again.
  const focusFullSync = useRef(false);
  useEffect(() => {
    const button = fullSyncButton.current;
    if (!focusFullSync.current || !button || button.disabled) return;
    focusFullSync.current = false;
    button.focus();
  });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<DirectoryRun[] | null>(null);
  const formatDate = (value: string) =>
    intl.formatDate(value, { dateStyle: 'medium', timeStyle: 'short' });
  const value = (text: string) => t('common.value', { value: text });

  const act = async (work: () => Promise<void>) => {
    setWorking(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      if (!refuse(e)) setError(t('admin.directories.actionFailed'));
    } finally {
      setWorking(false);
    }
  };

  const syncNow = (mode: 'full' | 'incremental', confirmRemovals = false) =>
    act(async () => {
      try {
        await client.sync(directory.id, mode, confirmRemovals);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'directory_disabled') {
          setError(t('admin.directories.syncDisabled'));
          return;
        }
        throw e;
      }
      setHistory(null);
      await onChanged(t('admin.directories.syncQueued', { name: directory.name }));
    });

  // Unlike syncNow, a refusal throws, so the question stays open with the reason beside it. Once
  // asked for, the run is no longer stopped and the question goes: Full sync takes the focus.
  const confirmRemovals = async () => {
    setWorking(true);
    setError(null);
    try {
      await client.sync(directory.id, 'full', true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'directory_disabled') {
        setError(t('admin.directories.syncDisabled'));
      } else if (!refuse(e)) {
        setError(t('admin.directories.actionFailed'));
      }
      throw e;
    } finally {
      setWorking(false);
    }
    setHistory(null);
    focusFullSync.current = true;
    await onChanged(t('admin.directories.syncQueued', { name: directory.name }));
  };

  const toggleHistory = () =>
    act(async () => {
      setHistory(history ? null : await client.runs(directory.id));
    });

  return (
    <li className="sso-provider">
      <div className="service-account-head">
        <div className="token-main">
          <p className="token-name">
            <span>{value(directory.name)}</span>
            <span className="token-badge">{t(KIND_LABELS[directory.kind])}</span>
            {directory.mode === 'read_write' && (
              <span className="token-badge">{t('admin.directories.readWrite')}</span>
            )}
            {!directory.enabled && (
              <span className="token-badge token-badge-revoked">
                {t('admin.directories.disabled')}
              </span>
            )}
          </p>
          <p className="token-meta">
            <span>
              {t(
                directory.startTls ? 'admin.directories.urlStartTls' : 'admin.directories.urlValue',
                {
                  url: directory.url,
                },
              )}
            </span>
            <span>
              {t('admin.directories.manages', {
                accounts: directory.accounts,
                groups: directory.groups,
              })}
            </span>
            <span>
              {t('admin.directories.schedule', {
                minutes: directory.syncIntervalMinutes,
                hours: directory.fullSyncHours,
              })}
            </span>
          </p>
          <p
            className={
              directory.lastRun?.status === 'failed' ? 'token-meta directory-failed' : 'token-meta'
            }
          >
            <span>
              {directory.lastRun
                ? runSummary(t, formatDate, directory.lastRun)
                : t('admin.directories.neverSynced')}
            </span>
            {directory.enabled && directory.nextSyncAt && !busy(directory.lastRun) && (
              <span>
                {t('admin.directories.nextSync', { when: formatDate(directory.nextSyncAt) })}
              </span>
            )}
          </p>
        </div>
        <div className="token-actions directory-actions">
          {directory.lastRun?.status === 'failed' &&
            directory.lastRun.error?.startsWith('safety_stop') && (
              // Asks first, saying how much goes (D13); a refusal keeps the question open.
              <DangerAction
                label={t('admin.directories.confirmRemovals')}
                name={t('admin.directories.confirmRemovalsNamed', { name: directory.name })}
                outcome={removalsOutcome(t, directory.name, directory.lastRun.error)}
                confirmLabel={t('admin.directories.confirmRemovalsNamed', {
                  name: directory.name,
                })}
                disabled={working || !directory.enabled}
                onConfirm={confirmRemovals}
              />
            )}
          <button
            type="button"
            className="button-secondary"
            aria-label={t('admin.directories.syncNamed', { name: directory.name })}
            disabled={working || !directory.enabled}
            onClick={() => void syncNow('incremental')}
          >
            {t('admin.directories.sync')}
          </button>
          <button
            type="button"
            className="button-secondary"
            ref={fullSyncButton}
            aria-label={t('admin.directories.fullSyncNamed', { name: directory.name })}
            disabled={working || !directory.enabled}
            onClick={() => void syncNow('full')}
          >
            {t('admin.directories.fullSync')}
          </button>
          <button
            type="button"
            className="button-secondary"
            aria-label={t('admin.directories.historyNamed', { name: directory.name })}
            aria-expanded={history !== null}
            aria-controls={`${id}-history`}
            disabled={working}
            onClick={() => void toggleHistory()}
          >
            {t('admin.directories.history')}
          </button>
          {!first && (
            <button
              type="button"
              className="button-secondary"
              aria-label={t('admin.directories.moveUpNamed', { name: directory.name })}
              disabled={working}
              onClick={() => void act(() => onMove(-1))}
            >
              {t('admin.directories.moveUp')}
            </button>
          )}
          {!last && (
            <button
              type="button"
              className="button-secondary"
              aria-label={t('admin.directories.moveDownNamed', { name: directory.name })}
              disabled={working}
              onClick={() => void act(() => onMove(1))}
            >
              {t('admin.directories.moveDown')}
            </button>
          )}
          <button
            ref={editButton}
            type="button"
            className="button-secondary"
            aria-label={t('admin.directories.editNamed', { name: directory.name })}
            aria-expanded={editing}
            aria-controls={`${id}-editor`}
            onClick={onEdit}
          >
            {t('admin.directories.edit')}
          </button>
          {/* Asks first, saying what will happen (D13); a refusal keeps the question open. */}
          <DangerAction
            label={t('admin.directories.delete')}
            name={t('admin.directories.deleteNamed', { name: directory.name })}
            outcome={t('admin.directories.deleteConfirm', {
              name: directory.name,
              accounts: directory.accounts,
            })}
            confirmLabel={t('admin.directories.deleteNamed', { name: directory.name })}
            disabled={working}
            onConfirm={async () => {
              setError(null);
              try {
                await client.remove(directory.id);
              } catch (e) {
                if (e instanceof ApiError && e.code === 'last_admin') {
                  setError(t('admin.directories.lastAdmin'));
                  throw e;
                }
                // Already gone is as good as deleted.
                if (!(e instanceof ApiError && e.status === 404)) {
                  if (!refuse(e)) setError(t('admin.directories.actionFailed'));
                  throw e;
                }
              }
              await onDeleted(t('admin.directories.deleted', { name: directory.name }));
            }}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {history && (
        <div id={`${id}-history`} className="directory-history">
          <h3 className="token-form-title">
            {t('admin.directories.historyTitle', { name: directory.name })}
          </h3>
          {history.length === 0 ? (
            <EmptyState compact title={t('admin.directories.noRuns')} />
          ) : (
            <ul className="directory-runs">
              {history.map((run) => (
                <li key={run.id}>
                  <p className={run.status === 'failed' ? 'directory-failed' : undefined}>
                    {runSummary(t, formatDate, run)}
                  </p>
                  {run.warnings.length > 0 && (
                    <ul className="directory-warnings">
                      {uniqueWarnings(run.warnings).map((w) => {
                        const known = WARNINGS[w.code];
                        const text = known
                          ? t(known)
                          : t('admin.directories.warning.other', { code: w.code });
                        return (
                          <li key={`${w.code}:${w.dn ?? ''}:${w.detail ?? ''}`}>
                            {w.dn
                              ? t('admin.directories.warningAt', { warning: text, entry: w.dn })
                              : text}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {editing && (
        <div id={`${id}-editor`} className="sso-editor">
          <DirectoryForm
            directory={directory}
            presets={presets}
            onSave={onSave}
            onTest={onTest}
            onCancel={() => {
              onCancelEdit();
              editButton.current?.focus();
            }}
          />
        </div>
      )}
    </li>
  );
}
