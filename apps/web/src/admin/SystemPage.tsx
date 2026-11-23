import { useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';
import { PageHeader } from '../shell/PageHeader';
import { BreakAtSlashes } from './BreakAtSlashes';
import { Fact, Facts } from './Facts';
import { httpUpdateCheckClient, type UpdateCheckClient, UpdateCheckSection } from './UpdateNotice';

/** What `GET /api/v1/admin/system` returns (OPS-010, M1-103). */
export interface SystemInfo {
  version: string;
  roles: string[];
  startedAt: string;
  uptimeSeconds: number;
  runtime: { node: string; platform: string; arch: string; memoryRssBytes: number };
  database: {
    reachable: boolean;
    version: string | null;
    sizeBytes: number | null;
    migrations: { applied: number; pending: string[]; unknown: string[] } | null;
    pool: { total: number; idle: number; waiting: number; max: number } | null;
  };
  disk: { path: string; freeBytes: number; totalBytes: number } | null;
  backup: { lastAt: string; ageSeconds: number } | null;
  /** Scheduled backups and restore drills (M1-101); null when they cannot be read. */
  backups?: BackupsInfo | null;
}

/** One backup or restore drill from the backup log. */
export interface BackupRun {
  id: string;
  kind: 'scheduled' | 'manual' | 'drill';
  state: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  path: string | null;
  sizeBytes: number | null;
  details: unknown;
  error: string | null;
  pruned: boolean;
}

export interface BackupsInfo {
  schedule: { enabled: boolean; time: string; keep: number; verify: boolean };
  /** Null when they are off or no worker can take one (`workers`). */
  nextAt: string | null;
  /**
   * Whether a worker can take scheduled backups: `off` and `no-directory` when only workers
   * that cannot checked lately; `unknown` when none checked (older servers leave it out).
   */
  workers?: 'ready' | 'off' | 'no-directory' | 'unknown';
  running: BackupRun | null;
  lastSuccess: BackupRun | null;
  lastFailure: BackupRun | null;
  lastDrill: BackupRun | null;
  kept: number;
}

export function loadSystemInfo(): Promise<SystemInfo> {
  return api<SystemInfo>('/admin/system');
}

type State =
  | { status: 'loading' }
  | { status: 'loaded'; info: SystemInfo }
  | { status: 'forbidden' }
  | { status: 'failed' };

const DAY = 86_400;

export interface SystemPageProps {
  /** Stories and tests pass their own source; the page calls the backend otherwise. */
  load?: () => Promise<SystemInfo>;
  /** The new-version card's source (OPS-026), likewise. */
  updates?: UpdateCheckClient;
}

/** The admin status page: one place to see whether this instance is healthy. */
export function SystemPage({
  load = loadSystemInfo,
  updates = httpUpdateCheckClient,
}: SystemPageProps) {
  const t = useT();
  const { session } = useSession();
  const titleId = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [state, setState] = useState<State>(
    notAdmin ? { status: 'forbidden' } : { status: 'loading' },
  );

  const refresh = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'loaded', info: await load() });
    } catch (error) {
      const forbidden = error instanceof ApiError && (error.status === 403 || error.status === 401);
      setState({ status: forbidden ? 'forbidden' : 'failed' });
    }
  }, [load]);

  useEffect(() => {
    if (!notAdmin) void refresh();
  }, [notAdmin, refresh]);

  return (
    <section aria-labelledby={titleId} className="page system-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.system.title')}
        {...(state.status === 'forbidden'
          ? {}
          : {
              purpose: t('purpose.system'),
              about: t('admin.system.about'),
              actions: (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void refresh()}
                  disabled={state.status === 'loading'}
                >
                  {t('admin.system.refresh')}
                </button>
              ),
            })}
      />
      {state.status === 'loading' && (
        <p role="status" className="page-note">
          {t('admin.system.loading')}
        </p>
      )}
      {state.status === 'forbidden' && <p className="page-note">{t('admin.system.forbidden')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.system.failed')}
        </p>
      )}
      {state.status === 'loaded' && <Details info={state.info} updates={updates} />}
    </section>
  );
}

function Details({ info, updates }: { info: SystemInfo; updates: UpdateCheckClient }) {
  const t = useT();
  const intl = useIntl();
  const plain = (value: string | number) => t('admin.system.plain', { value });
  const bytes = (n: number) => {
    const units: [number, MessageId][] = [
      [1e12, 'admin.system.bytes.tb'],
      [1e9, 'admin.system.bytes.gb'],
      [1e6, 'admin.system.bytes.mb'],
      [1e3, 'admin.system.bytes.kb'],
    ];
    const [size, id] = units.find(([u]) => n >= u) ?? [1, 'admin.system.bytes.b' as MessageId];
    return t(id, { value: intl.formatNumber(n / size, { maximumFractionDigits: 1 }) });
  };
  // Local times say their zone, beside the schedule's UTC (AD-33).
  const when = (iso: string) =>
    intl.formatDate(iso, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  const duration = (seconds: number) =>
    t('admin.system.uptimeValue', {
      days: Math.floor(seconds / DAY),
      hours: Math.floor((seconds % DAY) / 3600),
      minutes: Math.floor((seconds % 3600) / 60),
    });
  const db = info.database;
  const unknown = t('admin.system.unknown');

  return (
    <div className="system-sections">
      <Facts title={t('admin.system.instance')}>
        <Fact label={t('admin.system.version')}>{plain(info.version)}</Fact>
        <Fact label={t('admin.system.roles')}>{plain(info.roles.join(', '))}</Fact>
        <Fact label={t('admin.system.started')}>{plain(when(info.startedAt))}</Fact>
        <Fact label={t('admin.system.uptime')}>{duration(info.uptimeSeconds)}</Fact>
      </Facts>
      <UpdateCheckSection client={updates} />
      <Facts title={t('admin.system.database')}>
        <Fact label={t('admin.system.connection')}>
          {/* Healthy reads as success, not in the accent that marks links and warnings (AD-33). */}
          <span className={db.reachable ? 'badge badge-success' : 'status-bad'}>
            {t(db.reachable ? 'admin.system.connected' : 'admin.system.unreachable')}
          </span>
        </Fact>
        <Fact label={t('admin.system.postgres')}>{db.version ? plain(db.version) : unknown}</Fact>
        <Fact label={t('admin.system.size')}>
          {db.sizeBytes === null ? unknown : bytes(db.sizeBytes)}
        </Fact>
        <Fact label={t('admin.system.migrations')}>
          {db.migrations ? (
            <span
              className={
                db.migrations.pending.length + db.migrations.unknown.length > 0 ? 'status-warn' : ''
              }
            >
              {t('admin.system.migrationsValue', {
                applied: db.migrations.applied,
                pending: db.migrations.pending.length,
                unknown: db.migrations.unknown.length,
              })}
            </span>
          ) : (
            unknown
          )}
        </Fact>
        <Fact label={t('admin.system.pool')}>
          {db.pool
            ? t('admin.system.poolValue', {
                inUse: db.pool.total - db.pool.idle,
                max: db.pool.max,
                waiting: db.pool.waiting,
              })
            : unknown}
        </Fact>
      </Facts>
      <Facts title={t('admin.system.storage')}>
        <Fact label={t('admin.system.dataDir')}>
          {/* Breaks only after a '/', never inside a folder's name. */}
          {info.disk ? (
            <BreakAtSlashes text={plain(info.disk.path)} />
          ) : (
            t('admin.system.noDataDir')
          )}
        </Fact>
        {info.disk && (
          <Fact label={t('admin.system.freeSpace')}>
            {t('admin.system.freeValue', {
              free: bytes(info.disk.freeBytes),
              total: bytes(info.disk.totalBytes),
            })}
          </Fact>
        )}
        <Fact label={t('admin.system.lastBackup')}>
          {info.backup ? (
            <>
              {t('admin.system.backupValue', {
                at: when(info.backup.lastAt),
                age: duration(info.backup.ageSeconds),
              })}
              {info.backup.ageSeconds > DAY && (
                <span className="status-warn fact-note">{t('admin.system.staleBackup')}</span>
              )}
            </>
          ) : (
            <span className="status-warn">{t('admin.system.noBackup')}</span>
          )}
        </Fact>
      </Facts>
      {info.backups && <Backups backups={info.backups} bytes={bytes} when={when} plain={plain} />}
      <Facts title={t('admin.system.runtime')}>
        <Fact label={t('admin.system.node')}>{plain(info.runtime.node)}</Fact>
        <Fact label={t('admin.system.platform')}>
          {plain(`${info.runtime.platform} ${info.runtime.arch}`)}
        </Fact>
        <Fact label={t('admin.system.memory')}>{bytes(info.runtime.memoryRssBytes)}</Fact>
      </Facts>
    </div>
  );
}

/** Scheduled backups (M1-101, OPS-008): the schedule and how the last runs went. */
function Backups({
  backups,
  bytes,
  when,
  plain,
}: {
  backups: BackupsInfo;
  bytes: (n: number) => string;
  when: (iso: string) => string;
  plain: (value: string | number) => string;
}) {
  const t = useT();
  const { schedule, lastSuccess, lastFailure, lastDrill } = backups;
  // A failure matters until a backup succeeds after it.
  const failing =
    lastFailure !== null &&
    (lastSuccess === null || Date.parse(lastFailure.startedAt) > Date.parse(lastSuccess.startedAt));
  // A run no worker could take says why in words, not as the server's note to the operator.
  const failureReason = (run: BackupRun) => {
    const reason = (run.details as { reason?: unknown } | null)?.reason;
    return reason === 'off'
      ? t('admin.system.failure.off')
      : reason === 'no-directory'
        ? t('admin.system.failure.noPlace')
        : reason === 'could-not-keep'
          ? t('admin.system.failure.couldNotKeep')
          : null;
  };
  const restoreSeconds = (run: BackupRun) => {
    const seconds = (run.details as { seconds?: { restore?: unknown } } | null)?.seconds?.restore;
    return typeof seconds === 'number' ? seconds : null;
  };
  return (
    <Facts title={t('admin.system.backups')}>
      <Fact label={t('admin.system.schedule')}>
        {schedule.enabled ? (
          t('admin.system.scheduleValue', { time: schedule.time, keep: schedule.keep })
        ) : (
          <span className="status-warn">{t('admin.system.scheduleOff')}</span>
        )}
      </Fact>
      <Fact label={t('admin.system.nextBackup')}>
        {backups.running ? (
          t('admin.system.backupRunning', { at: when(backups.running.startedAt) })
        ) : schedule.enabled && backups.workers === 'off' ? (
          <span className="status-warn">{t('admin.system.noWorkerOff')}</span>
        ) : schedule.enabled && backups.workers === 'no-directory' ? (
          <span className="status-warn">{t('admin.system.noWorkerPlace')}</span>
        ) : backups.nextAt ? (
          plain(when(backups.nextAt))
        ) : (
          t('admin.system.none')
        )}
      </Fact>
      <Fact label={t('admin.system.lastSuccess')}>
        {lastSuccess ? (
          t('admin.system.successValue', {
            at: when(lastSuccess.startedAt),
            size: lastSuccess.sizeBytes === null ? '' : bytes(lastSuccess.sizeBytes),
          })
        ) : (
          <span className="status-warn">{t('admin.system.noneYet')}</span>
        )}
      </Fact>
      <Fact label={t('admin.system.lastFailure')}>
        {lastFailure ? (
          <span className={failing ? 'status-bad' : ''}>
            {t('admin.system.failureValue', {
              at: when(lastFailure.startedAt),
              error: failureReason(lastFailure) ?? lastFailure.error ?? '',
            })}
          </span>
        ) : (
          t('admin.system.none')
        )}
      </Fact>
      <Fact label={t('admin.system.verification')}>
        {lastDrill === null ? (
          t(schedule.verify ? 'admin.system.noneYet' : 'admin.system.verificationOff')
        ) : lastDrill.state === 'succeeded' ? (
          <span className="status-ok">
            {restoreSeconds(lastDrill) === null
              ? t('admin.system.drillPassed', { at: when(lastDrill.startedAt) })
              : t('admin.system.drillPassedIn', {
                  at: when(lastDrill.startedAt),
                  seconds: restoreSeconds(lastDrill) ?? 0,
                })}
          </span>
        ) : (
          <span className="status-bad">
            {t('admin.system.drillFailed', {
              at: when(lastDrill.startedAt),
              error: lastDrill.error ?? '',
            })}
          </span>
        )}
      </Fact>
    </Facts>
  );
}
