import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import { applyAppearance, toAppearance } from '../skins/skins';
import { oauthClient } from './oauth';

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  isSiteAdmin: boolean;
  /** IANA time zone the person chose; null follows the device. */
  timeZone: string | null;
  /** BCP 47 locale the person chose; null follows the browser. */
  locale: string | null;
  /** `system` or a skin name (M1-122); older answers and fixtures may leave it out. */
  appearance?: string;
}

export type Session =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'signed-in'; user: SessionUser };

/** A second factor the backend accepts from this person at sign-in (M1-084). */
export type SecondFactorMethod = 'totp' | 'webauthn' | 'recovery_code';

/**
 * Where a correct password leads (IAM-001): straight in, to the second factor, or to the
 * enrolment a two-factor policy requires. The two challenges last five minutes.
 */
export type SignInOutcome =
  | { status: 'signed_in'; user: SessionUser }
  | { status: 'second_factor'; challenge: string; methods: SecondFactorMethod[] }
  | { status: 'enrollment_required'; challenge: string };

interface SessionContextValue {
  session: Session;
  /** Checks the password; only a `signed_in` outcome starts the session. */
  signIn: (email: string, password: string) => Promise<SignInOutcome>;
  signOut: () => Promise<void>;
  /** Re-reads the session from the backend, for example after setup created it. */
  refresh: () => Promise<void>;
  /** Takes a user the backend just returned: a saved profile or a redeemed password link. */
  setUser: (user: SessionUser) => void;
}

const SessionContext = createContext<SessionContextValue>({
  session: { status: 'anonymous' },
  signIn: async () => {
    throw new Error('SessionProvider is missing');
  },
  signOut: async () => {},
  refresh: async () => {},
  setUser: () => {},
});

/**
 * Who is signed in, from the backend's cookie session (GET /api/v1/session), or from the OAuth
 * tokens of a backend on another site (M1-107). A fixed `session` prop skips the request:
 * tests and stories start where they need to.
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
    // Without a token there is nobody to ask about: the backend's cookie does not come here.
    if (oauthClient && !oauthClient.hasTokens()) {
      setSession({ status: 'anonymous' });
      return;
    }
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

  // The backend refused a refresh (signed out elsewhere, or a reused token ended the session).
  useEffect(() => {
    if (fixed || !oauthClient) return;
    return oauthClient.onSignedOut(() => setSession({ status: 'anonymous' }));
  }, [fixed]);

  // The account's appearance wins wherever the person signs in (M1-122, ADR-036); signed out,
  // the browser keeps what it last showed.
  const appearance = session.status === 'signed-in' ? session.user.appearance : undefined;
  useEffect(() => {
    if (appearance !== undefined) applyAppearance(toAppearance(appearance));
  }, [appearance]);

  const signIn = useCallback(async (email: string, password: string): Promise<SignInOutcome> => {
    const answer = await api<SignInOutcome | { status?: undefined; user: SessionUser }>(
      '/session',
      { method: 'POST', body: { email, password } },
    );
    if (answer.status === 'second_factor' || answer.status === 'enrollment_required') {
      return answer;
    }
    setSession({ status: 'signed-in', user: answer.user });
    return { status: 'signed_in', user: answer.user };
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api<null>('/session', { method: 'DELETE' });
    } finally {
      // Ends the token family and the backend session behind it; the tokens go either way.
      oauthClient?.clear();
    }
    setSession({ status: 'anonymous' });
  }, []);

  const setUser = useCallback((user: SessionUser) => {
    setSession({ status: 'signed-in', user });
  }, []);

  return (
    <SessionContext.Provider value={{ session, signIn, signOut, refresh, setUser }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  return useContext(SessionContext);
}
