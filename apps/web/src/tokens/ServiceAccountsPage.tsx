import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import {
  type ApiToken,
  type NewToken,
  type ServiceAccount,
  type ServiceAccountsClient,
  serviceAccountsClient,
  type TokenPolicy,
} from './client';
import { useTokenText } from './format';
import { TokenForm } from './TokenForm';
import { TokenItem } from './TokenItem';
import { TokenSecret } from './TokenSecret';

export interface ServiceAccountsPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: ServiceAccountsClient;
}

/** How long a rotated token keeps working next to its successor. */
export const OVERLAP_CHOICES = [0, 1, 24, 72, 168] as const;

type State =
  | { status: 'loading' }
  | { status: 'loaded'; accounts: ServiceAccount[]; policy: TokenPolicy }
  | { status: 'failed' }
  | { status: 'forbidden' };

/**
 * Service accounts (IAM-007): accounts for programs that never sign in and are not counted as
 * users. Administrators create them, give them named, expiring tokens, rotate a token with an
 * overlap window so the program switches without downtime, and deactivate them.
 */
export function ServiceAccountsPage({ client = serviceAccountsClient }: ServiceAccountsPageProps) {
  const t = useT();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const timeZone = session.status === 'signed-in' ? session.user.timeZone : null;
  const [state, setState] = useState<State>(
    notAdmin ? { status: 'forbidden' } : { status: 'loading' },
  );
  const [open, setOpen] = useState<number | null>(null);

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
      const [accounts, policy] = await Promise.all([client.list(), client.policy()]);
      setState({ status: 'loaded', accounts, policy });
    } catch (error) {
      if (!refuse(error)) setState({ status: 'failed' });
    }
  }, [client, refuse]);

  useEffect(() => {
    if (!notAdmin) void load();
  }, [notAdmin, load]);

  return (
    <section aria-labelledby={titleId} className="tokens-page">
      <h1 id={titleId} className="page-title">
        {t('admin.serviceAccounts.title')}
      </h1>
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.serviceAccounts.forbidden')}</p>
      ) : (
        <>
          <p className="page-note">{t('admin.serviceAccounts.intro')}</p>
          <div className="tokens-page-sections">
            <CreateSection
              client={client}
              refuse={refuse}
              onCreated={async (account) => {
                await load();
                setOpen(account.id);
              }}
            />
            <section aria-labelledby={`${titleId}-list`} className="account-section">
              <h2 id={`${titleId}-list`} className="facts-title">
                {t('admin.serviceAccounts.list')}
              </h2>
              {state.status === 'loading' && (
                <p className="page-note">{t('admin.serviceAccounts.loading')}</p>
              )}
              {state.status === 'failed' && (
                <p role="alert" className="form-error">
                  {t('admin.serviceAccounts.failed')}
                </p>
              )}
              {state.status === 'loaded' &&
                (state.accounts.length === 0 ? (
                  <p className="page-note">{t('admin.serviceAccounts.none')}</p>
                ) : (
                  <ul className="service-account-list">
                    {state.accounts.map((account) => (
                      <AccountItem
                        key={account.id}
                        account={account}
                        policy={state.policy}
                        timeZone={timeZone}
                        open={open === account.id}
                        onToggle={() => setOpen(open === account.id ? null : account.id)}
                        client={client}
                        refuse={refuse}
                        onChanged={load}
                      />
                    ))}
                  </ul>
                ))}
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function CreateSection({
  client,
  refuse,
  onCreated,
}: {
  client: ServiceAccountsClient;
  refuse: (error: unknown) => boolean;
  onCreated: (account: ServiceAccount) => Promise<void>;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setDone('');
    setError(null);
    try {
      const account = await client.create({ name: name.trim(), description: description.trim() });
      setName('');
      setDescription('');
      setDone(t('admin.serviceAccounts.created', { name: account.name }));
      await onCreated(account);
    } catch (e) {
      if (!refuse(e)) setError(t('admin.serviceAccounts.createFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className="account-section">
      <h2 id={`${id}-title`} className="facts-title">
        {t('admin.serviceAccounts.new')}
      </h2>
      <form className="form" onSubmit={submit}>
        <div className="form-field">
          <label htmlFor={`${id}-name`}>{t('admin.serviceAccounts.name')}</label>
          <input
            id={`${id}-name`}
            required
            maxLength={200}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-description`}>{t('admin.serviceAccounts.description')}</label>
          <input
            id={`${id}-description`}
            maxLength={2000}
            autoComplete="off"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div>
          <button type="submit" className="button-primary" disabled={busy}>
            {t('admin.serviceAccounts.create')}
          </button>
        </div>
        <p role="status" className="form-status">
          {done}
        </p>
      </form>
    </section>
  );
}

function AccountItem({
  account,
  policy,
  timeZone,
  open,
  onToggle,
  client,
  refuse,
  onChanged,
}: {
  account: ServiceAccount;
  policy: TokenPolicy;
  timeZone: string | null;
  open: boolean;
  onToggle: () => void;
  client: ServiceAccountsClient;
  refuse: (error: unknown) => boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const text = useTokenText(timeZone);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setActive = async (active: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await client.setActive(account.id, active);
      await onChanged();
    } catch (e) {
      if (!refuse(e)) setError(t('admin.serviceAccounts.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="service-account-item">
      <div className="service-account-head">
        <div className="token-main">
          <p className="token-name">
            <span>{text.value(account.name)}</span>
            {!account.active && (
              <span className="token-badge token-badge-revoked">
                {t('admin.serviceAccounts.deactivated')}
              </span>
            )}
          </p>
          <p className="token-meta">
            <span>{t('admin.serviceAccounts.address', { email: account.email })}</span>
            <span>{t('admin.serviceAccounts.activeTokens', { count: account.activeTokens })}</span>
          </p>
          {account.description && <p className="token-meta">{text.value(account.description)}</p>}
        </div>
        <div className="token-actions">
          <button
            type="button"
            className="button-secondary"
            aria-expanded={open}
            aria-controls={`${id}-tokens`}
            aria-label={t(
              open ? 'admin.serviceAccounts.hideNamed' : 'admin.serviceAccounts.manageNamed',
              { name: account.name },
            )}
            onClick={onToggle}
          >
            {t(open ? 'admin.serviceAccounts.hide' : 'admin.serviceAccounts.manage')}
          </button>
          <button
            type="button"
            className="button-secondary"
            aria-label={t(
              account.active
                ? 'admin.serviceAccounts.deactivateNamed'
                : 'admin.serviceAccounts.reactivateNamed',
              { name: account.name },
            )}
            disabled={busy}
            onClick={() => void setActive(!account.active)}
          >
            {t(
              account.active
                ? 'admin.serviceAccounts.deactivate'
                : 'admin.serviceAccounts.reactivate',
            )}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {open && (
        <div id={`${id}-tokens`}>
          <AccountTokens
            account={account}
            policy={policy}
            timeZone={timeZone}
            client={client}
            refuse={refuse}
            onChanged={onChanged}
          />
        </div>
      )}
    </li>
  );
}

function AccountTokens({
  account,
  policy,
  timeZone,
  client,
  refuse,
  onChanged,
}: {
  account: ServiceAccount;
  policy: TokenPolicy;
  timeZone: string | null;
  client: ServiceAccountsClient;
  refuse: (error: unknown) => boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [tokens, setTokens] = useState<ApiToken[] | 'failed' | null>(null);
  const [overlap, setOverlap] = useState(24);
  const [secret, setSecret] = useState<{ token: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTokens(await client.tokens(account.id));
    } catch (e) {
      if (!refuse(e)) setTokens('failed');
    }
  }, [client, account.id, refuse]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: () => Promise<string>) => {
    setBusy(true);
    setDone('');
    setError(null);
    try {
      const message = await action();
      heading.current?.focus();
      setDone(message);
    } catch (e) {
      if (!refuse(e)) setError(t('admin.serviceAccounts.actionFailed'));
    } finally {
      setBusy(false);
    }
    await Promise.all([load(), onChanged()]);
  };

  const rotate = (token: ApiToken) =>
    act(async () => {
      const rotated = await client.rotate(account.id, token.id, overlap);
      setSecret({ token: rotated.token, name: rotated.apiToken.name });
      return t('admin.serviceAccounts.rotated', { name: token.name });
    });

  const revoke = (token: ApiToken) =>
    act(async () => {
      await client.revoke(token.id);
      return t('tokens.revoked', { name: token.name });
    });

  const issue = async (token: NewToken) => {
    const created = await client.issue(account.id, token);
    setDone('');
    setSecret({ token: created.token, name: created.apiToken.name });
    await Promise.all([load(), onChanged()]);
  };

  return (
    <section aria-labelledby={`${id}-title`} className="service-account-tokens">
      <h3 id={`${id}-title`} ref={heading} tabIndex={-1} className="token-form-title">
        {t('admin.serviceAccounts.tokensOf', { name: account.name })}
      </h3>
      {secret && (
        <TokenSecret token={secret.token} name={secret.name} onDone={() => setSecret(null)} />
      )}
      {tokens === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.serviceAccounts.tokensFailed')}
        </p>
      )}
      {Array.isArray(tokens) && tokens.length === 0 && (
        <p className="page-note">{t('admin.serviceAccounts.noTokens')}</p>
      )}
      {Array.isArray(tokens) && tokens.length > 0 && (
        <>
          <div className="form-field tokens-filter">
            <label htmlFor={`${id}-overlap`}>{t('admin.serviceAccounts.overlap')}</label>
            <select
              id={`${id}-overlap`}
              value={overlap}
              aria-describedby={`${id}-overlap-hint`}
              onChange={(e) => setOverlap(Number(e.target.value))}
            >
              {OVERLAP_CHOICES.map((hours) => (
                <option key={hours} value={hours}>
                  {t('admin.serviceAccounts.overlapOption', { hours })}
                </option>
              ))}
            </select>
            <p id={`${id}-overlap-hint`} className="form-hint">
              {t('admin.serviceAccounts.overlapHint')}
            </p>
          </div>
          <ul
            className="token-list"
            aria-label={t('admin.serviceAccounts.tokensOf', { name: account.name })}
          >
            {tokens.map((token) => (
              <TokenItem
                key={token.id}
                token={token}
                reminderDays={policy.reminderDays}
                timeZone={timeZone}
                actions={
                  token.status === 'active' ? (
                    <>
                      {token.replacedBy === null && account.active && (
                        <button
                          type="button"
                          className="button-secondary"
                          aria-label={t('admin.serviceAccounts.rotateNamed', { name: token.name })}
                          disabled={busy}
                          onClick={() => void rotate(token)}
                        >
                          {t('admin.serviceAccounts.rotate')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="button-secondary"
                        aria-label={t('tokens.revokeNamed', { name: token.name })}
                        disabled={busy}
                        onClick={() => void revoke(token)}
                      >
                        {t('tokens.revoke')}
                      </button>
                    </>
                  ) : undefined
                }
              />
            ))}
          </ul>
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
      {account.active && (
        <>
          <h4 className="token-form-title">{t('tokens.newTitle')}</h4>
          <TokenForm policy={policy} allowAdmin allowScim timeZone={timeZone} onCreate={issue} />
        </>
      )}
    </section>
  );
}
