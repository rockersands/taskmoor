import { useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { type DataStatement, DataStatementView, useFeatureName } from '../ai/DataStatement';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { TableScroller } from './TableScroller';

/** Sums over a set of AI calls, as `GET /api/v1/admin/ai/usage` answers (M1-077). */
export interface UsageTotals {
  calls: number;
  limited: number;
  failed: number;
  unpriced: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Billionths of a US dollar. */
  costNanos: number;
}

export interface AiUsage {
  from: string;
  to: string;
  totals: UsageTotals;
  byDay: (UsageTotals & { day: string })[];
  byFeature: (UsageTotals & { feature: string })[];
  byPerson: (UsageTotals & { user: { id: number; name: string } | null })[];
  byModel: (UsageTotals & { provider: string; model: string })[];
}

export interface AiCall {
  id: number;
  at: string;
  user: { id: number; name: string } | null;
  feature: string;
  provider: string;
  model: string;
  outcome: 'ok' | 'refused' | 'error' | 'aborted' | 'limited';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costNanos: number;
  priced: boolean;
  latencyMs: number;
}

export interface AiLimit {
  id: number;
  scope: 'workspace' | 'feature' | 'user';
  feature: string | null;
  user: { id: number; name: string } | null;
  period: 'day' | 'week' | 'month';
  metric: 'tokens' | 'cost';
  /** Tokens, or US dollars. */
  amount: number;
  used: number | null;
  resetsAt: string;
}

export interface AiUsageClient {
  usage: (from: string, to: string) => Promise<AiUsage>;
  calls: (from: string, to: string) => Promise<AiCall[]>;
  limits: () => Promise<AiLimit[]>;
  statement: () => Promise<DataStatement>;
}

export const aiUsageClient: AiUsageClient = {
  usage: (from, to) => api<AiUsage>(`/admin/ai/usage?from=${from}&to=${to}`),
  calls: async (from, to) =>
    (await api<{ calls: AiCall[] }>(`/admin/ai/calls?from=${from}&to=${to}&limit=20`)).calls,
  limits: async () => (await api<{ limits: AiLimit[] }>('/admin/ai/limits')).limits,
  statement: async () => (await api<{ statement: DataStatement }>('/admin/ai/statement')).statement,
};

export type UsagePeriod = 'week' | 'month' | 'thisMonth';

const PERIODS: { key: UsagePeriod; label: MessageId }[] = [
  { key: 'week', label: 'admin.aiUsage.last7' },
  { key: 'month', label: 'admin.aiUsage.last30' },
  { key: 'thisMonth', label: 'admin.aiUsage.thisMonth' },
];

const day = (date: Date) => date.toISOString().slice(0, 10);
const NOW = () => new Date();

/** The days of a period, in UTC, as the server counts them. */
export function periodDays(period: UsagePeriod, now: Date): { from: string; to: string } {
  const to = day(now);
  if (period === 'thisMonth') {
    return { from: day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to };
  }
  const back = period === 'week' ? 6 : 29;
  return { from: day(new Date(now.getTime() - back * 86_400_000)), to };
}

const OUTCOMES: Record<AiCall['outcome'], MessageId> = {
  ok: 'admin.aiUsage.outcome.ok',
  refused: 'admin.aiUsage.outcome.refused',
  error: 'admin.aiUsage.outcome.error',
  aborted: 'admin.aiUsage.outcome.aborted',
  limited: 'admin.aiUsage.outcome.limited',
};

const PERIOD_NAMES: Record<AiLimit['period'], MessageId> = {
  day: 'admin.aiUsage.period.day',
  week: 'admin.aiUsage.period.week',
  month: 'admin.aiUsage.period.month',
};

const tokensOf = (t: UsageTotals | AiCall) =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;

type Load<T> = { status: 'loading' } | { status: 'loaded'; value: T } | { status: 'failed' };

function useMoney() {
  const intl = useIntl();
  return (usd: number) =>
    intl.formatNumber(usd, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: usd > 0 && usd < 1 ? 4 : 2,
    });
}

/**
 * AI usage for site administrators (M1-077; OPS-020, IAM-021, IAM-022): what leaves the
 * instance, totals by day, feature, person and model, the spend limits with their use, and
 * the newest calls of the AI audit log. Costs come from the price table; Taskmoor meters
 * nothing itself.
 */
export function AiUsagePage({
  client = aiUsageClient,
  now = NOW,
}: {
  client?: AiUsageClient;
  now?: () => Date;
}) {
  const t = useT();
  const { session } = useSession();
  const titleId = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [forbidden, setForbidden] = useState(notAdmin);
  const [period, setPeriod] = useState<UsagePeriod>('month');
  const [usage, setUsage] = useState<Load<{ usage: AiUsage; calls: AiCall[] }>>({
    status: 'loading',
  });
  const [limits, setLimits] = useState<Load<AiLimit[]>>({ status: 'loading' });
  const [statement, setStatement] = useState<Load<DataStatement>>({ status: 'loading' });

  const refresh = useCallback(async () => {
    setUsage({ status: 'loading' });
    const { from, to } = periodDays(period, now());
    try {
      const [found, calls] = await Promise.all([client.usage(from, to), client.calls(from, to)]);
      setUsage({ status: 'loaded', value: { usage: found, calls } });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 401)) {
        setForbidden(true);
      }
      setUsage({ status: 'failed' });
    }
  }, [client, period, now]);

  useEffect(() => {
    if (!notAdmin) void refresh();
  }, [notAdmin, refresh]);

  useEffect(() => {
    if (notAdmin) return;
    let live = true;
    client.limits().then(
      (value) => live && setLimits({ status: 'loaded', value }),
      () => live && setLimits({ status: 'failed' }),
    );
    client.statement().then(
      (value) => live && setStatement({ status: 'loaded', value }),
      () => live && setStatement({ status: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [client, notAdmin]);

  return (
    <section aria-labelledby={titleId} className="page api-usage-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.aiUsage.title')}
        {...(forbidden ? {} : { purpose: t('purpose.aiUsage'), about: t('admin.aiUsage.about') })}
      />
      {forbidden ? (
        <p className="page-note">{t('admin.aiUsage.forbidden')}</p>
      ) : (
        <>
          {statement.status === 'loaded' && (
            <div className="glass-card account-section">
              <DataStatementView statement={statement.value} />
            </div>
          )}
          {statement.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('admin.aiUsage.statementFailed')}
            </p>
          )}
          <section aria-label={t('admin.aiUsage.usage')} className="glass-card account-section">
            <div className="api-usage-header">
              <h2 className="facts-title">{t('admin.aiUsage.usage')}</h2>
              <fieldset className="api-usage-window">
                <legend className="visually-hidden">{t('admin.aiUsage.period')}</legend>
                {PERIODS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className="filter-chip"
                    aria-pressed={period === p.key}
                    onClick={() => setPeriod(p.key)}
                  >
                    {t(p.label)}
                  </button>
                ))}
                <button type="button" className="button-secondary" onClick={() => void refresh()}>
                  {t('admin.aiUsage.refresh')}
                </button>
              </fieldset>
            </div>
            {usage.status === 'loading' && (
              <p role="status" className="page-note">
                {t('admin.aiUsage.loading')}
              </p>
            )}
            {usage.status === 'failed' && (
              <p role="alert" className="form-error">
                {t('admin.aiUsage.failed')}
              </p>
            )}
            {usage.status === 'loaded' && <Usage usage={usage.value.usage} />}
          </section>
          <Limits limits={limits} />
          {usage.status === 'loaded' && <Calls calls={usage.value.calls} />}
        </>
      )}
    </section>
  );
}

function Totals({ totals }: { totals: UsageTotals }) {
  const t = useT();
  const intl = useIntl();
  const money = useMoney();
  const facts: [MessageId, string][] = [
    ['admin.aiUsage.total.calls', intl.formatNumber(totals.calls)],
    ['admin.aiUsage.total.tokens', intl.formatNumber(tokensOf(totals))],
    ['admin.aiUsage.total.cost', money(totals.costNanos / 1e9)],
    ['admin.aiUsage.total.limited', intl.formatNumber(totals.limited)],
    ['admin.aiUsage.total.failed', intl.formatNumber(totals.failed)],
  ];
  return (
    <>
      <dl className="ai-usage-totals">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{t(label)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {totals.unpriced > 0 && (
        <p className="page-note">{t('admin.aiUsage.unpriced', { count: totals.unpriced })}</p>
      )}
    </>
  );
}

function Breakdown({
  caption,
  first,
  rows,
}: {
  caption: string;
  first: string;
  rows: { key: string; name: string; totals: UsageTotals }[];
}) {
  const t = useT();
  const intl = useIntl();
  const money = useMoney();
  return (
    <TableScroller label={caption}>
      <table className="data-table api-usage-table">
        <caption className="ai-usage-caption">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{first}</th>
            <th scope="col">{t('admin.aiUsage.column.calls')}</th>
            <th scope="col">{t('admin.aiUsage.column.tokens')}</th>
            <th scope="col">{t('admin.aiUsage.column.cost')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.name}</th>
              <td>{intl.formatNumber(row.totals.calls)}</td>
              <td>{intl.formatNumber(tokensOf(row.totals))}</td>
              <td>{money(row.totals.costNanos / 1e9)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroller>
  );
}

function Usage({ usage }: { usage: AiUsage }) {
  const t = useT();
  const intl = useIntl();
  const featureName = useFeatureName();
  if (usage.totals.calls === 0) {
    return <EmptyState title={t('admin.aiUsage.none')}>{t('empty.aiUsage.body')}</EmptyState>;
  }
  const dayName = (d: string) =>
    intl.formatDate(`${d}T00:00:00Z`, { dateStyle: 'medium', timeZone: 'UTC' });
  return (
    <>
      <Totals totals={usage.totals} />
      <div className="ai-usage-breakdowns">
        <Breakdown
          caption={t('admin.aiUsage.byDay')}
          first={t('admin.aiUsage.column.day')}
          rows={usage.byDay.map((r) => ({ key: r.day, name: dayName(r.day), totals: r }))}
        />
        <Breakdown
          caption={t('admin.aiUsage.byFeature')}
          first={t('admin.aiUsage.column.feature')}
          rows={usage.byFeature.map((r) => ({
            key: r.feature,
            name: featureName(r.feature),
            totals: r,
          }))}
        />
        <Breakdown
          caption={t('admin.aiUsage.byPerson')}
          first={t('admin.aiUsage.column.person')}
          rows={usage.byPerson.map((r) => ({
            key: String(r.user?.id ?? 0),
            name: r.user?.name ?? t('admin.aiUsage.system'),
            totals: r,
          }))}
        />
        <Breakdown
          caption={t('admin.aiUsage.byModel')}
          first={t('admin.aiUsage.column.model')}
          rows={usage.byModel.map((r) => ({
            key: `${r.provider}|${r.model}`,
            name: t('admin.aiUsage.modelOf', { model: r.model, provider: r.provider }),
            totals: r,
          }))}
        />
      </div>
    </>
  );
}

function Limits({ limits }: { limits: Load<AiLimit[]> }) {
  const t = useT();
  const intl = useIntl();
  const money = useMoney();
  const featureName = useFeatureName();
  const titleId = useId();
  const what = (limit: AiLimit) => {
    if (limit.scope === 'workspace') return t('admin.aiUsage.scope.workspace');
    if (limit.scope === 'feature') return featureName(limit.feature ?? '');
    return limit.user ? limit.user.name : t('admin.aiUsage.scope.eachPerson');
  };
  const amount = (limit: AiLimit, value: number) =>
    limit.metric === 'cost' ? money(value) : t('admin.aiUsage.tokens', { count: value });
  return (
    <section aria-labelledby={titleId} className="glass-card account-section">
      <h2 id={titleId} className="facts-title">
        {t('admin.aiUsage.limits')}
      </h2>
      <p className="page-note">{t('admin.aiUsage.limitsHint')}</p>
      {limits.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.aiUsage.limitsFailed')}
        </p>
      )}
      {limits.status === 'loaded' && limits.value.length === 0 && (
        <EmptyState compact title={t('admin.aiUsage.noLimits')} />
      )}
      {limits.status === 'loaded' && limits.value.length > 0 && (
        <TableScroller label={t('admin.aiUsage.limits')}>
          <table className="data-table api-usage-table">
            <caption className="visually-hidden">{t('admin.aiUsage.limits')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.aiUsage.column.limit')}</th>
                <th scope="col">{t('admin.aiUsage.column.period')}</th>
                <th scope="col">{t('admin.aiUsage.column.used')}</th>
                <th scope="col">{t('admin.aiUsage.column.resets')}</th>
              </tr>
            </thead>
            <tbody>
              {limits.value.map((limit) => (
                <tr key={limit.id}>
                  <th scope="row">{what(limit)}</th>
                  <td>{t(PERIOD_NAMES[limit.period])}</td>
                  <td data-throttled={(limit.used ?? 0) >= limit.amount || undefined}>
                    {limit.used === null
                      ? t('admin.aiUsage.usedEach', { amount: amount(limit, limit.amount) })
                      : t('admin.aiUsage.usedOf', {
                          used: amount(limit, limit.used),
                          amount: amount(limit, limit.amount),
                        })}
                  </td>
                  <td>
                    {intl.formatDate(limit.resetsAt, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: 'UTC',
                    })}
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

function Calls({ calls }: { calls: AiCall[] }) {
  const t = useT();
  const intl = useIntl();
  const money = useMoney();
  const featureName = useFeatureName();
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="glass-card account-section">
      <h2 id={titleId} className="facts-title">
        {t('admin.aiUsage.calls')}
      </h2>
      <p className="page-note">{t('admin.aiUsage.callsHint')}</p>
      {calls.length === 0 ? (
        <EmptyState compact title={t('admin.aiUsage.none')} />
      ) : (
        <TableScroller label={t('admin.aiUsage.calls')}>
          <table className="data-table api-usage-table">
            <caption className="visually-hidden">{t('admin.aiUsage.calls')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.aiUsage.column.when')}</th>
                <th scope="col">{t('admin.aiUsage.column.person')}</th>
                <th scope="col">{t('admin.aiUsage.column.feature')}</th>
                <th scope="col">{t('admin.aiUsage.column.outcome')}</th>
                <th scope="col">{t('admin.aiUsage.column.tokens')}</th>
                <th scope="col">{t('admin.aiUsage.column.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id}>
                  <th scope="row">
                    {intl.formatDate(c.at, { dateStyle: 'short', timeStyle: 'short' })}
                  </th>
                  <td>{c.user?.name ?? t('admin.aiUsage.system')}</td>
                  <td>{featureName(c.feature)}</td>
                  <td>{t(OUTCOMES[c.outcome])}</td>
                  <td>{intl.formatNumber(tokensOf(c))}</td>
                  <td>{c.priced ? money(c.costNanos / 1e9) : t('admin.aiUsage.noPrice')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}
    </section>
  );
}
