import { useEffect, useId, useRef } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { SignInSsoClient } from '../sso/client';
import { OAuthSignIn } from './OAuthSignIn';
import { oauthClient } from './oauth';
import { useSession } from './SessionProvider';
import { SignInForm } from './SignInForm';

export interface SignInPageProps {
  onSignedIn: () => void;
  /** Stories and tests pass their own single sign-on endpoints. */
  ssoClient?: SignInSsoClient;
}

/**
 * The sign-in page (#/sign-in): where "Sign in" in the top bar leads, where signing out lands
 * and where a failed single sign-on returns. Once someone is signed in it hands over to
 * `onSignedIn`. With a backend on another site, it leads to that backend's sign-in (M1-107).
 */
export function SignInPage({ onSignedIn, ssoClient }: SignInPageProps) {
  const t = useT();
  const { session } = useSession();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (session.status === 'signed-in') onSignedIn();
  }, [session.status, onSignedIn]);

  // Signing out removes the control that had focus; start again from the page heading.
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body) {
      heading.current?.focus();
    }
  }, []);

  return (
    <section className="sign-in-prompt" aria-labelledby={titleId}>
      <h1 id={titleId} ref={heading} tabIndex={-1} className="page-title">
        {t('auth.signIn')}
      </h1>
      {session.status === 'loading' ? (
        <p className="page-note" aria-live="polite">
          {t('auth.checking')}
        </p>
      ) : oauthClient ? (
        <OAuthSignIn />
      ) : (
        <SignInForm {...(ssoClient ? { ssoClient } : {})} />
      )}
    </section>
  );
}
