import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { EmptyState } from '../shell/EmptyState';
import { RecoveryCodes } from '../twofactor/RecoveryCodes';
import { TotpSetupForm } from '../twofactor/TotpSetupForm';
import type { TotpSetupStart } from '../twofactor/types';
import { securityKeyMessage } from '../twofactor/webauthn';
import { ConfirmPasswordForm } from './ConfirmPasswordForm';
import type { AccountClient, SecurityKey, TwoFactorStatus } from './client';

export interface TwoFactorSectionProps {
  client: AccountClient;
  /** The account's email: for password managers and on the recovery-code file. */
  email: string;
  /** The person's time zone for dates; null follows the device. */
  timeZone: string | null;
}

type State =
  | { status: 'loading' }
  | { status: 'loaded'; factors: TwoFactorStatus }
  | { status: 'failed' };

/** What the section shows besides the overview; one change at a time. */
type Panel =
  | { kind: 'none' }
  | { kind: 'app-setup'; setup: TotpSetupStart }
  | { kind: 'app-off' }
  | { kind: 'add-key' }
  | { kind: 'remove-key'; key: SecurityKey }
  | { kind: 'regenerate' }
  | { kind: 'codes'; codes: string[] };

/**
 * The person's second factors (M1-084, IAM-001): an authenticator app, security keys and
 * passkeys, and recovery codes. Switching a factor off, removing a key and new recovery codes
 * ask for the password again. When a two-factor policy covers the person, the last factor
 * cannot be removed and the section says why.
 */
export function TwoFactorSection({ client, email, timeZone }: TwoFactorSectionProps) {
  const t = useT();
  const intl = useIntl();
  const expired = useSessionExpiry();
  const titleId = useId();
  const requiredId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [panel, setPanel] = useState<Panel>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState('');

  const load = useCallback(async () => {
    try {
      setState({ status: 'loaded', factors: await client.twoFactorStatus() });
    } catch (e) {
      if (!expired(e)) setState({ status: 'failed' });
    }
  }, [client, expired]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (next: Panel) => {
    setError(null);
    setFormError(null);
    setDone('');
    setPanel(next);
  };

  /** Back to the overview; the control that had focus is gone, so the heading takes it. */
  const close = (message = '') => {
    setPanel({ kind: 'none' });
    setFormError(null);
    setDone(message);
    heading.current?.focus();
  };

  /** A change went through: show the codes it produced, or the overview, and re-read. */
  const finish = async (message: string, codes: string[] | null = null) => {
    if (codes) {
      setPanel({ kind: 'codes', codes });
      setFormError(null);
      setDone(message);
    } else close(message);
    await load();
  };

  const startApp = async () => {
    open({ kind: 'none' });
    setBusy(true);
    try {
      open({ kind: 'app-setup', setup: await client.startTotpSetup() });
    } catch (e) {
      if (!expired(e)) setError(t('account.twoFactor.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const confirmApp = async (setupToken: string, code: string) => {
    setBusy(true);
    setFormError(null);
    try {
      const codes = await client.confirmTotpSetup(setupToken, code);
      await finish(t('account.twoFactor.appEnabled'), codes);
    } catch (e) {
      if (expired(e)) return;
      const problem = e instanceof ApiError ? e.code : undefined;
      if (problem === 'setup_expired') {
        close();
        setError(t('twoFactor.setupExpired'));
      } else {
        setFormError(
          problem === 'invalid_code'
            ? t('twoFactor.wrongCode')
            : t('account.twoFactor.actionFailed'),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const addKey = async (name: string) => {
    setBusy(true);
    setWaiting(true);
    setFormError(null);
    try {
      const { key, recoveryCodes } = await client.addSecurityKey(name);
      setWaiting(false);
      await finish(t('account.twoFactor.keyRegistered', { name: key.name }), recoveryCodes);
    } catch (e) {
      if (expired(e)) return;
      const problem = e instanceof ApiError ? e.code : undefined;
      setFormError(
        securityKeyMessage(t, e) ??
          (problem === 'invalid_registration'
            ? t('account.twoFactor.keyInvalid')
            : problem === 'setup_expired'
              ? t('twoFactor.setupExpired')
              : t('account.twoFactor.actionFailed')),
      );
    } finally {
      setBusy(false);
      setWaiting(false);
    }
  };

  const when = (iso: string) =>
    intl.formatDate(iso, { dateStyle: 'medium', ...(timeZone ? { timeZone } : {}) });

  const overview = (factors: TwoFactorStatus) => {
    const count = Number(factors.totp) + factors.securityKeys.length;
    const on = count > 0;
    // A policy covers this person and only one factor is left: it stays.
    const locked = factors.required && count <= 1;
    const lockedProps = locked ? { 'aria-describedby': requiredId } : {};
    return (
      <>
        <p className={on ? 'two-factor-state two-factor-on' : 'two-factor-state'}>
          {t(on ? 'account.twoFactor.statusOn' : 'account.twoFactor.statusOff')}
        </p>
        {factors.required && (
          <p id={requiredId} className="page-note">
            {t('account.twoFactor.required')}
          </p>
        )}

        <div className="two-factor-group">
          <h3 className="two-factor-heading">{t('account.twoFactor.app')}</h3>
          <p className="page-note">
            {t(factors.totp ? 'account.twoFactor.appOn' : 'account.twoFactor.appOff')}
          </p>
          {panel.kind === 'app-setup' ? (
            <TotpSetupForm
              setup={panel.setup}
              submitLabel={t('account.twoFactor.turnOnApp')}
              busy={busy}
              error={formError}
              focusCode
              onSubmit={(code) => void confirmApp(panel.setup.setupToken, code)}
              onCancel={() => close()}
            />
          ) : panel.kind === 'app-off' ? (
            <ConfirmPasswordForm
              email={email}
              label={t('account.twoFactor.switchOffApp')}
              submitLabel={t('account.twoFactor.switchOffApp')}
              onConfirm={async (password) => {
                await client.disableTotp(password);
                await finish(t('account.twoFactor.appDisabled'));
              }}
              onCancel={() => close()}
            />
          ) : (
            <div className="form-actions">
              {factors.totp ? (
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy || locked}
                  onClick={() => open({ kind: 'app-off' })}
                  {...lockedProps}
                >
                  {t('account.twoFactor.switchOffApp')}
                </button>
              ) : (
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy}
                  onClick={() => void startApp()}
                >
                  {t('account.twoFactor.setUpApp')}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="two-factor-group">
          <h3 className="two-factor-heading">{t('account.twoFactor.keys')}</h3>
          <p className="page-note">{t('account.twoFactor.keysIntro')}</p>
          {factors.securityKeys.length === 0 ? (
            <EmptyState compact title={t('account.twoFactor.noKeys')} />
          ) : (
            <ul className="session-list">
              {factors.securityKeys.map((key) => {
                const removing = panel.kind === 'remove-key' && panel.key.id === key.id;
                return (
                  <li key={key.id} className="session-item">
                    <div className="session-main">
                      <p className="session-device">{t('common.value', { value: key.name })}</p>
                      <p className="session-meta">
                        <span>
                          {t('account.twoFactor.keyAdded', { when: when(key.createdAt) })}
                        </span>
                        <span>
                          {key.lastUsedAt
                            ? t('account.twoFactor.keyLastUsed', { when: when(key.lastUsedAt) })
                            : t('account.twoFactor.keyNeverUsed')}
                        </span>
                      </p>
                    </div>
                    {removing ? (
                      <div className="two-factor-inline-form">
                        <ConfirmPasswordForm
                          email={email}
                          label={t('account.twoFactor.removeKeyNamed', { name: key.name })}
                          submitLabel={t('account.twoFactor.removeKey')}
                          onConfirm={async (password) => {
                            await client.removeSecurityKey(key.id, password);
                            await finish(t('account.twoFactor.keyRemoved', { name: key.name }));
                          }}
                          onCancel={() => close()}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="button-secondary"
                        aria-label={t('account.twoFactor.removeKeyNamed', { name: key.name })}
                        disabled={busy || locked}
                        onClick={() => open({ kind: 'remove-key', key })}
                        {...lockedProps}
                      >
                        {t('account.twoFactor.removeKey')}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {panel.kind === 'add-key' ? (
            <AddKeyForm
              busy={busy}
              waiting={waiting}
              error={formError}
              onAdd={(name) => void addKey(name)}
              onCancel={() => close()}
            />
          ) : (
            <div className="form-actions">
              <button
                type="button"
                className="button-secondary"
                disabled={busy}
                onClick={() => open({ kind: 'add-key' })}
              >
                {t('account.twoFactor.addKey')}
              </button>
            </div>
          )}
        </div>

        {on && (
          <div className="two-factor-group">
            <h3 className="two-factor-heading">{t('account.twoFactor.recovery')}</h3>
            <p className="page-note">
              {t('account.twoFactor.recoveryRemaining', { count: factors.recoveryRemaining })}
            </p>
            <p className="page-note">{t('account.twoFactor.recoveryHint')}</p>
            {panel.kind === 'regenerate' ? (
              <ConfirmPasswordForm
                email={email}
                label={t('account.twoFactor.regenerate')}
                submitLabel={t('account.twoFactor.regenerate')}
                onConfirm={async (password) => {
                  const codes = await client.regenerateRecoveryCodes(password);
                  await finish('', codes);
                }}
                onCancel={() => close()}
              />
            ) : (
              <div className="form-actions">
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy}
                  onClick={() => open({ kind: 'regenerate' })}
                >
                  {t('account.twoFactor.regenerate')}
                </button>
              </div>
            )}
          </div>
        )}
      </>
    );
  };

  return (
    <section aria-labelledby={titleId} className="glass-card account-section two-factor">
      <h2 id={titleId} ref={heading} tabIndex={-1} className="facts-title">
        {t('account.twoFactor')}
      </h2>
      <p className="page-note">{t('account.twoFactor.intro')}</p>
      {state.status === 'loading' && <p className="page-note">{t('account.twoFactor.loading')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('account.twoFactor.failed')}
        </p>
      )}
      {state.status === 'loaded' &&
        (panel.kind === 'codes' ? (
          <RecoveryCodes
            codes={panel.codes}
            account={email}
            level={3}
            doneLabel={t('twoFactor.recovery.done')}
            onDone={() => close()}
          />
        ) : (
          overview(state.factors)
        ))}
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

interface AddKeyFormProps {
  busy: boolean;
  /** The browser is waiting for the key; says so while it does. */
  waiting: boolean;
  error: string | null;
  onAdd: (name: string) => void;
  onCancel: () => void;
}

/** A name for the new key, then the browser's own security-key prompt. */
function AddKeyForm({ busy, waiting, error, onAdd, onCancel }: AddKeyFormProps) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(() => t('account.twoFactor.keyNameDefault'));
  const input = useRef<HTMLInputElement>(null);
  const errorId = `${id}-error`;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onAdd(name.trim());
  };

  return (
    <form className="form" onSubmit={submit} aria-label={t('account.twoFactor.addKey')}>
      <div className="form-field">
        <label htmlFor={`${id}-name`}>{t('account.twoFactor.keyName')}</label>
        <input
          ref={input}
          id={`${id}-name`}
          required
          maxLength={100}
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-describedby={[`${id}-hint`, error ? errorId : ''].filter(Boolean).join(' ')}
        />
        <p id={`${id}-hint`} className="form-hint">
          {t('account.twoFactor.keyNameHint')}
        </p>
      </div>
      {error && (
        <p id={errorId} className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {t('account.twoFactor.registerKey')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('twoFactor.cancel')}
        </button>
      </div>
      <p role="status" className="form-status">
        {waiting ? t('twoFactor.keyWaiting') : ''}
      </p>
    </form>
  );
}
