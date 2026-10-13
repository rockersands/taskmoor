/**
 * An authenticator-app setup the backend started (M1-084): the secret for manual entry, the
 * otpauth URI the QR code carries, and the sealed token that brings the secret back with the
 * first code. Nothing is stored until that code is confirmed; the token lasts ten minutes.
 */
export interface TotpSetupStart {
  secret: string;
  uri: string;
  setupToken: string;
}

/** The secret in groups of four, easier to type into an app: "ABCD EFGH IJKL". */
export function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

/** Download name for recovery codes; a file name, not UI text. */
export const RECOVERY_FILE_NAME = 'taskmoor-recovery-codes.txt';
