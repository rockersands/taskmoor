import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import {
  type Delivery,
  type DeliveryState,
  WEBHOOK_FORMATS,
  type Webhook,
  type WebhookFormat,
  type WebhookInput,
  type WebhooksClient,
  webhooksClient,
} from './client';

/** What a webhook can take, as ticks: a family of events, or one setting's change. */
const EVENT_CHOICES = [
  'ticket.*',
  'comment.*',
  'attachment.*',
  'time_entry.*',
  'ticket_type.*',
  'track.*',
  'release.*',
  'saved_search.*',
  'user.*',
  'sprint.*',
  'board.*',
  'link_policy.updated',
  'time_tracking.settings_updated',
] as const;

const eventLabel = (event: string) => `webhooks.event.${event.replace(/\W/g, '_')}` as MessageId;

/** What was wrong by field, as the server says it. */
type Fields = Record<string, string>;

function fieldsOf(error: unknown): Fields | null {
  if (!(error instanceof ApiError) || error.status !== 400) return null;
  return (error.body as { fields?: Fields } | null)?.fields ?? null;
}

interface Feedback {
  /** Says what happened and loads the list again; the promise settles once it is loaded. */
  said: (text: string) => Promise<void>;
  failed: (error: unknown) => void;
}

/**
 * Webhooks (API-009): send Taskmoor's events to another system. For site administrators: a webhook
 * sends the instance's data to another host.
 */
export function WebhooksPage({ client = webhooksClient }: { client?: WebhooksClient }) {
  const t = useT();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; webhooks: Webhook[] }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState({ status: 'loaded', webhooks: await client.list() });
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
  const failed = () => setProblem(t('webhooks.failedAction'));

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        titleRef={title}
        title={t('webhooks.title')}
        {...(state.status === 'forbidden'
          ? {}
          : { purpose: t('webhooks.purpose'), about: t('webhooks.about') })}
        {...(state.status === 'loaded'
          ? {
              actions: (
                <button
                  type="button"
                  className="button-primary"
                  aria-expanded={creating}
                  onClick={() => setCreating(!creating)}
                >
                  {t('webhooks.new')}
                </button>
              ),
            }
          : {})}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('webhooks.forbidden')}</p>
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
          {state.status === 'loading' && <p className="page-note">{t('webhooks.loading')}</p>}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('webhooks.loadFailed')}
            </p>
          )}
          {creating && (
            <WebhookForm
              label={t('webhooks.new')}
              submitLabel={t('webhooks.create')}
              onCancel={() => setCreating(false)}
              onSave={async (input) => {
                await client.create(input);
                setCreating(false);
                said(t('webhooks.created', { name: input.name }));
              }}
            />
          )}
          {state.status === 'loaded' &&
            (state.webhooks.length === 0 ? (
              <EmptyState title={t('webhooks.emptyTitle')}>{t('webhooks.empty')}</EmptyState>
            ) : (
              <ul className="people-list">
                {state.webhooks.map((webhook) => (
                  <WebhookRow
                    key={webhook.id}
                    webhook={webhook}
                    client={client}
                    said={said}
                    failed={failed}
                    onDeleted={() => title.current?.focus()}
                  />
                ))}
              </ul>
            ))}
        </>
      )}
    </section>
  );
}

function WebhookRow({
  webhook,
  client,
  said,
  failed,
  onDeleted,
}: Feedback & {
  webhook: Webhook;
  client: WebhooksClient;
  /** The webhook is gone: the page's heading takes the focus. */
  onDeleted: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState<'edit' | 'deliveries' | null>(null);
  return (
    <li className="people-item people-group">
      <div className="people-main">
        <p className="people-name">
          {webhook.name}
          {!webhook.enabled && <span className="people-badge">{t('webhooks.off')}</span>}
        </p>
        <p className="people-meta webhook-url">{webhook.url}</p>
        <p className="people-meta">
          {t('webhooks.summary', {
            format: t(`webhooks.format.${webhook.format}` as MessageId),
            events: webhook.events.join(', '),
          })}
        </p>
        {webhook.filterQuery && (
          <p className="people-meta">
            {t('webhooks.onlyMatching', { query: webhook.filterQuery })}
          </p>
        )}
      </div>
      <div className="people-actions">
        <button
          type="button"
          className="button-secondary people-action"
          aria-expanded={open === 'deliveries'}
          aria-label={t('webhooks.deliveriesOf', { name: webhook.name })}
          onClick={() => setOpen(open === 'deliveries' ? null : 'deliveries')}
        >
          {t('webhooks.deliveries')}
        </button>
        <button
          type="button"
          className="button-secondary people-action"
          aria-expanded={open === 'edit'}
          aria-label={t('webhooks.changeOf', { name: webhook.name })}
          onClick={() => setOpen(open === 'edit' ? null : 'edit')}
        >
          {t('webhooks.change')}
        </button>
        {/* Asks first, saying what will happen (D13); a refusal keeps the question open. */}
        <DangerAction
          label={t('webhooks.delete')}
          name={t('webhooks.deleteOf', { name: webhook.name })}
          outcome={t('webhooks.confirmDelete', { name: webhook.name })}
          confirmLabel={t('webhooks.deleteOf', { name: webhook.name })}
          onConfirm={async () => {
            try {
              await client.remove(webhook.id);
            } catch (error) {
              failed(error);
              throw error;
            }
            await said(t('webhooks.deleted', { name: webhook.name }));
            onDeleted();
          }}
        />
      </div>
      {open === 'edit' && (
        <div className="webhook-panel">
          <WebhookForm
            key={webhook.version}
            label={t('webhooks.changeOf', { name: webhook.name })}
            submitLabel={t('webhooks.save')}
            webhook={webhook}
            onCancel={() => setOpen(null)}
            onSave={async (input) => {
              await client.update(webhook.id, webhook.version, input);
              setOpen(null);
              said(t('webhooks.saved', { name: input.name }));
            }}
          />
        </div>
      )}
      {open === 'deliveries' && (
        <div className="webhook-panel">
          <Deliveries webhook={webhook} client={client} />
        </div>
      )}
    </li>
  );
}

function WebhookForm({
  label,
  submitLabel,
  webhook,
  onSave,
  onCancel,
}: {
  label: string;
  submitLabel: string;
  webhook?: Webhook;
  onSave: (input: WebhookInput) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const chosen = webhook?.events ?? ['ticket.*'];
  const [name, setName] = useState(webhook?.name ?? '');
  const [url, setUrl] = useState(webhook?.url ?? '');
  const [format, setFormat] = useState<WebhookFormat>(webhook?.format ?? 'json');
  const [ticks, setTicks] = useState<string[]>(() =>
    chosen.filter((e) => (EVENT_CHOICES as readonly string[]).includes(e)),
  );
  const [others, setOthers] = useState(() =>
    chosen.filter((e) => !(EVENT_CHOICES as readonly string[]).includes(e)).join(', '),
  );
  const [filterQuery, setFilterQuery] = useState(webhook?.filterQuery ?? '');
  const [secret, setSecret] = useState('');
  const [dropSecret, setDropSecret] = useState(false);
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true);
  const [fields, setFields] = useState<Fields>({});
  const [problem, setProblem] = useState<string | null>(null);

  const fieldText = (field: string): string | null => {
    const code = fields[field];
    if (!code) return null;
    const known: Record<string, MessageId> = {
      taken: 'webhooks.problem.taken',
      not_a_url: 'webhooks.problem.notUrl',
      credentials_in_url: 'webhooks.problem.credentials',
      https_required: 'webhooks.problem.https',
      invalid_query: 'webhooks.problem.query',
      required_for_matrix: 'webhooks.problem.matrix',
    };
    return t(known[code] ?? 'webhooks.problem.field');
  };
  const eventProblem = Object.keys(fields).some((f) => f === 'events' || f.startsWith('events.'));
  const invalid = (field: string, on: boolean) =>
    on ? { 'aria-invalid': true, 'aria-describedby': `${id}-${field}-problem` } : {};

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const events = [
      ...ticks,
      ...others
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e !== ''),
    ];
    if (events.length === 0) {
      setFields({ events: 'none' });
      return;
    }
    setFields({});
    setProblem(null);
    try {
      await onSave({
        name: name.trim(),
        url: url.trim(),
        format,
        events,
        filterQuery: filterQuery.trim() || null,
        enabled,
        ...(dropSecret ? { secret: null } : secret ? { secret } : {}),
      });
    } catch (error) {
      const refused = fieldsOf(error);
      if (refused) {
        setFields(refused);
        return;
      }
      const code =
        error instanceof ApiError ? (error.body as { error?: string } | null)?.error : undefined;
      setProblem(
        t(code === 'version_conflict' ? 'webhooks.problem.conflict' : 'webhooks.failedAction'),
      );
    }
  };

  return (
    <form
      className="form glass-card admin-panel"
      aria-label={label}
      onSubmit={(event) => void submit(event)}
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('webhooks.name')}
        </label>
        <input
          id={`${id}-name`}
          required
          maxLength={255}
          value={name}
          onChange={(e) => setName(e.target.value)}
          {...invalid('name', Boolean(fields.name))}
        />
        {fields.name && (
          <p id={`${id}-name-problem`} className="form-error">
            {fieldText('name')}
          </p>
        )}
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-url`} className="form-label">
          {t('webhooks.url')}
        </label>
        <input
          id={`${id}-url`}
          type="url"
          required
          dir="ltr"
          maxLength={2000}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          {...invalid('url', Boolean(fields.url))}
        />
        {fields.url && (
          <p id={`${id}-url-problem`} className="form-error">
            {fieldText('url')}
          </p>
        )}
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-format`} className="form-label">
          {t('webhooks.format')}
        </label>
        <select
          id={`${id}-format`}
          value={format}
          onChange={(e) => setFormat(e.target.value as WebhookFormat)}
        >
          {WEBHOOK_FORMATS.map((f) => (
            <option key={f} value={f}>
              {t(`webhooks.format.${f}` as MessageId)}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="webhook-events">
        <legend>{t('webhooks.events')}</legend>
        {EVENT_CHOICES.map((event) => (
          <div key={event} className="form-field-inline">
            <input
              id={`${id}-${event}`}
              type="checkbox"
              checked={ticks.includes(event)}
              onChange={(e) =>
                setTicks(e.target.checked ? [...ticks, event] : ticks.filter((x) => x !== event))
              }
            />
            <label htmlFor={`${id}-${event}`}>{t(eventLabel(event))}</label>
          </div>
        ))}
      </fieldset>
      <div className="form-field">
        <label htmlFor={`${id}-others`} className="form-label">
          {t('webhooks.otherEvents')}
        </label>
        <input
          id={`${id}-others`}
          dir="ltr"
          value={others}
          aria-describedby={`${id}-others-hint`}
          onChange={(e) => setOthers(e.target.value)}
        />
        <p id={`${id}-others-hint`} className="form-hint">
          {t('webhooks.otherEventsHint')}
        </p>
        {eventProblem && (
          <p role="alert" className="form-error">
            {t(fields.events === 'none' ? 'webhooks.problem.noEvents' : 'webhooks.problem.events')}
          </p>
        )}
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-query`} className="form-label">
          {t('webhooks.filterQuery')}
        </label>
        <input
          id={`${id}-query`}
          dir="ltr"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          {...(fields.filterQuery
            ? { 'aria-invalid': true, 'aria-describedby': `${id}-query-problem` }
            : { 'aria-describedby': `${id}-query-hint` })}
        />
        <p id={`${id}-query-hint`} className="form-hint">
          {t('webhooks.filterQueryHint')}
        </p>
        {fields.filterQuery && (
          <p id={`${id}-query-problem`} className="form-error">
            {fieldText('filterQuery')}
          </p>
        )}
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-secret`} className="form-label">
          {t('webhooks.secret')}
        </label>
        <input
          id={`${id}-secret`}
          type="password"
          autoComplete="new-password"
          minLength={secret ? 16 : undefined}
          maxLength={2000}
          value={secret}
          disabled={dropSecret}
          onChange={(e) => setSecret(e.target.value)}
          {...(fields.secret
            ? { 'aria-invalid': true, 'aria-describedby': `${id}-secret-problem` }
            : { 'aria-describedby': `${id}-secret-hint` })}
        />
        <p id={`${id}-secret-hint`} className="form-hint">
          {t(webhook?.hasSecret ? 'webhooks.secretKept' : 'webhooks.secretHint')}
        </p>
        {fields.secret && (
          <p id={`${id}-secret-problem`} className="form-error">
            {fieldText('secret')}
          </p>
        )}
      </div>
      {webhook?.hasSecret && (
        <div className="form-field-inline">
          <input
            id={`${id}-drop`}
            type="checkbox"
            checked={dropSecret}
            onChange={(e) => setDropSecret(e.target.checked)}
          />
          <label htmlFor={`${id}-drop`}>{t('webhooks.removeSecret')}</label>
        </div>
      )}
      <div className="form-field-inline">
        <input
          id={`${id}-on`}
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <label htmlFor={`${id}-on`}>{t('webhooks.enabled')}</label>
      </div>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      <div className="people-actions">
        <button type="submit" className="button-primary">
          {submitLabel}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.permissions.cancel')}
        </button>
      </div>
    </form>
  );
}

function Deliveries({ webhook, client }: { webhook: Webhook; client: WebhooksClient }) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [filter, setFilter] = useState<DeliveryState | ''>('');
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'loaded'; deliveries: Delivery[] } | { status: 'failed' }
  >({ status: 'loading' });
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      setState({
        status: 'loaded',
        deliveries: await client.deliveries(webhook.id, filter || null),
      });
    } catch {
      setState({ status: 'failed' });
    }
  }, [client, webhook.id, filter]);
  useEffect(() => {
    void load();
  }, [load]);

  const replay = (ids: string[] | 'failed') => {
    client.replay(webhook.id, ids).then(
      () => {
        setMessage(t('webhooks.replayed'));
        void load();
      },
      () => setMessage(t('webhooks.replayFailed')),
    );
  };
  const when = (iso: string) => intl.formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section aria-labelledby={`${id}-title`} className="glass-card admin-panel">
      <h3 id={`${id}-title`} className="facts-title">
        {t('webhooks.deliveriesOf', { name: webhook.name })}
      </h3>
      <div className="form-field">
        <label htmlFor={`${id}-state`} className="form-label">
          {t('webhooks.show')}
        </label>
        <select
          id={`${id}-state`}
          value={filter}
          onChange={(e) => setFilter(e.target.value as DeliveryState | '')}
        >
          <option value="">{t('webhooks.show.all')}</option>
          <option value="failed">{t('webhooks.state.failed')}</option>
          <option value="pending">{t('webhooks.state.pending')}</option>
          <option value="delivered">{t('webhooks.state.delivered')}</option>
        </select>
      </div>
      <p role="status" className="form-status">
        {message}
      </p>
      {state.status === 'loading' && <p className="page-note">{t('webhooks.loading')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('webhooks.deliveriesFailed')}
        </p>
      )}
      {state.status === 'loaded' &&
        (state.deliveries.length === 0 ? (
          <EmptyState compact title={t('webhooks.noDeliveries')} />
        ) : (
          <>
            {state.deliveries.some((d) => d.state === 'failed') && (
              <button type="button" className="button-secondary" onClick={() => replay('failed')}>
                {t('webhooks.replayAll')}
              </button>
            )}
            <ul className="people-list">
              {state.deliveries.map((delivery) => (
                <li key={delivery.id} className="people-item people-group">
                  <div className="people-main">
                    <p className="people-name">
                      {delivery.eventType}
                      <span className="people-badge">
                        {t(`webhooks.state.${delivery.state}` as MessageId)}
                      </span>
                    </p>
                    <p className="people-meta">
                      {t('webhooks.deliveryFacts', {
                        when: when(
                          delivery.deliveredAt ?? delivery.lastAttemptAt ?? delivery.createdAt,
                        ),
                        attempts: delivery.attempts,
                      })}
                      {delivery.lastStatus !== null &&
                        ` ${t('webhooks.lastStatus', { status: delivery.lastStatus })}`}
                    </p>
                    {delivery.lastError && (
                      <p className="people-meta webhook-url">{delivery.lastError}</p>
                    )}
                  </div>
                  {delivery.state === 'failed' && (
                    <div className="people-actions">
                      <button
                        type="button"
                        className="button-secondary people-action"
                        aria-label={t('webhooks.replayOne', { event: delivery.eventType })}
                        onClick={() => replay([delivery.id])}
                      >
                        {t('webhooks.replay')}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        ))}
    </section>
  );
}
