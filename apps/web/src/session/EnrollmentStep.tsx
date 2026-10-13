import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { RecoveryCodes } from '../twofactor/RecoveryCodes';
import { TotpSetupForm } from '../twofactor/TotpSetupForm';
import type { TotpSetupStart } from '../twofactor/types';
import { tooManyAttemptsMessage } from './errors';
import type { SessionUser } from './SessionProvider';
import { type SecondFactorClient, secondFactorClient } from './secondFactorClient';

export interface EnrollmentStepProps {
  /** The enrolment challenge the correct password opened; it lasts five minutes. */
  challenge: string;
  /** The email the person signed in with, written on the recovery-code file. */
  email: string;
  /** Runs once the recovery codes are saved; the session has started by then. */
  onSignedIn: (user: SessionUser) => void;
  /** The challenge is gone (expired or too many wrong codes): back to the password. */
  onExpired: () => void;
  onBack: () => void;
  /** Stories and tests pass their own endpoints; the step calls the backend otherwise. */
  client?: SecondFactorClient;
}

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; setup: TotpSetupStart }
  | { status: 'codes'; user: SessionUser; codes: string[] };

/**
 * Sign-in when a two-factor policy covers someone who has no second factor yet (M1-084): they
 * set up an authenticator app right here, and the session starts with the first good code.
 * The recovery codes come next, once, and the app opens after the person confirms saving them.
 */
export function EnrollmentStep({
  challenge,
  email,
  onSignedIn,
  onExpired,
  onBack,
  client = secondFactorClient,
}: EnrollmentStepProps) {
  const t = useT();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The latest callback, so a parent that passes a new function each render does not restart
  // the setup (each start makes a new secret).
  const expired = useRef(onExpired);
  useEffect(() => {
    expired.current = onExpired;
  });

  const start = useCallback(
    (isCancelled: () => boolean = () => false) => {
      setState({ status: 'loading' });
      client.startEnrollment(challenge).then(
        (setup) => {
          if (!isCancelled()) setState({ status: 'ready', setup });
        },
        (e: unknown) => {
          if (isCancelled()) return;
          if (e instanceof ApiError && e.code === 'invalid_challenge') expired.current();
          else setState({ status: 'failed' });
        },
      );
    },
    [challenge, client],
  );

  useEffect(() => {
    let cancelled = false;
    start(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [start]);

  // The step replaces the password form; start reading from its heading.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const confirm = async (setupToken: string, code: string) => {
    setBusy(true);
    setError(null);
    try {
      const { user, recoveryCodes } = await client.confirmEnrollment(challenge, setupToken, code);
      setState({ status: 'codes', user, codes: recoveryCodes });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_challenge') {
        onExpired();
        return;
      }
      setError(
        tooManyAttemptsMessage(t, e) ??
          (e instanceof ApiError && e.code === 'invalid_second_factor'
            ? t('twoFactor.wrongCode')
            : t('auth.failed')),
      );
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'codes') {
    return (
      <RecoveryCodes
        codes={state.codes}
        account={email}
        level={2}
        doneLabel={t('twoFactor.recovery.continue')}
        onDone={() => onSignedIn(state.user)}
      />
    );
  }

  return (
    <section className="enrollment" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} ref={heading} tabIndex={-1} className="facts-title">
        {t('auth.enroll.title')}
      </h2>
      <p className="page-note">{t('auth.enroll.intro')}</p>
      {state.status === 'loading' && (
        <p role="status" className="page-note">
          {t('auth.enroll.loading')}
        </p>
      )}
      {state.status === 'failed' && (
        <>
          <p role="alert" className="form-error">
            {t('auth.enroll.failed')}
          </p>
          <div className="form-actions">
            <button type="button" className="button-primary" onClick={() => start()}>
              {t('auth.enroll.retry')}
            </button>
            <button type="button" className="button-secondary" onClick={onBack}>
              {t('auth.secondFactor.back')}
            </button>
          </div>
        </>
      )}
      {state.status === 'ready' && (
        <TotpSetupForm
          setup={state.setup}
          submitLabel={t('auth.enroll.submit')}
          busy={busy}
          error={error}
          onSubmit={(code) => void confirm(state.setup.setupToken, code)}
          onCancel={onBack}
        />
      )}
    </section>
  );
}
