import type { ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider';
import { PageHeader } from '../shell/PageHeader';

/** Home for someone signed out, as on a fresh install's first visit: where to start (M1-113). */
export function HomeSignedOut() {
  const t = useT();
  return (
    <section className="page">
      <PageHeader title={t('nav.home')} purpose={t('purpose.home')} />
      <p className="page-note">
        {t('home.signedOut')} <a href="#/sign-in">{t('auth.signIn')}</a>
      </p>
    </section>
  );
}

/**
 * A section with nothing to show yet: what #/search says to someone signed out, and #/home while
 * the session is being checked.
 */
export function PageNotReady({ title, purpose }: { title: ReactNode; purpose: ReactNode }) {
  const t = useT();
  return (
    <section className="page">
      <PageHeader title={title} purpose={purpose} />
      <p className="page-note">{t('page.underConstruction')}</p>
    </section>
  );
}
