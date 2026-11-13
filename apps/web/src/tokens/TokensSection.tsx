import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { EmptyState } from '../shell/EmptyState';
import type { ApiToken, NewToken, PersonalTokensClient, TokenPolicy } from './client';
import { TokenForm } from './TokenForm';
import { TokenItem } from './TokenItem';
import { TokenSecret } from './TokenSecret';

export interface TokensSectionProps {
  client: PersonalTokensClient;
  /**
   * Offer the administration scope: the person administers something. The server's answer
   * (`adminScopeAllowed`) wins once the list is loaded.
   */
  allowAdmin: boolean;
  /** The person's time zone for dates; null follows the device. */
  timeZone: string | null;
}

type State =
  | { status: 'loading' }
  | { status: 'loaded'; tokens: ApiToken[]; policy: TokenPolicy; adminAllowed: boolean }
  | { status: 'failed' };

/**
 * The signed-in person's API tokens on the Account page (IAM-007): create one with a name,
 * scopes and an expiry, copy it once, see when each was last used, and revoke it.
 */
export function TokensSection({ client, allowAdmin, timeZone }: TokensSectionProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [secret, setSecret] = useState<{ token: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { tokens, policy, adminScopeAllowed } = await client.list();
      setState({
        status: 'loaded',
        tokens,
        policy,
        adminAllowed: adminScopeAllowed ?? allowAdmin,
      });
    } catch (e) {
      if (!expired(e)) setState({ status: 'failed' });
    }
  }, [client, expired, allowAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (token: NewToken) => {
    const created = await client.create(token);
    setDone('');
    setError(null);
    setSecret({ token: created.token, name: created.apiToken.name });
    await load();
  };

  const revoke = async (token: ApiToken) => {
    setBusy(true);
    setDone('');
    setError(null);
    try {
      try {
        await client.revoke(token.id);
      } catch (e) {
        // Already gone: the outcome is the same.
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      // The pressed button is about to disappear; keep focus in the section.
      heading.current?.focus();
      setDone(t('tokens.revoked', { name: token.name }));
    } catch (e) {
      if (expired(e)) return;
      setError(t('tokens.revokeFailed'));
    } finally {
      setBusy(false);
    }
    await load();
  };

  return (
    <section aria-labelledby={`${id}-title`} className="glass-card account-section">
      <h2 id={`${id}-title`} ref={heading} tabIndex={-1} className="facts-title">
        {t('tokens.title')}
      </h2>
      <p className="page-note">{t('tokens.intro')}</p>
      {state.status === 'loading' && <p className="page-note">{t('tokens.loading')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('tokens.failed')}
        </p>
      )}
      {state.status === 'loaded' && (
        <>
          {secret && (
            <TokenSecret
              token={secret.token}
              name={secret.name}
              onDone={() => {
                setSecret(null);
                heading.current?.focus();
              }}
            />
          )}
          {state.tokens.length === 0 ? (
            // The intro above already says what a token is for (AC-20).
            <EmptyState compact title={t('tokens.none')} />
          ) : (
            <ul className="token-list" aria-label={t('tokens.listLabel')}>
              {state.tokens.map((token) => (
                <TokenItem
                  key={token.id}
                  token={token}
                  reminderDays={state.policy.reminderDays}
                  timeZone={timeZone}
                  actions={
                    token.status === 'active' ? (
                      <button
                        type="button"
                        className="button-secondary"
                        aria-label={t('tokens.revokeNamed', { name: token.name })}
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
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <p role="status" className="form-status">
            {done}
          </p>
          <h3 className="token-form-title">{t('tokens.newTitle')}</h3>
          <TokenForm
            policy={state.policy}
            allowAdmin={state.adminAllowed}
            timeZone={timeZone}
            onCreate={create}
          />
        </>
      )}
    </section>
  );
}
