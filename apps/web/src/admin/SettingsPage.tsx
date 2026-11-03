import { useId } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { PageHeader } from '../shell/PageHeader';
import { useAdminAccess } from './access';
import { ADMIN_HOME } from './sections';

/** Settings are personal: the person's account, appearance and tutorials (ADR-114). */
export function SettingsPage() {
  const t = useT();
  const titleId = useId();
  const access = useAdminAccess();
  return (
    <section aria-labelledby={titleId}>
      <PageHeader titleId={titleId} title={t('nav.settings')} purpose={t('settings.purpose')} />
      <div className="glass-card admin-panel settings-section">
        <ul className="link-list">
          <li>
            <a href={routeHref('#/account')}>{t('settings.account')}</a>
            <p className="page-note">{t('settings.accountHint')}</p>
          </li>
          <li>
            <a href={routeHref('#/account')}>{t('account.appearance')}</a>
            <p className="page-note">{t('account.appearance.intro')}</p>
          </li>
          <li>
            <a href={routeHref('#/settings/tutorials')}>{t('tutorial.title')}</a>
            <p className="page-note">{t('settings.tutorialsHint')}</p>
          </li>
        </ul>
      </div>
      {access !== null && access !== 'none' && (
        <p className="page-note settings-section">
          {t('settings.administrationMoved')}{' '}
          <a href={routeHref(ADMIN_HOME)}>{t('nav.administration')}</a>
        </p>
      )}
    </section>
  );
}
