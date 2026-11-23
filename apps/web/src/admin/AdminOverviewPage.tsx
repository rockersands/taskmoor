import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import type { User } from '../people/client';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { AdminPageLinks } from './AdminGroupPage';
import { useAdminAccess } from './access';
import { type RaisedAlert, raisedAlertText, securityAlertsClient } from './SecurityAlertsForm';
import { loadSystemInfo, type SystemInfo } from './SystemPage';
import { groupsFor } from './sections';

const DAY_SECONDS = 86_400;
/** The overview says when free disk is under a tenth. */
const LOW_DISK = 0.1;
const SHOWN = 5;

/** The reads the overview stands on; stories and tests pass their own. */
export interface OverviewClient {
  system: () => Promise<SystemInfo>;
  alerts: () => Promise<RaisedAlert[]>;
  /** Active people, as `GET /api/v1/users` lists them, up to its limit. */
  people: () => Promise<{ users: User[]; total: number }>;
}

export const overviewClient: OverviewClient = {
  system: loadSystemInfo,
  alerts: async () => (await securityAlertsClient.load()).recent,
  people: () => api<{ users: User[]; total: number }>('/users?status=active&limit=200'),
};

type Load<T> = { status: 'loading' } | { status: 'loaded'; value: T } | { status: 'failed' };

function useLoad<T>(read: () => Promise<T>): Load<T> {
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    read().then(
      (value) => live && setState({ status: 'loaded', value }),
      () => live && setState({ status: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [read]);
  return state;
}

/** What needs attention on this instance, in the order of how much it matters. */
export function healthProblems(info: SystemInfo): MessageId[] {
  const problems: MessageId[] = [];
  if (!info.database.reachable) problems.push('admin.overview.health.database');
  const { migrations } = info.database;
  if (migrations && migrations.pending.length + migrations.unknown.length > 0) {
    problems.push('admin.overview.health.migrations');
  }
  if (info.disk && info.disk.freeBytes < info.disk.totalBytes * LOW_DISK) {
    problems.push('admin.overview.health.disk');
  }
  if (!info.backup || info.backup.ageSeconds > DAY_SECONDS) {
    problems.push('admin.overview.health.backup');
  }
  return problems;
}

/**
 * Where Administration opens (ADR-114). A site administrator sees system health, people who have
 * not signed in yet and recent security alerts, each read on its own so one failing leaves the
 * others. A configuration administrator sees the setup pages: the rest is not theirs.
 */
export function AdminOverviewPage({ client = overviewClient }: { client?: OverviewClient }) {
  const t = useT();
  const titleId = useId();
  const access = useAdminAccess();
  return (
    <section aria-labelledby={titleId} className="page admin-page">
      <PageHeader
        titleId={titleId}
        title={t('nav.administration')}
        {...(access === 'none'
          ? {}
          : {
              purpose: t(
                access === 'setup' ? 'admin.overview.purposeSetup' : 'admin.overview.purpose',
              ),
            })}
      />
      {access === 'none' && <p className="page-note">{t('admin.forbidden')}</p>}
      {(access === 'setup' || access === 'tracks') &&
        groupsFor(access).map((group) => (
          <div key={group.id} className="glass-card admin-panel">
            <AdminPageLinks group={group} />
          </div>
        ))}
      {access === 'site' && (
        <div className="admin-overview">
          <HealthPanel read={client.system} />
          <NotSignedInPanel read={client.people} />
          <AlertsPanel read={client.alerts} />
        </div>
      )}
    </section>
  );
}

function Panel({
  titleId,
  children,
  more,
}: {
  titleId: MessageId;
  children: React.ReactNode;
  more?: { href: string; labelId: MessageId };
}) {
  const t = useT();
  const id = useId();
  return (
    <section aria-labelledby={id} className="glass-card admin-panel">
      <h2 id={id} className="section-title">
        {t(titleId)}
      </h2>
      {children}
      {more && (
        <p className="admin-panel-more">
          <a href={routeHref(more.href)}>{t(more.labelId)}</a>
        </p>
      )}
    </section>
  );
}

function HealthPanel({ read }: { read: OverviewClient['system'] }) {
  const t = useT();
  const intl = useIntl();
  const state = useLoad(read);
  return (
    <Panel
      titleId="admin.overview.health"
      more={{ href: '#/admin/system', labelId: 'admin.overview.health.more' }}
    >
      {state.status === 'loading' && <p className="page-note">{t('admin.overview.loading')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.overview.health.failed')}
        </p>
      )}
      {state.status === 'loaded' && (
        <>
          {healthProblems(state.value).length === 0 ? (
            <p>{t('admin.overview.health.ok')}</p>
          ) : (
            <ul className="admin-panel-list">
              {healthProblems(state.value).map((id) => (
                <li key={id} className="status-warn">
                  {t(id)}
                </li>
              ))}
            </ul>
          )}
          <p className="page-note">
            {t('admin.overview.health.version', {
              version: state.value.version,
              since: intl.formatDate(state.value.startedAt, { dateStyle: 'medium' }),
            })}
          </p>
        </>
      )}
    </Panel>
  );
}

function NotSignedInPanel({ read }: { read: OverviewClient['people'] }) {
  const t = useT();
  const state = useLoad(read);
  const waiting =
    state.status === 'loaded'
      ? state.value.users.filter((u) => !u.hasPassword && u.lastSignInAt === null && !u.erased)
      : [];
  return (
    <Panel
      titleId="admin.overview.waiting"
      more={{ href: '#/admin/users', labelId: 'admin.overview.waiting.more' }}
    >
      {state.status === 'loading' && <p className="page-note">{t('admin.overview.loading')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.overview.waiting.failed')}
        </p>
      )}
      {state.status === 'loaded' &&
        (waiting.length === 0 ? (
          <EmptyState compact title={t('admin.overview.waiting.noneTitle')}>
            {t('admin.overview.waiting.none')}
          </EmptyState>
        ) : (
          <>
            <p className="page-note">
              {t('admin.overview.waiting.count', { count: waiting.length })}
            </p>
            <ul className="admin-panel-list">
              {waiting.slice(0, SHOWN).map((person) => (
                <li key={person.id}>{t('admin.system.plain', { value: person.name })}</li>
              ))}
            </ul>
            {state.value.total > state.value.users.length && (
              <p className="page-note">
                {t('admin.overview.waiting.partial', { count: state.value.users.length })}
              </p>
            )}
          </>
        ))}
    </Panel>
  );
}

function AlertsPanel({ read }: { read: OverviewClient['alerts'] }) {
  const t = useT();
  const intl = useIntl();
  const state = useLoad(read);
  return (
    <Panel
      titleId="admin.alerts.title"
      more={{ href: '#/admin/security', labelId: 'admin.overview.alerts.more' }}
    >
      {state.status === 'loading' && <p className="page-note">{t('admin.overview.loading')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.overview.alerts.failed')}
        </p>
      )}
      {state.status === 'loaded' &&
        (state.value.length === 0 ? (
          <EmptyState compact title={t('admin.alerts.none')}>
            {t('admin.overview.alerts.none')}
          </EmptyState>
        ) : (
          <ul className="admin-panel-list">
            {state.value.slice(0, SHOWN).map((alert) => (
              <li key={alert.id}>
                {/* Worded as the Security page's latest alerts are, window and all (S3-AC-6). */}
                {raisedAlertText(
                  t,
                  alert,
                  intl.formatDate(alert.raisedAt, { dateStyle: 'medium', timeStyle: 'short' }),
                )}
                {alert.subject.address && (
                  <span className="page-note">
                    {' '}
                    {t('admin.alerts.address', { address: alert.subject.address })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ))}
    </Panel>
  );
}
