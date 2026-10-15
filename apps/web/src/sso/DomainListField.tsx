import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { CloseIcon } from '../shell/icons';
import { normalizeDomain } from './client';

export interface DomainListFieldProps {
  domains: string[];
  onChange: (domains: string[]) => void;
  /** Set when the backend refused a domain (another provider serves it). */
  invalid?: boolean;
  /** The id of a message about the domains, such as the backend's refusal. */
  describedBy?: string | undefined;
}

/**
 * The email domains a provider serves, as a list of removable entries (M1-080). Enter, a comma,
 * the Add button or leaving the field adds what was typed; several domains can be pasted at
 * once. A typed text that is not a domain stays in the field with an explanation and keeps the
 * form from being sent.
 */
export function DomainListField({
  domains,
  onChange,
  invalid = false,
  describedBy,
}: DomainListFieldProps) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  // The browser's own form check stops a submit while the field holds something invalid.
  useEffect(() => {
    input.current?.setCustomValidity(problem ?? '');
  }, [problem]);

  const commit = () => {
    const parts = text.split(/[\s,;]+/).filter(Boolean);
    const added: string[] = [];
    const rejected: string[] = [];
    for (const part of parts) {
      const domain = normalizeDomain(part);
      if (domain) added.push(domain);
      else rejected.push(part);
    }
    if (added.length > 0) onChange([...new Set([...domains, ...added])]);
    setText(rejected.join(' '));
    setProblem(rejected[0] ? t('admin.sso.form.invalidDomain', { domain: rejected[0] }) : null);
  };

  const remove = (domain: string) => {
    onChange(domains.filter((d) => d !== domain));
    // The button that had focus is gone; the cursor waits in the field.
    input.current?.focus();
  };

  const describedByIds = [
    `${id}-hint`,
    problem ? `${id}-problem` : '',
    invalid && describedBy ? describedBy : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <fieldset className="sso-domains">
      <legend>{t('admin.sso.form.domains')}</legend>
      <p id={`${id}-hint`} className="form-hint">
        {t('admin.sso.form.domainsHint')}
      </p>
      {domains.length === 0 ? (
        <p className="form-hint">{t('admin.sso.form.noDomains')}</p>
      ) : (
        <ul className="sso-chips" aria-label={t('admin.sso.form.domainList')}>
          {domains.map((domain) => (
            <li key={domain} className="sso-chip">
              <span>{t('common.value', { value: domain })}</span>
              <button
                type="button"
                className="sso-chip-remove"
                aria-label={t('admin.sso.form.removeDomain', { domain })}
                title={t('admin.sso.form.removeDomain', { domain })}
                onClick={() => remove(domain)}
              >
                <CloseIcon width="16" height="16" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-field">
        <label htmlFor={`${id}-input`}>{t('admin.sso.form.domain')}</label>
        <div className="sso-add-row">
          <input
            ref={input}
            id={`${id}-input`}
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={text}
            aria-describedby={describedByIds}
            {...(problem || invalid ? { 'aria-invalid': true } : {})}
            onChange={(e) => {
              const value = e.target.value;
              setText(value);
              if (problem) setProblem(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commit();
              }
            }}
            onBlur={commit}
          />
          <button type="button" className="button-secondary" onClick={commit}>
            {t('admin.sso.form.addDomain')}
          </button>
        </div>
        {problem && (
          <p id={`${id}-problem`} role="alert" className="form-error">
            {problem}
          </p>
        )}
      </div>
    </fieldset>
  );
}
