import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { COMPACT_QUERY, useMediaQuery } from '../shell/useMediaQuery';
import { TableScroller } from './TableScroller';

/** One client's requests over the window, as `GET /api/v1/admin/api-usage` answers (M1-066). */
export interface UsageRow {
  client: {
    kind: 'token' | 'user' | 'address';
    id: string;
    name: string;
    owner: { id: number; name: string } | null;
  };
  requests: number;
  errors: number;
  throttled: number;
}

export interface Limits {
  rate: number;
  burst: number;
}

export interface RateLimits {
  token: Limits;
  user: Limits;
  address: Limits;
  ticketWrite: Limits;
}

export type UsageWindow = 'hour' | 'day';

export interface ApiUsageClient {
  usage: (window: UsageWindow) => Promise<UsageRow[]>;
  limits: () => Promise<RateLimits>;
  saveLimits: (limits: RateLimits) => Promise<RateLimits>;
}

export const apiUsageClient: ApiUsageClient = {
  usage: async (window) =>
    (await api<{ clients: UsageRow[] }>(`/admin/api-usage?window=${window}`)).clients,
  limits: async () => (await api<{ limits: RateLimits }>('/admin/rate-limits')).limits,
  saveLimits: async (limits) =>
    (await api<{ limits: RateLimits }>('/admin/rate-limits', { method: 'PUT', body: limits }))
      .limits,
};

const SCOPES: { key: keyof RateLimits; label: MessageId; hint: MessageId }[] = [
  { key: 'token', label: 'admin.apiUsage.scope.token', hint: 'admin.apiUsage.scope.tokenHint' },
  { key: 'user', label: 'admin.apiUsage.scope.user', hint: 'admin.apiUsage.scope.userHint' },
  {
    key: 'address',
    label: 'admin.apiUsage.scope.address',
    hint: 'admin.apiUsage.scope.addressHint',
  },
  {
    key: 'ticketWrite',
    label: 'admin.apiUsage.scope.ticketWrite',
    hint: 'admin.apiUsage.scope.ticketWriteHint',
  },
];

type Load<T> = { status: 'loading' } | { status: 'loaded'; value: T } | { status: 'failed' };

/**
 * API usage and rate limits for site administrators (M1-066; API-010): the 20 busiest clients
 * of the last hour or day, with their errors and refused requests, and the workspace's limits.
 */
export function ApiUsagePage({ client = apiUsageClient }: { client?: ApiUsageClient }) {
  const t = useT();
  const { session } = useSession();
  const titleId = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [forbidden, setForbidden] = useState(notAdmin);
  const [window, setWindow] = useState<UsageWindow>('hour');
  const [usage, setUsage] = useState<Load<UsageRow[]>>({ status: 'loading' });

  const refresh = useCallback(async () => {
    setUsage({ status: 'loading' });
    try {
      setUsage({ status: 'loaded', value: await client.usage(window) });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 401)) {
        setForbidden(true);
      }
      setUsage({ status: 'failed' });
    }
  }, [client, window]);

  useEffect(() => {
    if (!notAdmin) void refresh();
  }, [notAdmin, refresh]);

  return (
    <section aria-labelledby={titleId} className="page api-usage-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.apiUsage.title')}
        {...(forbidden ? {} : { purpose: t('purpose.apiUsage') })}
      />
      {forbidden ? (
        <p className="page-note">{t('admin.apiUsage.forbidden')}</p>
      ) : (
        <>
          <Usage
            usage={usage}
            window={window}
            onWindow={setWindow}
            onRefresh={() => void refresh()}
          />
          <LimitsForm client={client} />
        </>
      )}
    </section>
  );
}

function Usage({
  usage,
  window,
  onWindow,
  onRefresh,
}: {
  usage: Load<UsageRow[]>;
  window: UsageWindow;
  onWindow: (w: UsageWindow) => void;
  onRefresh: () => void;
}) {
  const t = useT();
  const intl = useIntl();
  const titleId = useId();
  const compact = useMediaQuery(COMPACT_QUERY);
  const caption = t(window === 'hour' ? 'admin.apiUsage.tableHour' : 'admin.apiUsage.tableDay');
  const who = (row: UsageRow) => {
    if (row.client.kind === 'token') {
      return row.client.owner
        ? t('admin.apiUsage.client.tokenOf', {
            name: row.client.name,
            owner: row.client.owner.name,
          })
        : t('admin.apiUsage.client.token', { name: row.client.name });
    }
    if (row.client.kind === 'user')
      return t('admin.apiUsage.client.user', { name: row.client.name });
    return t('admin.apiUsage.client.address', { address: row.client.name });
  };
  return (
    <section aria-labelledby={titleId} className="glass-card account-section">
      <div className="api-usage-header">
        <h2 id={titleId} className="facts-title">
          {t('admin.apiUsage.busiest')}
        </h2>
        <fieldset className="api-usage-window">
          <legend className="visually-hidden">{t('admin.apiUsage.window')}</legend>
          {(['hour', 'day'] as const).map((w) => (
            <button
              key={w}
              type="button"
              className="filter-chip"
              aria-pressed={window === w}
              onClick={() => onWindow(w)}
            >
              {t(w === 'hour' ? 'admin.apiUsage.lastHour' : 'admin.apiUsage.lastDay')}
            </button>
          ))}
          <button type="button" className="button-secondary" onClick={onRefresh}>
            {t('admin.apiUsage.refresh')}
          </button>
        </fieldset>
      </div>
      {usage.status === 'loading' && (
        <p role="status" className="page-note">
          {t('admin.apiUsage.loading')}
        </p>
      )}
      {usage.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.apiUsage.failed')}
        </p>
      )}
      {usage.status === 'loaded' && usage.value.length === 0 && (
        <EmptyState title={t('admin.apiUsage.none')}>{t('empty.apiUsage.body')}</EmptyState>
      )}
      {usage.status === 'loaded' && usage.value.length > 0 && compact && (
        // On a phone one block per client, its figures beneath its name (D19).
        <ul className="api-usage-entries" aria-label={caption}>
          {usage.value.map((row) => (
            <li key={`${row.client.kind}:${row.client.id}`} className="api-usage-entry">
              <p className="api-usage-entry-who">{who(row)}</p>
              <dl className="api-usage-entry-figures">
                <div>
                  <dt>{t('admin.apiUsage.column.requests')}</dt>
                  <dd>{intl.formatNumber(row.requests)}</dd>
                </div>
                <div>
                  <dt>{t('admin.apiUsage.column.errors')}</dt>
                  <dd>{intl.formatNumber(row.errors)}</dd>
                </div>
                <div data-throttled={row.throttled > 0 || undefined}>
                  <dt>{t('admin.apiUsage.column.throttled')}</dt>
                  <dd>{intl.formatNumber(row.throttled)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
      {usage.status === 'loaded' && usage.value.length > 0 && !compact && (
        <TableScroller label={caption}>
          <table className="data-table api-usage-table">
            <caption className="visually-hidden">{caption}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.apiUsage.column.client')}</th>
                <th scope="col">{t('admin.apiUsage.column.requests')}</th>
                <th scope="col">{t('admin.apiUsage.column.errors')}</th>
                <th scope="col">{t('admin.apiUsage.column.throttled')}</th>
              </tr>
            </thead>
            <tbody>
              {usage.value.map((row) => (
                <tr key={`${row.client.kind}:${row.client.id}`}>
                  <th scope="row">{who(row)}</th>
                  <td>{intl.formatNumber(row.requests)}</td>
                  <td>{intl.formatNumber(row.errors)}</td>
                  <td data-throttled={row.throttled > 0 || undefined}>
                    {intl.formatNumber(row.throttled)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}
    </section>
  );
}

function LimitsForm({ client }: { client: ApiUsageClient }) {
  const t = useT();
  const titleId = useId();
  const formId = useId();
  const [limits, setLimits] = useState<RateLimits | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'invalid' | 'failed'>('idle');

  useEffect(() => {
    let live = true;
    client.limits().then(
      (found) => live && setLimits(found),
      () => live && setState('failed'),
    );
    return () => {
      live = false;
    };
  }, [client]);

  if (!limits) {
    return state === 'failed' ? (
      <p role="alert" className="form-error">
        {t('admin.apiUsage.limitsFailed')}
      </p>
    ) : null;
  }

  const change = (scope: keyof RateLimits, field: keyof Limits, value: string) => {
    setState('idle');
    setLimits({ ...limits, [scope]: { ...limits[scope], [field]: Number(value) } });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState('saving');
    try {
      setLimits(await client.saveLimits(limits));
      setState('saved');
    } catch (error) {
      setState(error instanceof ApiError && error.status === 400 ? 'invalid' : 'failed');
    }
  };

  return (
    <section aria-labelledby={titleId} className="glass-card account-section">
      <h2 id={titleId} className="facts-title">
        {t('admin.apiUsage.limits')}
      </h2>
      <p className="page-note">{t('admin.apiUsage.limitsHint')}</p>
      <form id={formId} className="api-limits-form" onSubmit={(e) => void submit(e)}>
        {SCOPES.map((scope) => (
          <fieldset key={scope.key} className="api-limits-scope">
            <legend>{t(scope.label)}</legend>
            <p className="form-hint">{t(scope.hint)}</p>
            <label className="form-field">
              <span className="form-label">{t('admin.apiUsage.rate')}</span>
              <input
                type="number"
                min={1}
                max={10_000}
                required
                value={limits[scope.key].rate}
                onChange={(e) => change(scope.key, 'rate', e.target.value)}
              />
            </label>
            <label className="form-field">
              <span className="form-label">{t('admin.apiUsage.burst')}</span>
              <input
                type="number"
                min={1}
                max={100_000}
                required
                value={limits[scope.key].burst}
                onChange={(e) => change(scope.key, 'burst', e.target.value)}
              />
            </label>
          </fieldset>
        ))}
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={state === 'saving'}>
            {t('admin.apiUsage.save')}
          </button>
          {state === 'saved' && (
            <p role="status" className="form-status">
              {t('admin.apiUsage.saved')}
            </p>
          )}
          {state === 'invalid' && (
            <p role="alert" className="form-error">
              {t('admin.apiUsage.invalid')}
            </p>
          )}
          {state === 'failed' && (
            <p role="alert" className="form-error">
              {t('admin.apiUsage.saveFailed')}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
