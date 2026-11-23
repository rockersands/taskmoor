import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { FEATURE_NAMES, useFeatureName } from '../ai/DataStatement';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import type { ProviderId } from './AiSettingsPage';
import type { AiLimit } from './AiUsagePage';
import { CardHead, NewButton, useNewForm } from './NewButton';

/** A rate of the price table, in US dollars per million tokens (M1-077). */
export interface AiPrice {
  provider: string;
  model: string;
  /** `list` is the published price to check against the bill; `admin` an administrator's rate. */
  source: 'list' | 'admin';
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  longContext: { aboveTokens: number; input: number; output: number } | null;
}

export type NewPrice = Omit<AiPrice, 'source'>;

/** The providers' names as the AI settings give them (S3-AD-3), by the ids the prices carry. */
const PROVIDER_NAMES: Record<ProviderId, MessageId> = {
  anthropic: 'ai.provider.anthropic',
  bedrock: 'ai.provider.bedrock',
  vertex: 'ai.provider.vertex',
  foundry: 'ai.provider.foundry',
  'openai-compatible': 'ai.provider.openaiCompatible',
};

/** The providers a new rate may be for, in the AI page's order: a rate is kept by their id. */
const PRICE_PROVIDERS = Object.keys(PROVIDER_NAMES) as ProviderId[];

const isProviderId = (provider: string): provider is ProviderId =>
  Object.hasOwn(PROVIDER_NAMES, provider);

/** A provider by its name, 'Anthropic API' for `anthropic`; one the app does not know, as it is. */
function providerName(t: ReturnType<typeof useT>, provider: string): string {
  return isProviderId(provider)
    ? t(PROVIDER_NAMES[provider])
    : t('common.value', { value: provider });
}

export interface LimitInput {
  scope: AiLimit['scope'];
  feature: string | null;
  userId: number | null;
  period: AiLimit['period'];
  metric: AiLimit['metric'];
  amount: number;
  alertPercents: number[];
}

/** The limit as the API lists it, with its alerts' percentages. */
export type StoredLimit = AiLimit & { alertPercents?: number[] };

/** The endpoints this page uses. Stories and tests pass their own. */
export interface AiLimitsClient {
  limits: () => Promise<StoredLimit[]>;
  createLimit: (input: LimitInput) => Promise<void>;
  updateLimit: (id: number, input: LimitInput) => Promise<void>;
  deleteLimit: (id: number) => Promise<void>;
  prices: () => Promise<AiPrice[]>;
  setPrice: (price: NewPrice) => Promise<void>;
  /** Back to the list price, or gone for a model that has none. */
  resetPrice: (provider: string, model: string) => Promise<void>;
  findPeople: (query: string) => Promise<{ id: number; name: string }[]>;
}

export const aiLimitsClient: AiLimitsClient = {
  limits: async () => (await api<{ limits: StoredLimit[] }>('/admin/ai/limits')).limits,
  createLimit: async (input) => {
    await api<unknown>('/admin/ai/limits', { method: 'POST', body: input });
  },
  updateLimit: async (id, input) => {
    await api<unknown>(`/admin/ai/limits/${id}`, { method: 'PATCH', body: input });
  },
  deleteLimit: async (id) => {
    await api<unknown>(`/admin/ai/limits/${id}`, { method: 'DELETE' });
  },
  prices: async () => (await api<{ prices: AiPrice[] }>('/admin/ai/prices')).prices,
  setPrice: async (price) => {
    await api<unknown>('/admin/ai/prices', { method: 'PUT', body: price });
  },
  resetPrice: async (provider, model) => {
    const query = new URLSearchParams({ provider, model });
    await api<unknown>(`/admin/ai/prices?${query}`, { method: 'DELETE' });
  },
  findPeople: async (query) =>
    (
      await api<{ people: { id: number; name: string }[] }>(
        `/people/lookup?limit=8&q=${encodeURIComponent(query)}`,
      )
    ).people,
};

/** "Who it counts", which the API says as a scope and an optional person. */
type Who = 'workspace' | 'feature' | 'person' | 'each';

const whoOf = (limit: StoredLimit): Who =>
  limit.scope === 'workspace'
    ? 'workspace'
    : limit.scope === 'feature'
      ? 'feature'
      : limit.user
        ? 'person'
        : 'each';

const PERIODS: AiLimit['period'][] = ['day', 'week', 'month'];
const DEFAULT_ALERTS = '80, 100';

function usd(intl: ReturnType<typeof useIntl>, value: number): string {
  return intl.formatNumber(value, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

/** Limits that stop AI calls, and the prices their costs come from (OPS-020). */
export function AiLimitsPage({ client = aiLimitsClient }: { client?: AiLimitsClient }) {
  const t = useT();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; limits: StoredLimit[]; prices: AiPrice[] }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [limits, prices] = await Promise.all([client.limits(), client.prices()]);
      setState({ status: 'loaded', limits, prices });
    } catch (error) {
      if (expired(error)) return;
      if (error instanceof ApiError && error.status === 403) setState({ status: 'forbidden' });
      else setState({ status: 'failed' });
    }
  }, [client, expired]);
  useEffect(() => {
    if (!notAdmin) void load();
  }, [load, notAdmin]);

  const said = (text: string) => {
    setMessage(text);
    setProblem(null);
    return load();
  };
  const failed = () => setProblem(t('admin.aiLimits.failedAction'));

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.aiLimits.title')}
        {...(state.status === 'forbidden'
          ? {}
          : { purpose: t('admin.aiLimits.purpose'), about: t('admin.aiLimits.about') })}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.aiLimits.forbidden')}</p>
      ) : (
        <>
          <p role="status" className="form-status">
            {message}
          </p>
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
          {state.status === 'loading' && <p className="page-note">{t('admin.aiLimits.loading')}</p>}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('admin.aiLimits.loadFailed')}
            </p>
          )}
          {state.status === 'loaded' && (
            <>
              <LimitsSection limits={state.limits} client={client} said={said} failed={failed} />
              <PricesSection prices={state.prices} client={client} said={said} failed={failed} />
            </>
          )}
        </>
      )}
    </section>
  );
}

interface Feedback {
  /** Says what happened and loads the page again; the promise settles once it is loaded. */
  said: (text: string) => Promise<void>;
  failed: () => void;
  client: AiLimitsClient;
}

function LimitsSection({ limits, client, said, failed }: Feedback & { limits: StoredLimit[] }) {
  const t = useT();
  const id = useId();
  const adding = useNewForm();
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <section aria-labelledby={id} className="glass-card admin-panel">
      {/* The filled "New …" button at the head of the card, the form above the list (D11). */}
      <CardHead
        action={
          <NewButton
            label={t('admin.aiLimits.addLimit')}
            open={adding.open}
            onToggle={adding.toggle}
            ref={adding.button}
          />
        }
      >
        <h2 id={id} ref={heading} tabIndex={-1} className="section-title">
          {t('admin.aiUsage.limits')}
        </h2>
      </CardHead>
      <p className="page-note">{t('admin.aiLimits.limitsHint')}</p>
      {adding.open && (
        <LimitForm
          label={t('admin.aiLimits.addLimit')}
          client={client}
          onSave={(input) =>
            client.createLimit(input).then(() => {
              adding.close();
              said(t('admin.aiLimits.limitAdded'));
            })
          }
          onCancel={adding.close}
        />
      )}
      {limits.length === 0 ? (
        <EmptyState compact title={t('admin.aiUsage.noLimits')}>
          {t('admin.aiLimits.noLimits')}
        </EmptyState>
      ) : (
        <ul className="people-list">
          {limits.map((limit) => (
            <LimitRow
              key={limit.id}
              limit={limit}
              client={client}
              said={said}
              failed={failed}
              onDeleted={() => heading.current?.focus()}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function LimitRow({
  limit,
  client,
  said,
  failed,
  onDeleted,
}: Feedback & {
  limit: StoredLimit;
  /** The limit is gone: the list's heading takes the focus. */
  onDeleted: () => void;
}) {
  const t = useT();
  const intl = useIntl();
  const featureName = useFeatureName();
  const [editing, setEditing] = useState(false);
  const what =
    limit.scope === 'workspace'
      ? t('admin.aiUsage.scope.workspace')
      : limit.scope === 'feature'
        ? featureName(limit.feature ?? '')
        : limit.user
          ? limit.user.name
          : t('admin.aiUsage.scope.eachPerson');
  const amount = (value: number) =>
    limit.metric === 'cost' ? usd(intl, value) : t('admin.aiUsage.tokens', { count: value });
  const period = t(`admin.aiUsage.period.${limit.period}` as MessageId);
  return (
    <li className="people-item people-group">
      <div className="people-main">
        <p className="people-name">{t('admin.aiLimits.limitName', { what, period })}</p>
        <p className="people-meta">
          {limit.used === null
            ? t('admin.aiUsage.usedEach', { amount: amount(limit.amount) })
            : t('admin.aiUsage.usedOf', {
                used: amount(limit.used),
                amount: amount(limit.amount),
              })}
        </p>
        <p className="people-meta">
          {t('admin.aiLimits.resets', {
            at: intl.formatDate(limit.resetsAt, {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: 'UTC',
            }),
          })}
        </p>
      </div>
      <div className="people-actions">
        <button
          type="button"
          className="button-secondary people-action"
          aria-expanded={editing}
          aria-label={t('admin.aiLimits.changeLimit', { what, period })}
          onClick={() => setEditing(!editing)}
        >
          {t('admin.aiLimits.change')}
        </button>
        {/* Asks first, saying what will happen (D13); a refusal keeps the question open. */}
        <DangerAction
          label={t('admin.aiLimits.delete')}
          name={t('admin.aiLimits.deleteLimit', { what, period })}
          outcome={t('admin.aiLimits.confirmDelete', { what })}
          confirmLabel={t('admin.aiLimits.deleteLimit', { what, period })}
          onConfirm={async () => {
            try {
              await client.deleteLimit(limit.id);
            } catch (error) {
              failed();
              throw error;
            }
            await said(t('admin.aiLimits.limitDeleted'));
            onDeleted();
          }}
        />
      </div>
      {editing && (
        <div className="webhook-panel">
          <LimitForm
            label={t('admin.aiLimits.changeLimit', { what, period })}
            limit={limit}
            client={client}
            onSave={(input) =>
              client.updateLimit(limit.id, input).then(() => {
                setEditing(false);
                said(t('admin.aiLimits.limitSaved'));
              })
            }
            onCancel={() => setEditing(false)}
          />
        </div>
      )}
    </li>
  );
}

function LimitForm({
  label,
  limit,
  client,
  onSave,
  onCancel,
}: {
  label: string;
  limit?: StoredLimit;
  client: AiLimitsClient;
  onSave: (input: LimitInput) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const featureName = useFeatureName();
  const features = Object.keys(FEATURE_NAMES);
  const [who, setWho] = useState<Who>(limit ? whoOf(limit) : 'workspace');
  const [feature, setFeature] = useState(limit?.feature ?? features[0] ?? '');
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<{ id: number; name: string }[]>(
    limit?.user ? [limit.user] : [],
  );
  const [person, setPerson] = useState(limit?.user ? String(limit.user.id) : '');
  const [period, setPeriod] = useState<AiLimit['period']>(limit?.period ?? 'month');
  const [metric, setMetric] = useState<AiLimit['metric']>(limit?.metric ?? 'tokens');
  const [amount, setAmount] = useState(limit ? String(limit.amount) : '');
  const [alerts, setAlerts] = useState(limit?.alertPercents?.join(', ') ?? DEFAULT_ALERTS);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (who !== 'person' || query.trim() === '') return;
    let live = true;
    client.findPeople(query.trim()).then(
      (found) => {
        if (!live) return;
        setPeople(found);
        setPerson(String(found[0]?.id ?? ''));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, who, query]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setProblem(t('admin.aiLimits.problem.amount'));
      return;
    }
    if (who === 'person' && !person) {
      setProblem(t('admin.aiLimits.problem.person'));
      return;
    }
    const percents = alerts
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '')
      .map(Number);
    if (percents.length > 5 || percents.some((p) => !Number.isInteger(p) || p < 1 || p > 100)) {
      setProblem(t('admin.aiLimits.problem.alerts'));
      return;
    }
    setProblem(null);
    try {
      await onSave({
        scope: who === 'workspace' ? 'workspace' : who === 'feature' ? 'feature' : 'user',
        feature: who === 'feature' ? feature : null,
        userId: who === 'person' ? Number(person) : null,
        period,
        metric,
        amount: value,
        alertPercents: percents,
      });
    } catch {
      setProblem(t('admin.aiLimits.failedAction'));
    }
  };

  return (
    <form className="form" aria-label={label} onSubmit={(event) => void submit(event)}>
      <div className="form-field">
        <label htmlFor={`${id}-who`} className="form-label">
          {t('admin.aiLimits.who')}
        </label>
        <select id={`${id}-who`} value={who} onChange={(e) => setWho(e.target.value as Who)}>
          <option value="workspace">{t('admin.aiUsage.scope.workspace')}</option>
          <option value="feature">{t('admin.aiLimits.who.feature')}</option>
          <option value="person">{t('admin.aiLimits.who.person')}</option>
          <option value="each">{t('admin.aiUsage.scope.eachPerson')}</option>
        </select>
      </div>
      {who === 'feature' && (
        <div className="form-field">
          <label htmlFor={`${id}-feature`} className="form-label">
            {t('admin.aiLimits.feature')}
          </label>
          <select id={`${id}-feature`} value={feature} onChange={(e) => setFeature(e.target.value)}>
            {features.map((f) => (
              <option key={f} value={f}>
                {featureName(f)}
              </option>
            ))}
          </select>
        </div>
      )}
      {who === 'person' && (
        <>
          <div className="form-field">
            <label htmlFor={`${id}-find`} className="form-label">
              {t('admin.permissions.findPerson')}
            </label>
            <input
              id={`${id}-find`}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-person`} className="form-label">
              {t('admin.permissions.pickPerson')}
            </label>
            <select id={`${id}-person`} value={person} onChange={(e) => setPerson(e.target.value)}>
              {people.length === 0 && (
                <option value="">{t('admin.permissions.pickPersonEmpty')}</option>
              )}
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      <div className="form-field">
        <label htmlFor={`${id}-period`} className="form-label">
          {t('admin.aiUsage.period')}
        </label>
        <select
          id={`${id}-period`}
          value={period}
          aria-describedby={`${id}-period-hint`}
          onChange={(e) => setPeriod(e.target.value as AiLimit['period'])}
        >
          {PERIODS.map((p) => (
            <option key={p} value={p}>
              {t(`admin.aiUsage.period.${p}` as MessageId)}
            </option>
          ))}
        </select>
        <p id={`${id}-period-hint`} className="form-hint">
          {t('admin.aiLimits.periodHint')}
        </p>
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-metric`} className="form-label">
          {t('admin.aiLimits.metric')}
        </label>
        <select
          id={`${id}-metric`}
          value={metric}
          onChange={(e) => setMetric(e.target.value as AiLimit['metric'])}
        >
          <option value="tokens">{t('admin.aiLimits.metric.tokens')}</option>
          <option value="cost">{t('admin.aiLimits.metric.cost')}</option>
        </select>
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-amount`} className="form-label">
          {t(metric === 'cost' ? 'admin.aiLimits.amountUsd' : 'admin.aiLimits.amountTokens')}
        </label>
        <input
          id={`${id}-amount`}
          type="number"
          min="0"
          step="any"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-alerts`} className="form-label">
          {t('admin.aiLimits.alerts')}
        </label>
        <input
          id={`${id}-alerts`}
          value={alerts}
          aria-describedby={`${id}-alerts-hint`}
          onChange={(e) => setAlerts(e.target.value)}
        />
        <p id={`${id}-alerts-hint`} className="form-hint">
          {t('admin.aiLimits.alertsHint')}
        </p>
      </div>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      <div className="people-actions">
        <button type="submit" className="button-primary">
          {t('admin.aiLimits.saveLimit')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.permissions.cancel')}
        </button>
      </div>
    </form>
  );
}

function PricesSection({ prices, client, said, failed }: Feedback & { prices: AiPrice[] }) {
  const t = useT();
  const id = useId();
  const adding = useNewForm();
  return (
    <section aria-labelledby={id} className="glass-card admin-panel">
      <CardHead
        action={
          <NewButton
            label={t('admin.aiLimits.addPrice')}
            open={adding.open}
            onToggle={adding.toggle}
            ref={adding.button}
          />
        }
      >
        <h2 id={id} className="section-title">
          {t('admin.aiLimits.prices')}
        </h2>
      </CardHead>
      <p className="page-note">{t('admin.aiLimits.pricesHint')}</p>
      {adding.open && (
        <PriceForm
          label={t('admin.aiLimits.addPrice')}
          onSave={(price) =>
            client.setPrice(price).then(() => {
              adding.close();
              said(t('admin.aiLimits.priceSaved', { model: price.model }));
            })
          }
          onCancel={adding.close}
        />
      )}
      <ul className="people-list">
        {prices.map((price) => (
          <PriceRow
            key={`${price.provider}|${price.model}`}
            price={price}
            client={client}
            said={said}
            failed={failed}
          />
        ))}
      </ul>
    </section>
  );
}

function PriceRow({ price, client, said, failed }: Feedback & { price: AiPrice }) {
  const t = useT();
  const intl = useIntl();
  const [editing, setEditing] = useState(false);
  const name = t('admin.aiLimits.priceName', {
    provider: providerName(t, price.provider),
    model: price.model,
  });
  return (
    <li className="people-item people-group">
      <div className="people-main">
        <p className="people-name webhook-url">
          {name}
          <span className="people-badge">
            {t(price.source === 'list' ? 'admin.aiLimits.listPrice' : 'admin.aiLimits.yourRate')}
          </span>
        </p>
        <p className="people-meta">
          {t('admin.aiLimits.rates', {
            input: usd(intl, price.input),
            output: usd(intl, price.output),
            cacheRead: usd(intl, price.cacheRead),
            cacheWrite: usd(intl, price.cacheWrite),
          })}
        </p>
        {price.longContext && (
          <p className="people-meta">
            {t('admin.aiLimits.longRates', {
              above: price.longContext.aboveTokens,
              input: usd(intl, price.longContext.input),
              output: usd(intl, price.longContext.output),
            })}
          </p>
        )}
      </div>
      <div className="people-actions">
        <button
          type="button"
          className="button-secondary people-action"
          aria-expanded={editing}
          aria-label={t('admin.aiLimits.changePrice', { name })}
          onClick={() => setEditing(!editing)}
        >
          {t('admin.aiLimits.change')}
        </button>
        {price.source === 'admin' && (
          <button
            type="button"
            className="button-secondary people-action"
            aria-label={t('admin.aiLimits.resetPriceOf', { name })}
            onClick={() =>
              void client
                .resetPrice(price.provider, price.model)
                .then(() => said(t('admin.aiLimits.priceReset', { model: price.model })), failed)
            }
          >
            {t('admin.aiLimits.resetPrice')}
          </button>
        )}
      </div>
      {editing && (
        <div className="webhook-panel">
          <PriceForm
            label={t('admin.aiLimits.changePrice', { name })}
            price={price}
            onSave={(next) =>
              client.setPrice(next).then(() => {
                setEditing(false);
                said(t('admin.aiLimits.priceSaved', { model: next.model }));
              })
            }
            onCancel={() => setEditing(false)}
          />
        </div>
      )}
    </li>
  );
}

function PriceForm({
  label,
  price,
  onSave,
  onCancel,
}: {
  label: string;
  price?: AiPrice;
  onSave: (price: NewPrice) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const [provider, setProvider] = useState(price?.provider ?? '');
  const [model, setModel] = useState(price?.model ?? '');
  const [rates, setRates] = useState({
    input: String(price?.input ?? ''),
    output: String(price?.output ?? ''),
    cacheRead: String(price?.cacheRead ?? ''),
    cacheWrite: String(price?.cacheWrite ?? ''),
  });
  const [above, setAbove] = useState(String(price?.longContext?.aboveTokens ?? ''));
  const [longInput, setLongInput] = useState(String(price?.longContext?.input ?? ''));
  const [longOutput, setLongOutput] = useState(String(price?.longContext?.output ?? ''));
  const [problem, setProblem] = useState<string | null>(null);

  const number = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));
  const valid = (n: number) => Number.isFinite(n) && n >= 0 && n <= 100_000;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const values = {
      input: number(rates.input),
      output: number(rates.output),
      cacheRead: number(rates.cacheRead),
      cacheWrite: number(rates.cacheWrite),
    };
    const longGiven = above.trim() !== '' || longInput.trim() !== '' || longOutput.trim() !== '';
    const longContext = longGiven
      ? { aboveTokens: number(above), input: number(longInput), output: number(longOutput) }
      : null;
    if (
      !provider.trim() ||
      !model.trim() ||
      !Object.values(values).every(valid) ||
      (longContext &&
        !(
          Number.isInteger(longContext.aboveTokens) &&
          longContext.aboveTokens > 0 &&
          valid(longContext.input) &&
          valid(longContext.output)
        ))
    ) {
      setProblem(t('admin.aiLimits.problem.price'));
      return;
    }
    setProblem(null);
    try {
      await onSave({ provider: provider.trim(), model: model.trim(), ...values, longContext });
    } catch {
      setProblem(t('admin.aiLimits.failedAction'));
    }
  };

  const rate = (key: keyof typeof rates, labelId: MessageId) => (
    <div className="form-field">
      <label htmlFor={`${id}-${key}`} className="form-label">
        {t(labelId)}
      </label>
      <input
        id={`${id}-${key}`}
        type="number"
        min="0"
        step="any"
        inputMode="decimal"
        value={rates[key]}
        onChange={(e) => setRates({ ...rates, [key]: e.target.value })}
      />
    </div>
  );

  return (
    <form className="form" aria-label={label} onSubmit={(event) => void submit(event)}>
      <div className="form-field">
        <label htmlFor={`${id}-provider`} className="form-label">
          {t('admin.aiLimits.provider')}
        </label>
        {/* Named as the AI page names it, kept by its id, which the calls carry: a typed name
            would never match them (S3-AD-3). A rate's own provider stays as it is. */}
        {price ? (
          <input id={`${id}-provider`} value={providerName(t, price.provider)} readOnly />
        ) : (
          <>
            <select
              id={`${id}-provider`}
              value={provider}
              aria-describedby={`${id}-provider-hint`}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="">{t('admin.aiLimits.chooseProvider')}</option>
              {PRICE_PROVIDERS.map((choice) => (
                <option key={choice} value={choice}>
                  {providerName(t, choice)}
                </option>
              ))}
            </select>
            <p id={`${id}-provider-hint`} className="form-hint">
              {t('admin.aiLimits.providerHint')}
            </p>
          </>
        )}
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-model`} className="form-label">
          {t('admin.aiLimits.model')}
        </label>
        <input
          id={`${id}-model`}
          dir="ltr"
          value={model}
          readOnly={Boolean(price)}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>
      <fieldset>
        <legend>{t('admin.aiLimits.perMillion')}</legend>
        {rate('input', 'admin.aiLimits.input')}
        {rate('output', 'admin.aiLimits.output')}
        {rate('cacheRead', 'admin.aiLimits.cacheRead')}
        {rate('cacheWrite', 'admin.aiLimits.cacheWrite')}
      </fieldset>
      <fieldset>
        <legend>{t('admin.aiLimits.longContext')}</legend>
        <div className="form-field">
          <label htmlFor={`${id}-above`} className="form-label">
            {t('admin.aiLimits.above')}
          </label>
          <input
            id={`${id}-above`}
            type="number"
            min="1"
            step="1"
            value={above}
            onChange={(e) => setAbove(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-long-input`} className="form-label">
            {t('admin.aiLimits.input')}
          </label>
          <input
            id={`${id}-long-input`}
            type="number"
            min="0"
            step="any"
            value={longInput}
            onChange={(e) => setLongInput(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-long-output`} className="form-label">
            {t('admin.aiLimits.output')}
          </label>
          <input
            id={`${id}-long-output`}
            type="number"
            min="0"
            step="any"
            value={longOutput}
            onChange={(e) => setLongOutput(e.target.value)}
          />
        </div>
      </fieldset>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      <div className="people-actions">
        <button type="submit" className="button-primary">
          {t('admin.aiLimits.savePrice')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.permissions.cancel')}
        </button>
      </div>
    </form>
  );
}
