import { useId, useRef, useState } from 'react';
import { BreakAtSlashes } from '../admin/BreakAtSlashes';
import { useT } from '../i18n/I18nProvider';

export interface RedirectUriFieldProps {
  /** The backend's callback address, as the provider must know it. */
  uri: string;
}

/** Selects the whole address in its block, ready to copy with the keyboard. */
const selectWhole = (block: HTMLElement) => window.getSelection()?.selectAllChildren(block);

/**
 * Selects it once focus has settled: the focusing steps may move the selection to the start of
 * what gets focus (jsdom does), after the focus event is heard.
 */
const selectOnFocus = (block: HTMLElement) =>
  queueMicrotask(() => {
    if (document.activeElement === block) selectWhole(block);
  });

/**
 * The redirect URI administrators register at the identity provider (M1-080): read-only,
 * selected on focus, with a copy button. One address serves every provider.
 *
 * A read-only text block rather than a field (AD-9): a line ends after a '/', where
 * BreakAtSlashes offers a break, so the whole address shows on a phone without cutting 'v1' or
 * the host in two; only a host too long for a line of its own breaks inside (sso.css). A
 * browser's text field breaks a long address wherever the line runs out.
 */
export function RedirectUriField({ uri }: RedirectUriFieldProps) {
  const t = useT();
  const id = useId();
  const block = useRef<HTMLDivElement>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copyUri = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(uri);
      setCopy('copied');
    } catch {
      // The whole address focused and selected, for the person to copy themselves.
      const whole = block.current;
      if (whole) {
        whole.focus();
        selectWhole(whole);
      }
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
        <span id={`${id}-label`} className="form-label">
          {t('admin.sso.redirectLabel')}
        </span>
        <div className="token-secret-row">
          {/* A read-only text box: reached with Tab, read and selected, never changed. */}
          {/* biome-ignore lint/a11y/useSemanticElements: a text field cannot offer a line break only after a '/' (AD-9) */}
          <div
            ref={block}
            role="textbox"
            aria-readonly="true"
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-intro`}
            tabIndex={0}
            className="token-secret-value redirect-uri-value"
            onFocus={(e) => selectOnFocus(e.currentTarget)}
          >
            <BreakAtSlashes text={uri} />
          </div>
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
