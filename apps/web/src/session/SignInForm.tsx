import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { EnrollmentStep } from './EnrollmentStep';
import { tooManyAttemptsMessage } from './errors';
import { PasswordField } from './PasswordField';
import { SecondFactorStep } from './SecondFactorStep';
import { type SecondFactorMethod, type SessionUser, useSession } from './SessionProvider';

type Step =
  | { kind: 'password' }
  | { kind: 'second-factor'; challenge: string; methods: SecondFactorMethod[] }
  | { kind: 'enroll'; challenge: string };

/**
 * Email and password sign-in (IAM-001); SSO buttons join it in M1. With a second factor the
 * password leads to a second step (M1-084): a code, a security key or a recovery code, or the
 * authenticator-app setup a two-factor policy requires. Going back keeps the email.
 */
export function SignInForm() {
  const t = useT();
  const { signIn, setUser } = useSession();
  const id = useId();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const [returned, setReturned] = useState(0);

  // Back from the second step: the cursor waits in the password field.
  useEffect(() => {
    if (returned > 0) passwordInput.current?.focus();
  }, [returned]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const outcome = await signIn(email, password);
      if (outcome.status !== 'signed_in') {
        setPassword('');
        setStep(
          outcome.status === 'second_factor'
            ? { kind: 'second-factor', challenge: outcome.challenge, methods: outcome.methods }
            : { kind: 'enroll', challenge: outcome.challenge },
        );
      }
    } catch (e) {
      // A locked email or address answers 429 with the wait (IAM-001 lockout).
      setError(
        tooManyAttemptsMessage(t, e) ??
          (e instanceof ApiError && e.status === 401
            ? t('auth.invalidCredentials')
            : t('auth.failed')),
      );
    } finally {
      setBusy(false);
    }
  };

  const backToPassword = useCallback((message: string | null) => {
    setStep({ kind: 'password' });
    setError(message);
    setReturned((count) => count + 1);
  }, []);
  const onExpired = useCallback(
    () => backToPassword(t('auth.challengeExpired')),
    [backToPassword, t],
  );
  const onBack = useCallback(() => backToPassword(null), [backToPassword]);
  const onSignedIn = useCallback((user: SessionUser) => setUser(user), [setUser]);

  if (step.kind === 'second-factor') {
    return (
      <SecondFactorStep
        challenge={step.challenge}
        methods={step.methods}
        onSignedIn={onSignedIn}
        onExpired={onExpired}
        onBack={onBack}
      />
    );
  }
  if (step.kind === 'enroll') {
    return (
      <EnrollmentStep
        challenge={step.challenge}
        email={email}
        onSignedIn={onSignedIn}
        onExpired={onExpired}
        onBack={onBack}
      />
    );
  }

  return (
    <form className="form" onSubmit={submit} aria-label={t('auth.signIn')}>
      <div className="form-field">
        <label htmlFor={`${id}-email`}>{t('auth.email')}</label>
        <input
          id={`${id}-email`}
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <PasswordField
        label={t('auth.password')}
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        inputRef={passwordInput}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="button-primary" disabled={busy}>
        {t('auth.signIn')}
      </button>
    </form>
  );
}
