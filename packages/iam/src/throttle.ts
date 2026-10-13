/**
 * Progressive lockout and rate limits for sign-in (IAM-001; ASVS 2.2.1). Two counters apply to
 * every attempt: one per account (the submitted email, whether or not an account exists, so the
 * answer never reveals which emails are registered) and one per client address.
 *
 * - Account: the first five failures are free; then each failure locks the account key for
 *   30 s, doubling to at most 15 minutes. That allows at most a handful of guesses an hour
 *   once an attacker has used the free ones, far below ASVS's 100 per hour. A success clears
 *   the counter; failures older than a day are forgotten.
 * - Address: at most 50 failures in 15 minutes, across all accounts; then the address waits
 *   for the window to end. It stops one client from walking a list of emails.
 */
export const LOCKOUT = {
  freeFailures: 5,
  baseSeconds: 30,
  maxSeconds: 15 * 60,
  forgetAfterSeconds: 24 * 60 * 60,
  addressFailures: 50,
  addressWindowSeconds: 15 * 60,
} as const;

/** How long an account key stays locked after its `failures`-th failure in a row. */
export function lockoutSeconds(failures: number): number {
  if (failures < LOCKOUT.freeFailures) return 0;
  const doublings = Math.min(failures - LOCKOUT.freeFailures, 20);
  return Math.min(LOCKOUT.maxSeconds, LOCKOUT.baseSeconds * 2 ** doublings);
}

/** Throttle keys for one attempt. Emails are compared lower-cased and trimmed. */
export function throttleKeys(email: string, address: string): { account: string; address: string } {
  return { account: `email:${email.trim().toLowerCase()}`, address: `ip:${address}` };
}
