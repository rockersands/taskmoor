import { api } from '../api/client';
import type { TotpSetupStart } from '../twofactor/types';
import {
  type AuthenticationResponseJSON,
  authenticateWithKey,
  type PublicKeyCredentialRequestOptionsJSON,
} from '../twofactor/webauthn';
import type { SessionUser } from './SessionProvider';

/** What the person gives as the second factor. */
export type SecondFactorAnswer =
  | { method: 'totp' | 'recovery_code'; code: string }
  | { method: 'webauthn'; response: AuthenticationResponseJSON };

/**
 * The second step of sign-in (M1-084, IAM-001). Every call carries the challenge the password
 * step returned; an expired or used-up challenge answers 401 `invalid_challenge`.
 */
export interface SecondFactorClient {
  /** Finishes the sign-in; resolves to the user once the session has started. */
  verify: (challenge: string, answer: SecondFactorAnswer) => Promise<SessionUser>;
  /**
   * Asks the backend for a security-key challenge and lets the browser answer it. Rejects with
   * an ApiError (409 `no_security_key`) or a SecurityKeyError from the browser.
   */
  answerWithSecurityKey: (challenge: string) => Promise<AuthenticationResponseJSON>;
  /** Starts the authenticator-app setup a policy requires before the session starts. */
  startEnrollment: (challenge: string) => Promise<TotpSetupStart>;
  /** Confirms the first code; the session starts and the recovery codes arrive, once. */
  confirmEnrollment: (
    challenge: string,
    setupToken: string,
    code: string,
  ) => Promise<{ user: SessionUser; recoveryCodes: string[] }>;
}

export const secondFactorClient: SecondFactorClient = {
  verify: async (challenge, answer) =>
    (
      await api<{ user: SessionUser }>('/session/second-factor', {
        method: 'POST',
        body: { challenge, ...answer },
      })
    ).user,
  answerWithSecurityKey: async (challenge) => {
    const { options } = await api<{ options: PublicKeyCredentialRequestOptionsJSON }>(
      '/session/second-factor/webauthn',
      { method: 'POST', body: { challenge } },
    );
    return authenticateWithKey(options);
  },
  startEnrollment: (challenge) =>
    api<TotpSetupStart>('/session/enroll/totp', { method: 'POST', body: { challenge } }),
  confirmEnrollment: async (challenge, setupToken, code) => {
    const { user, recoveryCodes } = await api<{ user: SessionUser; recoveryCodes: string[] }>(
      '/session/enroll/totp/confirm',
      { method: 'POST', body: { challenge, setupToken, code } },
    );
    return { user, recoveryCodes };
  },
};
