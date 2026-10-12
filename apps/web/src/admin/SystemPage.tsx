import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';

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
}

/** The admin status page: one place to see whether this instance is healthy. */
export function SystemPage({ load = loadSystemInfo }: SystemPageProps) {
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
    <section aria-labelledby={titleId} className="system-page">
      <div className="system-header">
        <h1 id={titleId} className="page-title">
          {t('admin.system.title')}
        </h1>
        {state.status !== 'forbidden' && (
          <button
            type="button"
            className="button-secondary"
            onClick={() => void refresh()}
            disabled={state.status === 'loading'}
          >
            {t('admin.system.refresh')}
          </button>
        )}
      </div>
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
      {state.status === 'loaded' && <Details info={state.info} />}
    </section>
  );
}

function Details({ info }: { info: SystemInfo }) {
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
  const when = (iso: string) => intl.formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' });
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
      <Facts title={t('admin.system.database')}>
        <Fact label={t('admin.system.connection')}>
          <span className={db.reachable ? 'status-ok' : 'status-bad'}>
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
          {info.disk ? plain(info.disk.path) : t('admin.system.noDataDir')}
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

function Facts({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="facts">
      <h2 id={id} className="facts-title">
        {title}
      </h2>
      <dl className="facts-list">{children}</dl>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
