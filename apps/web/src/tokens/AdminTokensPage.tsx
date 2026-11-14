import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
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
  type TokenInventory,
  type TokenPolicy,
} from './client';
import { TokenItem } from './TokenItem';

export interface AdminTokensPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: AdminTokensClient;
}

const FILTERS: readonly TokenFilter[] = ['all', 'active', 'expiring', 'expired', 'revoked'];

/** The tokens shown, the filter they answer, and how far the server's list has been read. */
interface Listed {
  filter: TokenFilter;
  tokens: ApiToken[];
  total: number;
  owners: OwnerSummary[];
  /** Rows read from the server so far: where the next page starts. */
  read: number;
  /** An empty page arrived before `total` was reached (tokens left the list meanwhile). */
  end: boolean;
  /** Show more is reading the next page. */
  more: boolean;
}

type Inventory = { status: 'loading' } | ({ status: 'loaded' } & Listed) | { status: 'failed' };

/** The list with the next page after it; a token already shown is not shown twice. */
function withPage<L extends Listed>(listed: L, page: TokenInventory): L {
  const known = new Set(listed.tokens.map((token) => token.id));
  return {
    ...listed,
    tokens: [...listed.tokens, ...page.tokens.filter((token) => !known.has(token.id))],
    total: page.total,
    owners: page.owners,
    read: listed.read + page.tokens.length,
    end: page.tokens.length === 0,
  };
}

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
  // Each reading of the list from its start takes the next number; a page that arrives after a
  // newer reading began (another filter, a revocation) is dropped (T-308).
  const reading = useRef(0);

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

  /**
   * Reads the list from its start: one page for a new filter, or as many as were shown (`keep`)
   * after a revocation, so Show more's pages stay open; the owners are read again with it.
   */
  const load = useCallback(
    async (keep = 0) => {
      const mine = ++reading.current;
      try {
        let listed: Listed = {
          filter,
          tokens: [],
          total: 0,
          owners: [],
          read: 0,
          end: false,
          more: false,
        };
        do {
          const page = await client.list(filter, listed.read);
          if (mine !== reading.current) return;
          listed = withPage(listed, page);
        } while (listed.read < Math.min(keep, listed.total) && !listed.end);
        setInventory({ status: 'loaded', ...listed });
      } catch (error) {
        if (mine !== reading.current) return;
        if (!refuse(error)) setInventory({ status: 'failed' });
      }
    },
    [client, filter, refuse],
  );
  const shown = inventory.status === 'loaded' ? inventory.read : 0;
  const reload = () => load(shown);

  useEffect(() => {
    if (forbidden) return;
    void load();
  }, [forbidden, load]);

  /**
   * Show more: the next page of the same filter, after the tokens already shown (T-308).
   * Resolves to false when the page could not be read, for the list to say so.
   */
  const more = async (): Promise<boolean> => {
    if (inventory.status !== 'loaded' || inventory.more) return true;
    const mine = reading.current;
    const from = inventory;
    setInventory({ ...from, more: true });
    try {
      const page = await client.list(from.filter, from.read);
      if (mine === reading.current) {
        setInventory((s) => (s.status === 'loaded' ? { ...withPage(s, page), more: false } : s));
      }
      return true;
    } catch (error) {
      if (mine !== reading.current) return true;
      setInventory((s) => (s.status === 'loaded' ? { ...s, more: false } : s));
      return refuse(error);
    }
  };

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
          onChanged={reload}
          onMore={more}
          refuse={refuse}
        />
        {/* Nothing to revoke in bulk while there are no tokens at all (AD-31). */}
        {!(inventory.status === 'loaded' && filter === 'all' && inventory.total === 0) && (
          <BulkSection
            client={client}
            owners={inventory.status === 'loaded' ? inventory.owners : []}
            onRevoked={() => void reload()}
            refuse={refuse}
          />
        )}
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
  onMore,
  refuse,
}: {
  client: AdminTokensClient;
  filter: TokenFilter;
  onFilter: (filter: TokenFilter) => void;
  inventory: Inventory;
  reminderDays: number;
  timeZone: string | null;
  onChanged: () => Promise<void>;
  /** Reads the next page; false when it could not be read. */
  onMore: () => Promise<boolean>;
  refuse: (error: unknown) => boolean;
}) {
  const t = useT();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Revoke asks first (D13); Cancel gives the focus back to the token's Revoke. A revocation takes
  // that button away, so the list's heading keeps the focus.
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
    } catch (e) {
      // Refused: the question stays, to try again or cancel.
      if (!refuse(e)) setError(t('tokens.revokeFailed'));
      throw e;
    } finally {
      setBusy(false);
    }
    heading.current?.focus();
    setDone(t('admin.tokens.revoked', { name: token.name, owner: token.owner.name }));
    await onChanged();
  };

  // No token at all: a filter has nothing to narrow, and a count would repeat the empty state.
  const nothingYet = inventory.status === 'loaded' && filter === 'all' && inventory.total === 0;
  return (
    <section aria-labelledby={`${id}-title`} className="glass-card account-section">
      <h2 id={`${id}-title`} ref={heading} tabIndex={-1} className="facts-title">
        {t('admin.tokens.list')}
      </h2>
      {!nothingYet && (
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
      )}
      {inventory.status === 'loading' && <p className="page-note">{t('admin.tokens.loading')}</p>}
      {inventory.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.tokens.failed')}
        </p>
      )}
      {inventory.status === 'loaded' && (
        <>
          {!nothingYet && (
            <p className="page-note">{t('admin.tokens.count', { count: inventory.total })}</p>
          )}
          {inventory.tokens.length === 0 && filter === 'all' ? (
            // Nothing at all yet: a wider filter would not help (AD-31).
            <EmptyState title={t('admin.tokens.noneYet')}>
              {t('admin.tokens.noneYetBody')}
            </EmptyState>
          ) : inventory.tokens.length === 0 ? (
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
                    token.status !== 'active' ? undefined : (
                      <DangerAction
                        label={t('tokens.revoke')}
                        name={t('admin.tokens.revokeNamed', {
                          name: token.name,
                          owner: token.owner.name,
                        })}
                        outcome={t('admin.tokens.revokeConfirm', {
                          name: token.name,
                          owner: token.owner.name,
                        })}
                        confirmLabel={t('admin.tokens.revokeNamed', {
                          name: token.name,
                          owner: token.owner.name,
                        })}
                        disabled={busy}
                        onConfirm={() => revoke(token)}
                      />
                    )
                  }
                />
              ))}
            </ul>
          )}
          {!inventory.end && inventory.read < inventory.total && (
            <div className="form-actions">
              <button
                type="button"
                className="button-secondary"
                disabled={inventory.more}
                onClick={() => {
                  setError(null);
                  void onMore().then((read) => {
                    if (!read) setError(t('admin.tokens.failed'));
                  });
                }}
              >
                {t('admin.tokens.more')}
              </button>
            </div>
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
  const trigger = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  // Set when the question closes by Cancel, Escape or a revocation: the focus goes back to Revoke.
  const returnFocus = useRef(false);
  const [mode, setMode] = useState<Mode>('owner');
  const [ownerId, setOwnerId] = useState('');
  const [before, setBefore] = useState('');
  const [pending, setPending] = useState<{ criteria: BulkCriteria; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const field = (key: string) => `${id}-${key}`;

  // The question looks and behaves as every destructive action's does (D13, shell/DangerAction):
  // focus on Cancel, the safe choice; Escape and Cancel put Revoke back and focus it.
  useEffect(() => {
    if (pending) {
      cancelButton.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      trigger.current?.focus();
    }
  }, [pending]);

  const close = () => {
    if (busy) return;
    returnFocus.current = true;
    setPending(null);
  };

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
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      const count = await client.bulkRevoke(pending.criteria, false);
      returnFocus.current = true;
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
            <button ref={trigger} type="submit" className="button-danger-quiet" disabled={busy}>
              {t('admin.tokens.bulkRevoke')}
            </button>
          </div>
        )}
      </form>
      {pending && (
        // biome-ignore lint/a11y/useSemanticElements: a question and its two answers, not a set of fields
        <div
          className="danger-confirm"
          role="group"
          aria-labelledby={field('outcome')}
          aria-busy={busy || undefined}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          <p id={field('outcome')} className="danger-confirm-outcome">
            {t('admin.tokens.bulkConfirm', { count: pending.count })}
          </p>
          <div className="danger-confirm-actions">
            {pending.count > 0 && (
              <button
                type="button"
                className="button-danger"
                aria-disabled={busy || undefined}
                onClick={() => void confirm()}
              >
                {t('admin.tokens.confirm')}
              </button>
            )}
            <button
              ref={cancelButton}
              type="button"
              className="button-secondary"
              aria-disabled={busy || undefined}
              onClick={close}
            >
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
