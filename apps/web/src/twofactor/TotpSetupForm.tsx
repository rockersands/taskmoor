import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { CodeField } from './CodeField';
import { QrCode } from './QrCode';
import { groupSecret, type TotpSetupStart } from './types';

export interface TotpSetupFormProps {
  setup: TotpSetupStart;
  /** The confirm button, such as "Turn on" or "Verify and continue". */
  submitLabel: string;
  busy: boolean;
  /** The last refusal; a new one clears the code and puts the cursor back in the field. */
  error: string | null;
  onSubmit: (code: string) => void;
  onCancel: () => void;
  /** Puts the cursor in the code field when the form appears in place of a button. */
  focusCode?: boolean;
}

/**
 * Setting up an authenticator app (M1-084): a QR code of the otpauth URI, the same secret as
 * text for apps that cannot scan, and the first code, which proves the app works before
 * anything is saved. Used at sign-in when a policy requires it and on the Account page.
 */
export function TotpSetupForm({
  setup,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
  focusCode = false,
}: TotpSetupFormProps) {
  const t = useT();
  const id = useId();
  const [code, setCode] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const errorId = `${id}-error`;

  // Only on mount: later renders must not pull the cursor back.
  const focusOnMount = useRef(focusCode);
  useEffect(() => {
    if (focusOnMount.current) input.current?.focus();
  }, []);

  useEffect(() => {
    if (!error) return;
    setCode('');
    input.current?.focus();
  }, [error]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(code.trim());
  };

  return (
    <form className="form totp-setup" onSubmit={submit} aria-label={t('twoFactor.setupForm')}>
      <p className="totp-setup-step">{t('twoFactor.scan')}</p>
      <QrCode value={setup.uri} label={t('twoFactor.qrLabel')} />
      <div className="totp-key">
        <p className="form-hint">{t('twoFactor.manualKey')}</p>
        <code className="totp-key-value">
          {t('common.value', { value: groupSecret(setup.secret) })}
        </code>
      </div>
      <CodeField
        kind="one-time"
        label={t('twoFactor.code')}
        hint={t('twoFactor.codeHint')}
        value={code}
        onChange={setCode}
        inputRef={input}
        invalid={error !== null}
        describedBy={error ? errorId : undefined}
      />
      {error && (
        <p id={errorId} className="form-error" role="alert">
          {error}
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
