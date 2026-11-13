import type { ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';

export interface StandaloneFrameProps {
  /** The page: a `main.setup` column with its PageHeader and cards. */
  children: ReactNode;
  /**
   * The one way out every stand-alone page has (D24), at the top beside the product name. The
   * sign-in page itself and the pages that come before any sign-in can work leave it out.
   */
  wayOut?: boolean;
  /** Where the way out leads, when signing in should come back somewhere (app consent). */
  signInRoute?: string;
}

/**
 * The reduced frame (D8, D24): the product name at the top and the page in one column, with no
 * app navigation. Setup, password links, invitations, unsubscribe and app consent stand in it, and
 * so does everything a signed-out visitor sees: the sign-in page, and nothing else.
 */
export function StandaloneFrame({
  children,
  wayOut = true,
  signInRoute = '#/sign-in',
}: StandaloneFrameProps) {
  const t = useT();
  return (
    <div className="standalone">
      <header className="standalone-bar">
        <span className="standalone-brand">{t('app.name')}</span>
        {wayOut && (
          <a className="button-quiet standalone-way-out" href={routeHref(signInRoute)}>
            {t('standalone.goToSignIn')}
          </a>
        )}
      </header>
      {children}
    </div>
  );
}
