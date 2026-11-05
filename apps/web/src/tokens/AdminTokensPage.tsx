import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import {
  type AdminTokensClient,
  type ApiToken,
  adminTokensClient,
  type BulkCriteria,
  type OwnerSummary,
  type PolicyLimits,
  type TokenFilter,
  type TokenPolicy,
} from './client';
import { TokenItem } from './TokenItem';

export interface AdminTokensPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: AdminTokensClient;
}

const FILTERS: readonly TokenFilter[] = ['all', 'active', 'expiring', 'expired', 'revoked'];

type Inventory =
  | { status: 'loading' }
  | { status: 'loaded'; tokens: ApiToken[]; total: number; owners: OwnerSummary[] }
  | { status: 'failed' };

/**
 * The administrator's token inventory (IAM-007): every personal and service-account token
 * with owner, scopes, last use and expiry; revoke one, revoke many at once, see which are due
 * for rotation, and set the policy (the longest lifetime, the reminder window).
 */
export function AdminTokensPage({ client = adminTokensClient }: AdminTokensPageProps) {
  const t = useT();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const timeZone = session.status === 'signed-in' ? session.user.timeZone : null;
  const [forbidden, setForbidden] = useState(notAdmin);
  const [filter, setFilter] = useState<TokenFilter>('all');
  const [inventory, setInventory] = useState<Inventory>({ status: 'loading' });
  const [policy, setPolicy] = useState<{ policy: TokenPolicy; limits: PolicyLimits } | null>(null);
  // Bumped after a bulk revocation, so the list and the owners are read again.
  const [version, setVersion] = useState(0);

  const refuse = useCallback(
    (error: unknown): boolean => {
      if (expired(error)) return true;
      if (error instanceof ApiError && error.status === 403) {
        setForbidden(true);
        return true;
      }
      return false;
    },
    [expired],
  );

  const load = useCallback(async () => {
    try {
      const answer = await client.list(filter);
      setInventory({ status: 'loaded', ...answer });
    } catch (error) {
      if (!refuse(error)) setInventory({ status: 'failed' });
    }
  }, [client, filter, refuse]);

  useEffect(() => {
    if (forbidden) return;
    void version;
    void load();
  }, [forbidden, load, version]);

  useEffect(() => {
    if (forbidden) return;
    client.policy().then(setPolicy, (error: unknown) => {
      refuse(error);
    });
  }, [client, forbidden, refuse]);

  const header = (
    <PageHeader
      titleId={titleId}
      title={t('admin.tokens.title')}
      {...(forbidden
        ? {}
        : { purpose: t('settings.apiTokensHint'), about: t('admin.tokens.intro') })}
    />
  );

  if (forbidden) {
    return (
      <section aria-labelledby={titleId} className="page tokens-page">
        {header}
        <p className="page-note">{t('admin.tokens.forbidden')}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={titleId} className="page tokens-page">
      {header}
      <div className="tokens-page-sections">
        <InventorySection
          client={client}
          filter={filter}
          onFilter={setFilter}
          inventory={inventory}
          reminderDays={policy?.policy.reminderDays ?? 14}
          timeZone={timeZone}
          onChanged={load}
          refuse={refuse}
        />
        <BulkSection
          client={client}
          owners={inventory.status === 'loaded' ? inventory.owners : []}
          onRevoked={() => setVersion((v) => v + 1)}
          refuse={refuse}
        />
        {policy && (
          <PolicySection
            client={client}
            policy={policy.policy}
            limits={policy.limits}
            onSaved={setPolicy}
            refuse={refuse}
          />
        )}
      </div>
    </section>
  );
}

function InventorySection({
  client,
  filter,
  onFilter,
  inventory,
  reminderDays,
  timeZone,
  onChanged,
  refuse,
}: {
  client: AdminTokensClient;
  filter: TokenFilter;
  onFilter: (filter: TokenFilter) => void;
  inventory: Inventory;
  reminderDays: number;
  timeZone: string | null;
  onChanged: () => Promise<void>;
  refuse: (error: unknown) => boolean;
}) {
  const t = useT();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState<string | null>(null);

  const revoke = async (token: ApiToken) => {
    setBusy(true);
    setDone('');
    setError(null);
    try {
      try {
        await client.revoke(token.id);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      heading.current?.focus();
      setDone(t('admin.tokens.revoked', { name: token.name, owner: token.owner.name }));
    } catch (e) {
      if (refuse(e)) return;
      setError(t('tokens.revokeFailed'));
    } finally {
      setBusy(false);
    }
    await onChanged();
  };

  return (
    <section aria-labelledby={`${id}-title`} className="glass-card account-section">
      <h2 id={`${id}-title`} ref={heading} tabIndex={-1} className="facts-title">
        {t('admin.tokens.list')}
      </h2>
      <div className="form-field tokens-filter">
        <label htmlFor={`${id}-filter`}>{t('admin.tokens.filter')}</label>
        <select
          id={`${id}-filter`}
          value={filter}
          onChange={(e) => onFilter(e.target.value as TokenFilter)}
        >
          {FILTERS.map((f) => (
            <option key={f} value={f}>
              {t(`admin.tokens.filter.${f}`)}
            </option>
          ))}
        </select>
      </div>
      {inventory.status === 'loading' && <p className="page-note">{t('admin.tokens.loading')}</p>}
      {inventory.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.tokens.failed')}
        </p>
      )}
      {inventory.status === 'loaded' && (
        <>
          <p className="page-note">{t('admin.tokens.count', { count: inventory.total })}</p>
          {inventory.tokens.length === 0 ? (
            <EmptyState title={t('admin.tokens.empty')}>{t('empty.adminTokens.body')}</EmptyState>
          ) : (
            <ul className="token-list" aria-label={t('admin.tokens.list')}>
              {inventory.tokens.map((token) => (
                <TokenItem
                  key={token.id}
                  token={token}
                  reminderDays={reminderDays}
                  timeZone={timeZone}
                  showOwner
                  actions={
                    token.status === 'active' ? (
                      <button
                        type="button"
                        className="button-secondary"
                        aria-label={t('admin.tokens.revokeNamed', {
                          name: token.name,
                          owner: token.owner.name,
                        })}
                        disabled={busy}
                        onClick={() => void revoke(token)}
                      >
                        {t('tokens.revoke')}
                      </button>
                    ) : undefined
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <p role="status" className="form-status">
        {done}
      </p>
    </section>
  );
}

type Mode = 'owner' | 'before' | 'all';

function BulkSection({
  client,
  owners,
  onRevoked,
  refuse,
}: {
  client: AdminTokensClient;
  owners: OwnerSummary[];
  onRevoked: () => void;
  refuse: (error: unknown) => boolean;
}) {
  const t = useT();
  const id = useId();
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<Mode>('owner');
  const [ownerId, setOwnerId] = useState('');
  const [before, setBefore] = useState('');
  const [pending, setPending] = useState<{ criteria: BulkCriteria; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const field = (key: string) => `${id}-${key}`;

  useEffect(() => {
    if (pending) confirmButton.current?.focus();
  }, [pending]);

  const criteria = (): BulkCriteria | null => {
    if (mode === 'all') return { all: true };
    if (mode === 'owner') return ownerId ? { ownerId: Number(ownerId) } : null;
    // The start of the chosen day in the reader's own time zone.
    return before ? { createdBefore: new Date(`${before}T00:00:00`).toISOString() } : null;
  };

  const preview = async (event: FormEvent) => {
    event.preventDefault();
    const chosen = criteria();
    if (!chosen) return;
    setBusy(true);
    setDone('');
    setError(null);
    try {
      setPending({ criteria: chosen, count: await client.bulkRevoke(chosen, true) });
    } catch (e) {
      if (!refuse(e)) setError(t('admin.tokens.bulkFailed'));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const count = await client.bulkRevoke(pending.criteria, false);
      setPending(null);
      setDone(t('admin.tokens.bulkDone', { count }));
      onRevoked();
    } catch (e) {
      if (!refuse(e)) setError(t('admin.tokens.bulkFailed'));
    } finally {
      setBusy(false);
    }
  };

  const changed = () => {
    setPending(null);
    setDone('');
  };

  return (
    <section aria-labelledby={field('title')} className="glass-card account-section">
      <h2 id={field('title')} className="facts-title">
        {t('admin.tokens.bulk')}
      </h2>
      <p className="page-note">{t('admin.tokens.bulkIntro')}</p>
      <form className="form" onSubmit={preview}>
        <fieldset>
          <legend>{t('admin.tokens.bulkWhich')}</legend>
          {(['owner', 'before', 'all'] as const).map((m) => (
            <div key={m} className="form-field form-field-inline">
              <input
                id={field(`mode-${m}`)}
                type="radio"
                name={field('mode')}
                value={m}
                checked={mode === m}
                onChange={() => {
                  setMode(m);
                  changed();
                }}
              />
              <label htmlFor={field(`mode-${m}`)}>
                {t(
                  m === 'owner'
                    ? 'admin.tokens.bulkOwner'
                    : m === 'before'
                      ? 'admin.tokens.bulkBefore'
                      : 'admin.tokens.bulkAll',
                )}
              </label>
            </div>
          ))}
        </fieldset>
        {mode === 'owner' && (
          <div className="form-field">
            <label htmlFor={field('owner')}>{t('admin.tokens.owner')}</label>
            <select
              id={field('owner')}
              required
              value={ownerId}
              onChange={(e) => {
                setOwnerId(e.target.value);
                changed();
              }}
            >
              <option value="">{t('admin.tokens.chooseOwner')}</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {t('admin.tokens.ownerOption', {
                    name: o.name,
                    email: o.email,
                    count: o.activeTokens,
                  })}
                </option>
              ))}
            </select>
          </div>
        )}
        {mode === 'before' && (
          <div className="form-field">
            <label htmlFor={field('before')}>{t('admin.tokens.before')}</label>
            <input
              id={field('before')}
              type="date"
              required
              value={before}
              onChange={(e) => {
                setBefore(e.target.value);
                changed();
              }}
            />
          </div>
        )}
        {!pending && (
          <div>
            <button type="submit" className="button-secondary" disabled={busy}>
              {t('admin.tokens.bulkRevoke')}
            </button>
          </div>
        )}
      </form>
      {pending && (
        <div className="token-confirm">
          <p>{t('admin.tokens.bulkConfirm', { count: pending.count })}</p>
          <div className="token-confirm-actions">
            {pending.count > 0 && (
              <button
                ref={confirmButton}
                type="button"
                className="button-danger"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {t('admin.tokens.confirm')}
              </button>
            )}
            <button type="button" className="button-secondary" onClick={() => setPending(null)}>
              {t('admin.tokens.cancel')}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <p role="status" className="form-status">
        {done}
      </p>
    </section>
  );
}

function PolicySection({
  client,
  policy,
  limits,
  onSaved,
  refuse,
}: {
  client: AdminTokensClient;
  policy: TokenPolicy;
  limits: PolicyLimits;
  onSaved: (saved: { policy: TokenPolicy; limits: PolicyLimits }) => void;
  refuse: (error: unknown) => boolean;
}) {
  const t = useT();
  const id = useId();
  const [maxDays, setMaxDays] = useState(String(policy.maxLifetimeDays));
  const [reminder, setReminder] = useState(String(policy.reminderDays));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = (key: string) => `${id}-${key}`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      onSaved(
        await client.savePolicy({
          maxLifetimeDays: Number(maxDays),
          reminderDays: Number(reminder),
        }),
      );
      setSaved(true);
    } catch (e) {
      if (!refuse(e)) setError(t('admin.tokens.policyFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={field('title')} className="glass-card account-section">
      <h2 id={field('title')} className="facts-title">
        {t('admin.tokens.policy')}
      </h2>
      <form className="form" onSubmit={submit}>
        <div className="form-field">
          <label htmlFor={field('max')}>{t('admin.tokens.maxLifetime')}</label>
          <input
            id={field('max')}
            type="number"
            inputMode="numeric"
            required
            min={limits.maxLifetimeDays.min}
            max={limits.maxLifetimeDays.max}
            value={maxDays}
            aria-describedby={field('max-hint')}
            onChange={(e) => {
              setMaxDays(e.target.value);
              setSaved(false);
            }}
          />
          <p id={field('max-hint')} className="form-hint">
            {t('admin.tokens.maxLifetimeHint', {
              min: limits.maxLifetimeDays.min,
              max: limits.maxLifetimeDays.max,
            })}
          </p>
        </div>
        <div className="form-field">
          <label htmlFor={field('reminder')}>{t('admin.tokens.reminderDays')}</label>
          <input
            id={field('reminder')}
            type="number"
            inputMode="numeric"
            required
            min={limits.reminderDays.min}
            max={limits.reminderDays.max}
            value={reminder}
            aria-describedby={field('reminder-hint')}
            onChange={(e) => {
              setReminder(e.target.value);
              setSaved(false);
            }}
          />
          <p id={field('reminder-hint')} className="form-hint">
            {t('admin.tokens.reminderHint')}
          </p>
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div>
          <button type="submit" className="button-primary" disabled={busy}>
            {t('admin.tokens.savePolicy')}
          </button>
        </div>
        <p role="status" className="form-status">
          {saved ? t('admin.tokens.policySaved') : ''}
        </p>
      </form>
    </section>
  );
}
