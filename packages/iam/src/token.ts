import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** An unguessable token for setup links, sessions and API tokens: 32 random bytes, base64url. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** What the database stores: a token is shown once and only its hash is kept. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Compares a presented token with a stored hash without leaking timing. */
export function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(tokenHash(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
