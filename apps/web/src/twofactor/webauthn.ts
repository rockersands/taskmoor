import {
  type AuthenticationResponseJSON,
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import type { Translate } from '../i18n/I18nProvider';

export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
};

/**
 * Why the browser's part of a security-key ceremony did not finish: no WebAuthn here, the
 * person cancelled or the key did not answer in time, the key is registered already, or
 * anything else the browser reported.
 */
export type SecurityKeyProblem = 'unsupported' | 'cancelled' | 'already_registered' | 'failed';

export class SecurityKeyError extends Error {
  constructor(readonly problem: SecurityKeyProblem) {
    super(`security key: ${problem}`);
    this.name = 'SecurityKeyError';
  }
}

/** Sorts what the browser threw (a DOMException, or @simplewebauthn's WebAuthnError). */
export function toSecurityKeyError(error: unknown): SecurityKeyError {
  if (error instanceof SecurityKeyError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return new SecurityKeyError('cancelled');
  if (name === 'InvalidStateError') return new SecurityKeyError('already_registered');
  if (name === 'NotSupportedError') return new SecurityKeyError('unsupported');
  return new SecurityKeyError('failed');
}

/** Lets the browser answer a sign-in challenge with a registered key (WebAuthn get). */
export async function authenticateWithKey(
  optionsJSON: PublicKeyCredentialRequestOptionsJSON,
): Promise<AuthenticationResponseJSON> {
  if (!browserSupportsWebAuthn()) throw new SecurityKeyError('unsupported');
  try {
    return await startAuthentication({ optionsJSON });
  } catch (error) {
    throw toSecurityKeyError(error);
  }
}

/** Lets the browser create a credential on a key or in a passkey provider (WebAuthn create). */
export async function registerKey(
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> {
  if (!browserSupportsWebAuthn()) throw new SecurityKeyError('unsupported');
  try {
    return await startRegistration({ optionsJSON });
  } catch (error) {
    throw toSecurityKeyError(error);
  }
}

/** The sentence for a browser-side security-key problem, or null for any other error. */
export function securityKeyMessage(t: Translate, error: unknown): string | null {
  if (!(error instanceof SecurityKeyError)) return null;
  switch (error.problem) {
    case 'unsupported':
      return t('twoFactor.keyUnsupported');
    case 'already_registered':
      return t('account.twoFactor.keyAlreadyRegistered');
    default:
      return t('twoFactor.keyCancelled');
  }
}
