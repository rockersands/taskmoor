import { useId } from 'react';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';

/** Settings: the person's own account for everyone, administration for site administrators. */
export function SettingsPage() {
  const t = useT();
  const { session } = useSession();
  const personalId = useId();
  const adminId = useId();
  const admin = session.status === 'signed-in' && session.user.isSiteAdmin;
  return (
    <>
      <h1 className="page-title">{t('nav.settings')}</h1>
      <section aria-labelledby={personalId} className="settings-section">
        <h2 id={personalId} className="facts-title">
          {t('settings.personal')}
        </h2>
        <ul className="link-list">
          <li>
            <a href="#/account">{t('settings.account')}</a>
            <p className="page-note">{t('settings.accountHint')}</p>
          </li>
        </ul>
      </section>
      {admin && (
        <section aria-labelledby={adminId} className="settings-section">
          <h2 id={adminId} className="facts-title">
            {t('settings.administration')}
          </h2>
          <ul className="link-list">
            <li>
              <a href="#/admin/system">{t('settings.systemStatus')}</a>
              <p className="page-note">{t('settings.systemStatusHint')}</p>
            </li>
          </ul>
        </section>
      )}
    </>
  );
}
