import { type Ref, useId } from 'react';

export interface CodeFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * `one-time` is a 6-digit authenticator code: a numeric keyboard on phones and the one-time
   * code autofill of browsers and password managers. `recovery` is a recovery code.
   */
  kind: 'one-time' | 'recovery';
  hint?: string | undefined;
  /** Ids of other elements that describe the field, such as an error message. */
  describedBy?: string | undefined;
  invalid?: boolean | undefined;
  inputRef?: Ref<HTMLInputElement> | undefined;
}

/** The input for a second-factor code at sign-in and during setup (M1-084). */
export function CodeField({
  label,
  value,
  onChange,
  kind,
  hint,
  describedBy,
  invalid = false,
  inputRef,
}: CodeFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const describedByIds = [hint ? hintId : '', describedBy ?? ''].filter(Boolean).join(' ');
  const oneTime = kind === 'one-time';
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <input
        ref={inputRef}
        id={id}
        className={oneTime ? 'code-input' : 'code-input code-input-recovery'}
        type="text"
        inputMode={oneTime ? 'numeric' : 'text'}
        autoComplete={oneTime ? 'one-time-code' : 'off'}
        autoCapitalize={oneTime ? 'none' : 'characters'}
        autoCorrect="off"
        spellCheck={false}
        maxLength={oneTime ? 9 : 40}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...(describedByIds ? { 'aria-describedby': describedByIds } : {})}
        {...(invalid ? { 'aria-invalid': true } : {})}
      />
      {hint && (
        <p id={hintId} className="form-hint">
          {hint}
        </p>
      )}
    </div>
  );
}
