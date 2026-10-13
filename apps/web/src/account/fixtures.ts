import type { Session, SessionUser } from '../session/SessionProvider';
import type { AccountClient, AccountSession } from './client';

/** Synthetic people and sessions for stories and tests. */
export const KALO: SessionUser = {
  id: 1,
  name: 'Kalo Mendes',
  email: 'kalo@example.com',
  isSiteAdmin: false,
  timeZone: null,
  locale: null,
};

export const SIGNED_IN: Session = { status: 'signed-in', user: KALO };

export const USER_AGENTS = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
} as const;

/** This device and two others, timed relative to `now`. */
export function sampleSessions(now = Date.now()): AccountSession[] {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const expires = new Date(now + 14 * 86_400_000).toISOString();
  return [
    {
      id: 11,
      createdAt: ago(3 * 24 * 60),
      lastSeenAt: ago(0),
      expiresAt: expires,
      ip: '203.0.113.7',
      userAgent: USER_AGENTS.chromeWindows,
      current: true,
    },
    {
      id: 12,
      createdAt: ago(2 * 24 * 60),
      lastSeenAt: ago(5),
      expiresAt: expires,
      ip: '198.51.100.23',
      userAgent: USER_AGENTS.firefoxLinux,
      current: false,
    },
    {
      id: 13,
      createdAt: ago(9 * 24 * 60),
      lastSeenAt: ago(26 * 60),
      expiresAt: expires,
      ip: '2001:db8:85a3::8a2e:370:7334',
      userAgent: USER_AGENTS.safariIphone,
      current: false,
    },
  ];
}

/**
 * An in-memory account backend: it keeps the profile and the sessions, so stories behave like
 * the real page. Pass overrides to make a call fail or never answer.
 */
export function fakeAccountClient(
  overrides: Partial<AccountClient> = {},
  options: { user?: SessionUser; sessions?: AccountSession[] } = {},
): AccountClient {
  let user = options.user ?? KALO;
  let sessions = options.sessions ?? sampleSessions();
  return {
    updateProfile: async (changes) => {
      user = { ...user, ...changes };
      return user;
    },
    changePassword: async () => {
      const others = sessions.filter((s) => !s.current).length;
      sessions = sessions.filter((s) => s.current);
      return others;
    },
    listSessions: async () => sessions,
    signOutSession: async (id) => {
      sessions = sessions.filter((s) => s.id !== id);
    },
    signOutOtherSessions: async () => {
      const others = sessions.filter((s) => !s.current).length;
      sessions = sessions.filter((s) => s.current);
      return others;
    },
    ...overrides,
  };
}
