import { type FormEvent, useId, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { type SessionUser, useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import type { AccountClient } from './client';
import { localeOptions, timeZoneOptions } from './options';

export interface ProfileSectionProps {
  user: SessionUser;
  client: AccountClient;
}

type Failure = { message: string; field: 'timeZone' | 'locale' | null };

/** Name, time zone and locale of the signed-in person (IAM-008). */
export function ProfileSection({ user, client }: ProfileSectionProps) {
  const t = useT();
  const intl = useIntl();
  const { setUser } = useSession();
  const expired = useSessionExpiry();
  const id = useId();
  const [name, setName] = useState(user.name);
  const [timeZone, setTimeZone] = useState(user.timeZone ?? '');
  const [locale, setLocale] = useState(user.locale ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  // Data, not UI text: it goes through the catalogue only so the pseudo-locale can bracket it.
  const zones = useMemo(
    () =>
      timeZoneOptions(user.timeZone).map((zone) => ({
        value: zone,
        label: intl.formatMessage({ id: 'common.value' }, { value: zone.replaceAll('_', ' ') }),
      })),
    [intl, user.timeZone],
  );
  const locales = useMemo(
    () =>
      localeOptions(intl.locale, user.locale).map((option) => ({
        value: option.value,
        label: intl.formatMessage({ id: 'common.value' }, { value: option.label }),
      })),
    [intl, user.locale],
  );

  const field = (key: string) => `${id}-${key}`;
  const edited = () => {
    setSaved(false);
    setFailure(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setFailure(null);
    try {
      setUser(
        await client.updateProfile({
          name: name.trim(),
          timeZone: timeZone || null,
          locale: locale || null,
        }),
      );
      setSaved(true);
    } catch (error) {
      if (expired(error)) return;
      const code = error instanceof ApiError ? error.code : undefined;
      if (code === 'invalid_time_zone') {
        setFailure({ message: t('account.invalidTimeZone'), field: 'timeZone' });
      } else if (code === 'invalid_locale') {
        setFailure({ message: t('account.invalidLocale'), field: 'locale' });
      } else {
        setFailure({ message: t('account.profileFailed'), field: null });
      }
    } finally {
      setBusy(false);
    }
  };

  const describedBy = (key: 'timeZone' | 'locale', hintId: string) =>
    failure?.field === key ? `${hintId} ${field('error')}` : hintId;

  return (
    <section aria-labelledby={field('title')} className="account-section">
      <h2 id={field('title')} className="facts-title">
        {t('account.profile')}
      </h2>
      <form className="form" onSubmit={submit}>
        <div className="form-field">
          <label htmlFor={field('name')}>{t('account.name')}</label>
          <input
            id={field('name')}
            required
            maxLength={200}
            autoComplete="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              edited();
            }}
          />
        </div>
        <div className="form-field">
          <label htmlFor={field('email')}>{t('auth.email')}</label>
          <input id={field('email')} type="email" readOnly value={user.email} />
        </div>
        <div className="form-field">
          <label htmlFor={field('time-zone')}>{t('account.timeZone')}</label>
          <select
            id={field('time-zone')}
            value={timeZone}
            aria-describedby={describedBy('timeZone', field('time-zone-hint'))}
            {...(failure?.field === 'timeZone' ? { 'aria-invalid': true } : {})}
            onChange={(e) => {
              setTimeZone(e.target.value);
              edited();
            }}
          >
            <option value="">{t('account.timeZoneAutomatic')}</option>
            {zones.map((zone) => (
              <option key={zone.value} value={zone.value}>
                {zone.label}
              </option>
            ))}
          </select>
          <p id={field('time-zone-hint')} className="form-hint">
            {t('account.timeZoneHint')}
          </p>
        </div>
        <div className="form-field">
          <label htmlFor={field('locale')}>{t('account.locale')}</label>
          <select
            id={field('locale')}
            value={locale}
            aria-describedby={describedBy('locale', field('locale-hint'))}
            {...(failure?.field === 'locale' ? { 'aria-invalid': true } : {})}
            onChange={(e) => {
              setLocale(e.target.value);
              edited();
            }}
          >
            <option value="">{t('account.localeAutomatic')}</option>
            {locales.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p id={field('locale-hint')} className="form-hint">
            {t('account.localeHint')}
          </p>
        </div>
        {failure && (
          <p id={field('error')} className="form-error" role="alert">
            {failure.message}
          </p>
        )}
        <button type="submit" className="button-primary" disabled={busy}>
          {t('account.saveProfile')}
        </button>
        <p role="status" className="form-status">
          {saved ? t('account.profileSaved') : ''}
        </p>
      </form>
    </section>
  );
}
