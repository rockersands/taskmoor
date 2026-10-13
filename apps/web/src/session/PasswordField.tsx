import { useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { EyeIcon, EyeOffIcon } from '../shell/icons';

export interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  /** Name of the show/hide button; forms with several password fields name each one. */
  toggleLabel?: string | undefined;
  hint?: string | undefined;
  /** Ids of other elements that describe the field, such as an error message. */
  describedBy?: string | undefined;
  invalid?: boolean | undefined;
  required?: boolean;
}

/**
 * A password input with a show/hide toggle (ASVS 2.1.12). The toggle is a toggle button: its
 * name stays the same and `aria-pressed` says whether the password is shown. Paste is never
 * blocked, so password managers and pasted passphrases work.
 */
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  toggleLabel,
  hint,
  describedBy,
  invalid = false,
  required = true,
}: PasswordFieldProps) {
  const t = useT();
  const id = useId();
  const [visible, setVisible] = useState(false);
  const hintId = `${id}-hint`;
  const describedByIds = [hint ? hintId : '', describedBy ?? ''].filter(Boolean).join(' ');
  const name = toggleLabel ?? t('password.show');

  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <div className="password-control">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required={required}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          {...(describedByIds ? { 'aria-describedby': describedByIds } : {})}
          {...(invalid ? { 'aria-invalid': true } : {})}
        />
        <button
          type="button"
          className="password-toggle"
          aria-label={name}
          title={name}
          aria-pressed={visible}
          aria-controls={id}
          onClick={() => setVisible((shown) => !shown)}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
      {hint && (
        <p id={hintId} className="form-hint">
          {hint}
        </p>
      )}
    </div>
  );
}
