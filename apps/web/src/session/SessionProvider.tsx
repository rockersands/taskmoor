import { createContext, type ReactNode, useContext } from 'react';
import { useT } from '../i18n/I18nProvider';

export interface SessionUser {
  id: number;
  name: string;
}

export type Session = { status: 'anonymous' } | { status: 'signed-in'; user: SessionUser };

const SessionContext = createContext<Session>({ status: 'anonymous' });

/**
 * Who is signed in. Until the identity work lands (M1), the session is whatever the app is
 * started with; the shape stays the same once it comes from the server.
 */
export function SessionProvider({ session, children }: { session: Session; children: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  return useContext(SessionContext);
}

/** Shows its children to signed-in users and a sign-in prompt to everyone else. */
export function RequireSession({ children }: { children: ReactNode }) {
  const session = useSession();
  const t = useT();
  if (session.status === 'signed-in') return <>{children}</>;
  return (
    <section className="sign-in-prompt" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title" className="page-title">
        {t('auth.signInRequired')}
      </h1>
      <p className="page-note">{t('auth.signInExplanation')}</p>
      <button type="button" className="button-primary" disabled>
        {t('auth.signIn')}
      </button>
    </section>
  );
}
