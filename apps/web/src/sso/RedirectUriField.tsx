import { useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';

export interface RedirectUriFieldProps {
  /** The backend's callback address, as the provider must know it. */
  uri: string;
}

/**
 * The redirect URI administrators register at the identity provider (M1-080): read-only,
 * selected on focus, with a copy button. One address serves every provider.
 */
export function RedirectUriField({ uri }: RedirectUriFieldProps) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copyUri = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(uri);
      setCopy('copied');
    } catch {
      input.current?.focus();
      input.current?.select();
      setCopy('failed');
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className="glass-card account-section">
      <h2 id={`${id}-title`} className="facts-title">
        {t('admin.sso.redirectTitle')}
      </h2>
      <p id={`${id}-intro`} className="page-note">
        {t('admin.sso.redirectIntro')}
      </p>
      <div className="form-field">
        <label htmlFor={`${id}-value`}>{t('admin.sso.redirectLabel')}</label>
        <div className="token-secret-row">
          <input
            ref={input}
            id={`${id}-value`}
            className="token-secret-value"
            readOnly
            value={uri}
            spellCheck={false}
            autoComplete="off"
            aria-describedby={`${id}-intro`}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button type="button" className="button-secondary" onClick={() => void copyUri()}>
            {t('admin.sso.copy')}
          </button>
        </div>
      </div>
      <p role="status" className="form-status">
        {copy === 'copied' ? t('admin.sso.copied') : ''}
      </p>
      {copy === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.sso.copyFailed')}
        </p>
      )}
    </section>
  );
}
