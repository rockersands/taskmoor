import { api } from '../api/client';
import type { SessionUser } from '../session/SessionProvider';
import type { TotpSetupStart } from '../twofactor/types';
import { type PublicKeyCredentialCreationOptionsJSON, registerKey } from '../twofactor/webauthn';

/** One of the signed-in person's sessions, as `GET /api/v1/sessions` lists it (IAM-004). */
export interface AccountSession {
  id: number;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/** A registered security key or passkey (M1-084). */
export interface SecurityKey {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The person's second factors, as `GET /api/v1/account/two-factor` reports them. */
export interface TwoFactorStatus {
  totp: boolean;
  securityKeys: SecurityKey[];
  recoveryRemaining: number;
  /** A two-factor policy covers this person: the last factor cannot be removed. */
  required: boolean;
}

export interface ProfileChanges {
  name?: string;
  timeZone?: string | null;
  locale?: string | null;
}

/** The signed-in person's own endpoints. Stories and some tests pass their own. */
export interface AccountClient {
  /** PATCH /api/v1/account (IAM-008); resolves to the updated user. */
  updateProfile: (changes: ProfileChanges) => Promise<SessionUser>;
  /** PUT /api/v1/account/password (IAM-001); resolves to the number of sessions signed out. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<number>;
  listSessions: () => Promise<AccountSession[]>;
  signOutSession: (id: number) => Promise<void>;
  /** Resolves to the number of sessions signed out. */
  signOutOtherSessions: () => Promise<number>;
  twoFactorStatus: () => Promise<TwoFactorStatus>;
  /** Starts an authenticator-app setup; nothing is stored until the first code is confirmed. */
  startTotpSetup: () => Promise<TotpSetupStart>;
  /** Resolves to new recovery codes when the app is the first factor, null otherwise. */
  confirmTotpSetup: (setupToken: string, code: string) => Promise<string[] | null>;
  disableTotp: (password: string) => Promise<void>;
  /**
   * Registers a security key: the backend's options, the browser's ceremony, the backend's
   * check. Resolves to new recovery codes when the key is the first factor, null otherwise.
   */
  addSecurityKey: (name: string) => Promise<{ key: SecurityKey; recoveryCodes: string[] | null }>;
  removeSecurityKey: (id: number, password: string) => Promise<void>;
  /** Replaces every recovery code; the old ones stop working. */
  regenerateRecoveryCodes: (password: string) => Promise<string[]>;
}

export const accountClient: AccountClient = {
  updateProfile: async (changes) =>
    (await api<{ user: SessionUser }>('/account', { method: 'PATCH', body: changes })).user,
  changePassword: async (currentPassword, newPassword) =>
    (
      await api<{ signedOutSessions: number }>('/account/password', {
        method: 'PUT',
        body: { currentPassword, newPassword },
      })
    ).signedOutSessions,
  listSessions: async () => (await api<{ sessions: AccountSession[] }>('/sessions')).sessions,
  signOutSession: async (id) => {
    await api<null>(`/sessions/${id}`, { method: 'DELETE' });
  },
  signOutOtherSessions: async () =>
    (await api<{ revoked: number }>('/sessions/others', { method: 'DELETE' })).revoked,
  twoFactorStatus: async () => {
    // Missing fields read as "nothing set up", whatever the backend's version sends.
    const status = await api<Partial<TwoFactorStatus> | null>('/account/two-factor');
    return {
      totp: status?.totp === true,
      securityKeys: Array.isArray(status?.securityKeys) ? status.securityKeys : [],
      recoveryRemaining:
        typeof status?.recoveryRemaining === 'number' ? status.recoveryRemaining : 0,
      required: status?.required === true,
    };
  },
  startTotpSetup: () => api<TotpSetupStart>('/account/two-factor/totp', { method: 'POST' }),
  confirmTotpSetup: async (setupToken, code) =>
    (
      await api<{ recoveryCodes: string[] | null }>('/account/two-factor/totp/confirm', {
        method: 'POST',
        body: { setupToken, code },
      })
    ).recoveryCodes,
  disableTotp: async (password) => {
    await api<null>('/account/two-factor/totp/disable', { method: 'POST', body: { password } });
  },
  addSecurityKey: async (name) => {
    const { options, registrationToken } = await api<{
      options: PublicKeyCredentialCreationOptionsJSON;
      registrationToken: string;
    }>('/account/two-factor/webauthn/options', { method: 'POST' });
    const response = await registerKey(options);
    const { securityKey, recoveryCodes } = await api<{
      securityKey: Omit<SecurityKey, 'lastUsedAt'>;
      recoveryCodes: string[] | null;
    }>('/account/two-factor/webauthn', {
      method: 'POST',
      body: { registrationToken, name, response },
    });
    return { key: { ...securityKey, lastUsedAt: null }, recoveryCodes };
  },
  removeSecurityKey: async (id, password) => {
    await api<null>(`/account/two-factor/webauthn/${id}/remove`, {
      method: 'POST',
      body: { password },
    });
  },
  regenerateRecoveryCodes: async (password) =>
    (
      await api<{ recoveryCodes: string[] }>('/account/two-factor/recovery-codes', {
        method: 'POST',
        body: { password },
      })
    ).recoveryCodes,
};
