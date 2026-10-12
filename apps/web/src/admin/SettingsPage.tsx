import { useId } from 'react';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';

/** Settings: for now the administration links; personal settings join in M1. */
export function SettingsPage() {
  const t = useT();
  const { session } = useSession();
  const adminId = useId();
  const admin = session.status === 'signed-in' && session.user.isSiteAdmin;
  return (
    <>
      <h1 className="page-title">{t('nav.settings')}</h1>
      {admin ? (
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
      ) : (
        <p className="page-note">{t('page.underConstruction')}</p>
      )}
    </>
  );
}
