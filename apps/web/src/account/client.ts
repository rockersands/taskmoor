import { api } from '../api/client';
import type { SessionUser } from '../session/SessionProvider';

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
};
