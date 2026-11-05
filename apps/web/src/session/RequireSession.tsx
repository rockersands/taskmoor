import type { ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider';
import { PageHeader } from '../shell/PageHeader';
import { OAuthSignIn } from './OAuthSignIn';
import { oauthClient } from './oauth';
import { useSession } from './SessionProvider';
import { SignInForm } from './SignInForm';

/**
 * Shows its children to signed-in users and a sign-in form to everyone else; with a backend on
 * another site, the way to its sign-in page (M1-107).
 */
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
    <section className="page sign-in-prompt" aria-labelledby="sign-in-title">
      <PageHeader
        titleId="sign-in-title"
        title={t('auth.signInRequired')}
        purpose={t('auth.signInExplanation')}
      />
      <div className="glass-card account-section sign-in-card">
        {oauthClient ? <OAuthSignIn auto /> : <SignInForm />}
      </div>
    </section>
  );
}
