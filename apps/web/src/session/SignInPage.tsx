import { useEffect, useId, useRef } from 'react';
import { useT } from '../i18n/I18nProvider';
import { useSession } from './SessionProvider';
import { SignInForm } from './SignInForm';

/**
 * The sign-in page (#/sign-in): where "Sign in" in the top bar leads and where signing out
 * lands. Once someone is signed in it hands over to `onSignedIn`.
 */
export function SignInPage({ onSignedIn }: { onSignedIn: () => void }) {
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
      ) : (
        <SignInForm />
      )}
    </section>
  );
}
