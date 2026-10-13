import { KALO, SAMPLE_RECOVERY_CODES, SAMPLE_TOTP_SETUP, WRONG_CODE } from '../account/fixtures';
import { ApiError } from '../api/client';
import type { AuthenticationResponseJSON } from '../twofactor/webauthn';
import type { SecondFactorClient } from './secondFactorClient';

/** A synthetic assertion; the fake backend does not check it. */
const FAKE_ASSERTION = {
  id: 'credential-1',
  rawId: 'credential-1',
  type: 'public-key',
  response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' },
  clientExtensionResults: {},
} as AuthenticationResponseJSON;

/**
 * An in-memory second step of sign-in for stories: any code but 000000 signs Kalo in, a
 * security key always answers. Pass overrides to make a call fail or never answer.
 */
export function fakeSecondFactorClient(
  overrides: Partial<SecondFactorClient> = {},
): SecondFactorClient {
  return {
    verify: async (_challenge, answer) => {
      if (answer.method !== 'webauthn' && answer.code === WRONG_CODE) {
        throw new ApiError(401, { error: 'invalid_second_factor' });
      }
      return KALO;
    },
    answerWithSecurityKey: async () => FAKE_ASSERTION,
    startEnrollment: async () => SAMPLE_TOTP_SETUP,
    confirmEnrollment: async (_challenge, _token, code) => {
      if (code === WRONG_CODE) throw new ApiError(401, { error: 'invalid_second_factor' });
      return { user: KALO, recoveryCodes: SAMPLE_RECOVERY_CODES };
    },
    ...overrides,
  };
}
