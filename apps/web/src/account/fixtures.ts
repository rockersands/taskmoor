import { ApiError } from '../api/client';
import type { Session, SessionUser } from '../session/SessionProvider';
import type { TotpSetupStart } from '../twofactor/types';
import type { AccountClient, AccountSession, TwoFactorStatus } from './client';

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

/** Ten synthetic recovery codes in the backend's XXXXX-XXXXX shape. */
export const SAMPLE_RECOVERY_CODES = [
  'KD7QX-M2PLA',
  'R4TNB-Z9WEH',
  'HB3YC-QF6UV',
  'P8JLS-T2KXD',
  'W5MZA-C7RNQ',
  'E6VGH-Y3BTL',
  'N2XKP-J8DWS',
  'U4FRC-L5QZM',
  'G7TYE-B2VNH',
  'S3WQD-K6PXA',
];

/** A synthetic authenticator-app setup; the secret is not anybody's. */
export const SAMPLE_TOTP_SETUP: TotpSetupStart = {
  secret: 'MZXW6YTBOI4TQNRVGQ3DCMZRGQ2DIMZT',
  uri: 'otpauth://totp/Taskmoor%3Akalo%40example.com?secret=MZXW6YTBOI4TQNRVGQ3DCMZRGQ2DIMZT&issuer=Taskmoor&algorithm=SHA1&digits=6&period=30',
  setupToken: 'sealed-setup-token',
};

/** The password the fake backend accepts when a change asks for it again. */
export const FAKE_PASSWORD = 'the current passphrase';
/** The code the fake backend refuses, to show a wrong code. */
export const WRONG_CODE = '000000';

export const TWO_FACTOR_OFF: TwoFactorStatus = {
  totp: false,
  securityKeys: [],
  recoveryRemaining: 0,
  required: false,
};

/** An app and two keys, eight recovery codes left, timed relative to `now`. */
export function twoFactorOn(now = Date.now()): TwoFactorStatus {
  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
  return {
    totp: true,
    securityKeys: [
      { id: 21, name: 'Blue key', createdAt: ago(40), lastUsedAt: ago(2) },
      { id: 22, name: 'Work laptop', createdAt: ago(9), lastUsedAt: null },
    ],
    recoveryRemaining: 8,
    required: false,
  };
}

/**
 * An in-memory account backend: it keeps the profile, the sessions and the second factors, so
 * stories behave like the real page. Pass overrides to make a call fail or never answer.
 */
export function fakeAccountClient(
  overrides: Partial<AccountClient> = {},
  options: { user?: SessionUser; sessions?: AccountSession[]; twoFactor?: TwoFactorStatus } = {},
): AccountClient {
  let user = options.user ?? KALO;
  let sessions = options.sessions ?? sampleSessions();
  let factors = options.twoFactor ?? TWO_FACTOR_OFF;
  let nextKeyId = 100;
  const hasFactor = () => factors.totp || factors.securityKeys.length > 0;
  const checkPassword = (password: string) => {
    if (password !== FAKE_PASSWORD) throw new ApiError(403, { error: 'wrong_password' });
  };
  /** Codes for a first factor, null when the person had one already. */
  const firstFactorCodes = () => {
    if (hasFactor()) return null;
    factors = { ...factors, recoveryRemaining: SAMPLE_RECOVERY_CODES.length };
    return SAMPLE_RECOVERY_CODES;
  };
  const lastRequired = () =>
    factors.required && Number(factors.totp) + factors.securityKeys.length === 1;
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
    twoFactorStatus: async () => factors,
    startTotpSetup: async () => SAMPLE_TOTP_SETUP,
    confirmTotpSetup: async (_token, code) => {
      if (code === WRONG_CODE) throw new ApiError(400, { error: 'invalid_code' });
      const codes = firstFactorCodes();
      factors = { ...factors, totp: true };
      return codes;
    },
    disableTotp: async (password) => {
      checkPassword(password);
      if (lastRequired()) throw new ApiError(409, { error: 'two_factor_required' });
      factors = { ...factors, totp: false };
      if (!hasFactor()) factors = { ...factors, recoveryRemaining: 0 };
    },
    addSecurityKey: async (name) => {
      const key = { id: nextKeyId++, name, createdAt: new Date().toISOString(), lastUsedAt: null };
      const recoveryCodes = firstFactorCodes();
      factors = { ...factors, securityKeys: [...factors.securityKeys, key] };
      return { key, recoveryCodes };
    },
    removeSecurityKey: async (id, password) => {
      checkPassword(password);
      if (lastRequired()) throw new ApiError(409, { error: 'two_factor_required' });
      factors = { ...factors, securityKeys: factors.securityKeys.filter((k) => k.id !== id) };
      if (!hasFactor()) factors = { ...factors, recoveryRemaining: 0 };
    },
    regenerateRecoveryCodes: async (password) => {
      checkPassword(password);
      factors = { ...factors, recoveryRemaining: SAMPLE_RECOVERY_CODES.length };
      return SAMPLE_RECOVERY_CODES;
    },
    ...overrides,
  };
}
