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

export interface StandaloneNoteProps {
  /**
   * What the line is: `checking` while a link is read (announced politely), `problem` when the
   * page cannot go on (an alert), `note` for information such as a site that is already set up.
   */
  kind: 'checking' | 'problem' | 'note';
  children: ReactNode;
}

const NOTE_ROLES = { checking: 'status', problem: 'alert', note: undefined } as const;

/**
 * The one line a stand-alone page shows on its card instead of its form (D24). A link that is
 * missing, used or expired is an alert, drawn in the shared error style (`.page-note` with an
 * alert, forms.css) as the sign-in page's errors are, and announced as one; anything else is a
 * note.
 */
export function StandaloneNote({ kind, children }: StandaloneNoteProps) {
  const role = NOTE_ROLES[kind];
  return (
    <div className="glass-card account-section">
      <p className="page-note" {...(role ? { role } : {})}>
        {children}
      </p>
    </div>
  );
}
