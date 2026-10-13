import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { CodeField } from '../twofactor/CodeField';
import { securityKeyMessage } from '../twofactor/webauthn';
import { tooManyAttemptsMessage } from './errors';
import type { SecondFactorMethod, SessionUser } from './SessionProvider';
import { type SecondFactorClient, secondFactorClient } from './secondFactorClient';

export interface SecondFactorStepProps {
  /** The challenge the correct password opened; it lasts five minutes and five tries. */
  challenge: string;
  /** The factors this person has: an app, security keys, unused recovery codes. */
  methods: SecondFactorMethod[];
  /** Runs with the user once the backend has started the session. */
  onSignedIn: (user: SessionUser) => void;
  /** The challenge is gone (expired or too many wrong codes): back to the password. */
  onExpired: () => void;
  onBack: () => void;
  /** Stories and tests pass their own endpoints; the step calls the backend otherwise. */
  client?: SecondFactorClient;
}

type Mode = 'totp' | 'recovery_code' | 'webauthn';

/**
 * The second step of sign-in (M1-084, IAM-001): a code from the authenticator app, a security
 * key, or a single-use recovery code. The code field suits phones (numeric keyboard) and the
 * one-time-code autofill of browsers and password managers.
 */
export function SecondFactorStep({
  challenge,
  methods,
  onSignedIn,
  onExpired,
  onBack,
  client = secondFactorClient,
}: SecondFactorStepProps) {
  const t = useT();
  const id = useId();
  const hasApp = methods.includes('totp');
  const hasKey = methods.includes('webauthn');
  const hasRecovery = methods.includes('recovery_code');
  const [mode, setMode] = useState<Mode>(hasApp ? 'totp' : hasKey ? 'webauthn' : 'recovery_code');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const keyButton = useRef<HTMLButtonElement>(null);
  const errorId = `${id}-error`;
  const titleId = `${id}-title`;

  // The step replaces the password form: the cursor goes where the next answer goes.
  useEffect(() => {
    if (mode === 'webauthn') keyButton.current?.focus();
    else field.current?.focus();
  }, [mode]);

  const fail = (e: unknown, method: SecondFactorMethod) => {
    if (e instanceof ApiError && e.code === 'invalid_challenge') {
      onExpired();
      return;
    }
    const keyProblem = securityKeyMessage(t, e);
    let message: string;
    if (keyProblem) message = keyProblem;
    else if (e instanceof ApiError && e.code === 'invalid_second_factor') {
      message =
        method === 'totp'
          ? t('twoFactor.wrongCode')
          : method === 'recovery_code'
            ? t('auth.secondFactor.wrongRecoveryCode')
            : t('auth.secondFactor.keyRejected');
    } else if (e instanceof ApiError && e.code === 'no_security_key') {
      message = t('auth.secondFactor.noSecurityKey');
    } else message = tooManyAttemptsMessage(t, e) ?? t('auth.failed');
    setError(message);
    if (method !== 'webauthn') {
      setCode('');
      field.current?.focus();
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'webauthn') return;
    const method = mode;
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await client.verify(challenge, { method, code: code.trim() }));
    } catch (e) {
      fail(e, method);
    } finally {
      setBusy(false);
    }
  };

  const signInWithKey = async () => {
    setBusy(true);
    setError(null);
    setWaiting(true);
    try {
      const response = await client.answerWithSecurityKey(challenge);
      setWaiting(false);
      onSignedIn(await client.verify(challenge, { method: 'webauthn', response }));
    } catch (e) {
      fail(e, 'webauthn');
    } finally {
      setBusy(false);
      setWaiting(false);
    }
  };

  const switchTo = (next: Mode) => {
    setError(null);
    setCode('');
    setMode(next);
  };

  const intro =
    mode === 'totp'
      ? t('auth.secondFactor.introTotp')
      : mode === 'recovery_code'
        ? t('auth.secondFactor.introRecovery')
        : t('auth.secondFactor.introKey');

  return (
    <form className="form second-factor" onSubmit={submit} aria-labelledby={titleId}>
      <h2 id={titleId} className="facts-title">
        {t('auth.secondFactor.title')}
      </h2>
      <p className="page-note">{intro}</p>
      {mode !== 'webauthn' && (
        <CodeField
          // A new field per mode, so the app code never lands in the recovery field.
          key={mode}
          kind={mode === 'totp' ? 'one-time' : 'recovery'}
          label={t(mode === 'totp' ? 'auth.secondFactor.code' : 'auth.secondFactor.recoveryCode')}
          hint={mode === 'recovery_code' ? t('auth.secondFactor.recoveryCodeHint') : undefined}
          value={code}
          onChange={setCode}
          inputRef={field}
          invalid={error !== null}
          describedBy={error ? errorId : undefined}
        />
      )}
      {error && (
        <p id={errorId} className="form-error" role="alert">
          {error}
        </p>
      )}
      {mode !== 'webauthn' && (
        <button type="submit" className="button-primary" disabled={busy}>
          {t('auth.secondFactor.verify')}
        </button>
      )}
      <div className="form-actions">
        {hasKey && (
          <button
            ref={keyButton}
            type="button"
            className={mode === 'webauthn' ? 'button-primary' : 'button-secondary'}
            disabled={busy}
            onClick={() => void signInWithKey()}
          >
            {t('auth.secondFactor.useSecurityKey')}
          </button>
        )}
        {mode === 'recovery_code' && hasApp && (
          <button type="button" className="button-secondary" onClick={() => switchTo('totp')}>
            {t('auth.secondFactor.useApp')}
          </button>
        )}
        {mode !== 'recovery_code' && hasRecovery && (
          <button
            type="button"
            className="button-secondary"
            onClick={() => switchTo('recovery_code')}
          >
            {t('auth.secondFactor.useRecoveryCode')}
          </button>
        )}
        <button type="button" className="button-secondary" onClick={onBack}>
          {t('auth.secondFactor.back')}
        </button>
      </div>
      <p role="status" className="form-status">
        {waiting ? t('twoFactor.keyWaiting') : ''}
      </p>
    </form>
  );
}
