import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';

export interface TokenSecretProps {
  /** The token, shown this once. */
  token: string;
  /** What the token is called, for the heading. */
  name: string;
  /** Hides the token; it cannot be shown again. */
  onDone: () => void;
}

/**
 * A new token, shown once (IAM-007): read-only, selected on focus, with a copy button. Focus
 * moves here when it appears, so keyboard and screen-reader users land on it.
 */
export function TokenSecret({ token, name, onDone }: TokenSecretProps) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const copyToken = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(token);
      setCopy('copied');
    } catch {
      input.current?.select();
      setCopy('failed');
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className="token-secret">
      <h3 id={`${id}-title`} className="token-secret-title">
        {t('tokens.secretTitle', { name })}
      </h3>
      <p className="page-note">{t('tokens.secretIntro')}</p>
      <div className="form-field">
        <label htmlFor={`${id}-value`}>{t('tokens.secretLabel')}</label>
        <div className="token-secret-row">
          <input
            ref={input}
            id={`${id}-value`}
            className="token-secret-value"
            readOnly
            value={token}
            spellCheck={false}
            autoComplete="off"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button type="button" className="button-secondary" onClick={() => void copyToken()}>
            {t('tokens.copy')}
          </button>
        </div>
      </div>
      <p role="status" className="form-status">
        {copy === 'copied' ? t('tokens.copied') : ''}
      </p>
      {copy === 'failed' && (
        <p role="alert" className="form-error">
          {t('tokens.copyFailed')}
        </p>
      )}
      <div>
        <button type="button" className="button-primary" onClick={onDone}>
          {t('tokens.done')}
        </button>
      </div>
    </section>
  );
}
