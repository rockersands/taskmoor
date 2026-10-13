import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { RECOVERY_FILE_NAME } from './types';

export interface RecoveryCodesProps {
  codes: string[];
  /** The account the codes belong to, written at the top of the downloaded file. */
  account: string;
  /** Heading level where the codes appear: 2 on the sign-in page, 3 inside an Account section. */
  level: 2 | 3;
  /** The button that leaves, such as "Continue" at sign-in or "Done" on the Account page. */
  doneLabel: string;
  onDone: () => void;
}

/**
 * New recovery codes, shown once (M1-084): copy them all, download them as a text file, and
 * confirm they are saved before leaving. The backend keeps only hashes, so this is the only
 * time anyone sees them.
 */
export function RecoveryCodes({ codes, account, level, doneLabel, onDone }: RecoveryCodesProps) {
  const t = useT();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [saved, setSaved] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const Heading = level === 2 ? 'h2' : 'h3';

  // The codes replace the form that was focused; start reading from their heading.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const text = () =>
    `${[t('twoFactor.recovery.fileHeader', { account }), '', ...codes].join('\n')}\n`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setCopyStatus(t('twoFactor.recovery.copied'));
    } catch {
      setCopyStatus(t('twoFactor.recovery.copyFailed'));
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text()], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = RECOVERY_FILE_NAME;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="recovery-codes" aria-labelledby={`${id}-title`}>
      <Heading id={`${id}-title`} ref={heading} tabIndex={-1} className="recovery-codes-title">
        {t('twoFactor.recovery.title')}
      </Heading>
      <p className="page-note">{t('twoFactor.recovery.intro')}</p>
      <ul className="recovery-code-list" aria-label={t('twoFactor.recovery.listLabel')}>
        {codes.map((code) => (
          <li key={code}>
            <code>{t('common.value', { value: code })}</code>
          </li>
        ))}
      </ul>
      <div className="form-actions">
        <button type="button" className="button-secondary" onClick={() => void copy()}>
          {t('twoFactor.recovery.copy')}
        </button>
        <button type="button" className="button-secondary" onClick={download}>
          {t('twoFactor.recovery.download')}
        </button>
      </div>
      <div className="form-field form-field-inline">
        <input
          id={`${id}-saved`}
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        <label htmlFor={`${id}-saved`}>{t('twoFactor.recovery.confirm')}</label>
      </div>
      <div className="form-actions">
        <button type="button" className="button-primary" disabled={!saved} onClick={onDone}>
          {doneLabel}
        </button>
      </div>
      <p role="status" className="form-status">
        {copyStatus}
      </p>
    </section>
  );
}
