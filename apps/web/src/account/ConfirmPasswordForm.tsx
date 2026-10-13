import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { tooManyAttemptsMessage } from '../session/errors';
import { PasswordField } from '../session/PasswordField';
import { useSessionExpiry } from '../session/useSessionExpiry';

export interface ConfirmPasswordFormProps {
  /** The account's email, so password managers offer the right password. */
  email: string;
  /** Names the form after the change it confirms, such as "Remove Blue key". */
  label: string;
  submitLabel: string;
  /** Runs the change with the password; a rejection is reported in the form. */
  onConfirm: (password: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * Asks for the password again before a change to the second factors (ASVS 3.7.1): switching
 * the app off, removing a key, new recovery codes. Wrong passwords count against the lockout.
 */
export function ConfirmPasswordForm({
  email,
  label,
  submitLabel,
  onConfirm,
  onCancel,
}: ConfirmPasswordFormProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; wrongPassword: boolean } | null>(null);
  const errorId = `${id}-error`;

  useEffect(() => {
    input.current?.focus();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onConfirm(password);
      setBusy(false);
    } catch (e) {
      setBusy(false);
      if (expired(e)) return;
      const code = e instanceof ApiError ? e.code : undefined;
      const message =
        tooManyAttemptsMessage(t, e) ??
        (code === 'wrong_password'
          ? t('account.wrongPassword')
          : code === 'two_factor_required'
            ? t('account.twoFactor.lastFactor')
            : code === 'no_second_factor'
              ? t('account.twoFactor.noSecondFactor')
              : t('account.twoFactor.actionFailed'));
      setError({ message, wrongPassword: code === 'wrong_password' });
      if (code === 'wrong_password') {
        setPassword('');
        input.current?.focus();
      }
    }
  };

  return (
    <form className="form confirm-password" onSubmit={submit} aria-label={label}>
      <p className="page-note">{t('account.twoFactor.confirmIntro')}</p>
      {/* Lets password managers offer the password of the right account. */}
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      <PasswordField
        label={t('password.current')}
        toggleLabel={t('password.showCurrent')}
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        inputRef={input}
        invalid={error?.wrongPassword}
        describedBy={error ? errorId : undefined}
      />
      {error && (
        <p id={errorId} className="form-error" role="alert">
          {error.message}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {submitLabel}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('twoFactor.cancel')}
        </button>
      </div>
    </form>
  );
}
