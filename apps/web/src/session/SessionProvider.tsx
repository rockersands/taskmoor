import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  isSiteAdmin: boolean;
}

export type Session =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'signed-in'; user: SessionUser };

interface SessionContextValue {
  session: Session;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-reads the session from the backend, for example after setup created it. */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue>({
  session: { status: 'anonymous' },
  signIn: async () => {},
  signOut: async () => {},
  refresh: async () => {},
});

/**
 * Who is signed in, from the backend's cookie session (GET /api/v1/session). A fixed `session`
 * prop skips the request: tests and stories start where they need to.
 */
export function SessionProvider({
  session: fixed,
  children,
}: {
  session?: Session;
  children: ReactNode;
}) {
  const [session, setSession] = useState<Session>(fixed ?? { status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const { user } = await api<{ user: SessionUser }>('/session');
      setSession({ status: 'signed-in', user });
    } catch (error) {
      // 401 means signed out; anything else (no backend in a static preview) reads the same.
      if (!(error instanceof ApiError) || error.status !== 401) {
        if (import.meta.env.DEV) console.warn('session check failed', error);
      }
      setSession({ status: 'anonymous' });
    }
  }, []);

  useEffect(() => {
    if (!fixed) void refresh();
  }, [fixed, refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { user } = await api<{ user: SessionUser }>('/session', {
      method: 'POST',
      body: { email, password },
    });
    setSession({ status: 'signed-in', user });
  }, []);

  const signOut = useCallback(async () => {
    await api<null>('/session', { method: 'DELETE' });
    setSession({ status: 'anonymous' });
  }, []);

  return (
    <SessionContext.Provider value={{ session, signIn, signOut, refresh }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  return useContext(SessionContext);
}
