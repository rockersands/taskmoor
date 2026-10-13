import { type FormEvent, useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { tooManyAttemptsMessage } from './errors';
import { PasswordField } from './PasswordField';
import { useSession } from './SessionProvider';

/** Email and password sign-in (IAM-001); SSO buttons join it in M1. */
export function SignInForm() {
  const t = useT();
  const { signIn } = useSession();
  const id = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
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
