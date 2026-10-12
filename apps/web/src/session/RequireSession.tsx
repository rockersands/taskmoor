import type { ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider';
import { useSession } from './SessionProvider';
import { SignInForm } from './SignInForm';

/** Shows its children to signed-in users and a sign-in form to everyone else. */
export function RequireSession({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const t = useT();
  if (session.status === 'signed-in') return <>{children}</>;
  if (session.status === 'loading') {
    return (
      <p className="page-note" aria-live="polite">
        {t('auth.checking')}
      </p>
    );
  }
  return (
    <section className="sign-in-prompt" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title" className="page-title">
        {t('auth.signInRequired')}
      </h1>
      <p className="page-note">{t('auth.signInExplanation')}</p>
      <SignInForm />
    </section>
  );
}
