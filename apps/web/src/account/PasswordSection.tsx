import { type FormEvent, useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import {
  PASSWORD_MIN_LENGTH,
  passwordProblemMessages,
  tooManyAttemptsMessage,
} from '../session/errors';
import { PasswordField } from '../session/PasswordField';
import { useSessionExpiry } from '../session/useSessionExpiry';
import type { AccountClient } from './client';

export interface PasswordSectionProps {
  /** The account's email, for password managers that save the new password under it. */
  email: string;
  client: AccountClient;
  /** Runs after a change, with the number of other sessions the backend signed out. */
  onChanged?: (signedOutSessions: number) => void;
}

type Failure = { message: string; problems: string[]; field: 'current' | 'new' | 'confirm' | null };

/**
 * Change the password (IAM-001): the current one is required (ASVS 2.1.5), the new one meets
 * the policy, and every other session is signed out (ASVS 3.3.3).
 */
export function PasswordSection({ email, client, onChanged }: PasswordSectionProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const id = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState('');
  const errorId = `${id}-error`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setDone('');
    if (next !== confirm) {
      setFailure({ message: t('password.mismatch'), problems: [], field: 'confirm' });
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const signedOut = await client.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(t('account.passwordChanged', { count: signedOut }));
      onChanged?.(signedOut);
    } catch (error) {
      if (expired(error)) return;
      const code = error instanceof ApiError ? error.code : undefined;
      const throttled = tooManyAttemptsMessage(t, error);
      if (throttled) {
        setFailure({ message: throttled, problems: [], field: null });
      } else if (code === 'wrong_password') {
        setFailure({ message: t('account.wrongPassword'), problems: [], field: 'current' });
      } else if (code === 'weak_password' && error instanceof ApiError) {
        setFailure({
          message: t('password.problemsIntro'),
          problems: passwordProblemMessages(t, error.body),
          field: 'new',
        });
      } else {
        setFailure({ message: t('account.passwordFailed'), problems: [], field: null });
      }
    } finally {
      setBusy(false);
    }
  };

  const flagged = (field: Failure['field']) => failure !== null && failure.field === field;

  return (
    <section aria-labelledby={`${id}-title`} className="account-section">
      <h2 id={`${id}-title`} className="facts-title">
        {t('account.password')}
      </h2>
      <p className="page-note">{t('account.passwordIntro')}</p>
      <form className="form" onSubmit={submit}>
        {/* Lets password managers file the new password under the right account. */}
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <PasswordField
          label={t('password.current')}
          toggleLabel={t('password.showCurrent')}
          autoComplete="current-password"
          value={current}
          onChange={setCurrent}
          invalid={flagged('current')}
          describedBy={flagged('current') ? errorId : undefined}
        />
        <PasswordField
          label={t('password.new')}
          toggleLabel={t('password.showNew')}
          autoComplete="new-password"
          hint={t('password.hint', { min: PASSWORD_MIN_LENGTH })}
          value={next}
          onChange={setNext}
          invalid={flagged('new')}
          describedBy={flagged('new') ? errorId : undefined}
        />
        <PasswordField
          label={t('password.confirmNew')}
          toggleLabel={t('password.showConfirm')}
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          invalid={flagged('confirm')}
          describedBy={flagged('confirm') ? errorId : undefined}
        />
        {failure && (
          <div id={errorId} className="form-error" role="alert">
            <p>{failure.message}</p>
            {failure.problems.length > 0 && (
              <ul>
                {failure.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <button type="submit" className="button-primary" disabled={busy}>
          {t('account.changePassword')}
        </button>
        <p role="status" className="form-status">
          {done}
        </p>
      </form>
    </section>
  );
}
