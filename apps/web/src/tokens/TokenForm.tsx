import { type FormEvent, useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { type NewToken, TOKEN_SCOPES, type TokenPolicy, type TokenScope } from './client';
import { defaultExpiry, expiryChoices, SCOPE_HINTS, SCOPE_LABELS, useTokenText } from './format';

export interface TokenFormProps {
  policy: TokenPolicy;
  /** Offers the administration scope (people who administer something; service accounts). */
  allowAdmin: boolean;
  /** Offers SCIM provisioning, which goes alone (service accounts only; ADR-038). */
  allowScim?: boolean;
  /** Creates the token; a rejection with the backend's error is reported in the form. */
  onCreate: (token: NewToken) => Promise<void>;
  /** The reader's time zone for the expiry dates; null follows the device. */
  timeZone?: string | null;
}

type Failure = { message: string; field: 'name' | 'scopes' | 'expiry' | null };

/** Name, scopes and lifetime of a new token, within the policy's maximum (IAM-007). */
export function TokenForm({
  policy,
  allowAdmin,
  allowScim = false,
  onCreate,
  timeZone = null,
}: TokenFormProps) {
  const t = useT();
  const text = useTokenText(timeZone);
  const expired = useSessionExpiry();
  const id = useId();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<TokenScope[]>(['read']);
  const [days, setDays] = useState(() => defaultExpiry(policy));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const offered = TOKEN_SCOPES.filter(
    (s) => (allowAdmin || s !== 'admin') && (allowScim || s !== 'scim'),
  );
  const choices = expiryChoices(policy);
  const field = (key: string) => `${id}-${key}`;
  const flagged = (key: Failure['field']) =>
    failure?.field === key ? { 'aria-invalid': true, 'aria-describedby': field('error') } : {};

  // SCIM provisioning goes alone: choosing it clears the others, and the others clear it.
  const toggle = (scope: TokenScope, on: boolean) => {
    setFailure(null);
    setScopes((current) => {
      if (!on) return current.filter((s) => s !== scope);
      return scope === 'scim' ? ['scim'] : [...current.filter((s) => s !== 'scim'), scope];
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (scopes.length === 0) {
      setFailure({ message: t('tokens.scopesRequired'), field: 'scopes' });
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await onCreate({
        name: name.trim(),
        scopes: TOKEN_SCOPES.filter((s) => scopes.includes(s)),
        expiresInDays: days,
      });
      setName('');
      setScopes(['read']);
      setDays(defaultExpiry(policy));
    } catch (error) {
      if (expired(error)) return;
      const code = error instanceof ApiError ? error.code : undefined;
      if (code === 'expiry_too_long') {
        const body = (error as ApiError).body as { maxLifetimeDays?: number };
        setFailure({
          message: t('tokens.expiryTooLong', {
            max: body.maxLifetimeDays ?? policy.maxLifetimeDays,
          }),
          field: 'expiry',
        });
      } else if (code === 'scope_not_allowed') {
        setFailure({ message: t('tokens.scopeNotAllowed'), field: 'scopes' });
      } else {
        setFailure({ message: t('tokens.createFailed'), field: null });
      }
    } finally {
      setBusy(false);
    }
  };

  const now = Date.now();
  return (
    <form className="form token-form" onSubmit={submit}>
      <div className="form-field">
        <label htmlFor={field('name')}>{t('tokens.name')}</label>
        <input
          id={field('name')}
          required
          maxLength={100}
          autoComplete="off"
          value={name}
          aria-describedby={field('name-hint')}
          onChange={(e) => {
            setName(e.target.value);
            setFailure(null);
          }}
        />
        <p id={field('name-hint')} className="form-hint">
          {t('tokens.nameHint')}
        </p>
      </div>
      <fieldset
        className="token-scopes"
        {...(failure?.field === 'scopes' ? { 'aria-describedby': field('error') } : {})}
      >
        <legend>{t('tokens.scopes')}</legend>
        {offered.map((scope) => (
          <div key={scope} className="form-field form-field-inline token-scope">
            <input
              id={field(`scope-${scope}`)}
              type="checkbox"
              checked={scopes.includes(scope)}
              aria-describedby={field(`scope-${scope}-hint`)}
              onChange={(e) => toggle(scope, e.target.checked)}
            />
            <label htmlFor={field(`scope-${scope}`)}>{t(SCOPE_LABELS[scope])}</label>
            <p id={field(`scope-${scope}-hint`)} className="form-hint token-scope-hint">
              {t(SCOPE_HINTS[scope])}
            </p>
          </div>
        ))}
      </fieldset>
      <div className="form-field">
        <label htmlFor={field('expiry')}>{t('tokens.expiry')}</label>
        <select
          id={field('expiry')}
          value={days}
          aria-describedby={field('expiry-hint')}
          {...flagged('expiry')}
          onChange={(e) => {
            setDays(Number(e.target.value));
            setFailure(null);
          }}
        >
          {choices.map((d) => (
            <option key={d} value={d}>
              {t('tokens.expiryOption', {
                days: d,
                date: text.day(new Date(now + d * 86_400_000)),
              })}
            </option>
          ))}
        </select>
        <p id={field('expiry-hint')} className="form-hint">
          {t('tokens.expiryHint', { max: policy.maxLifetimeDays })}
        </p>
      </div>
      {failure && (
        <p id={field('error')} className="form-error" role="alert">
          {failure.message}
        </p>
      )}
      <div>
        <button type="submit" className="button-primary" disabled={busy}>
          {t('tokens.create')}
        </button>
      </div>
    </form>
  );
}
