import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { hashPassword, PASSWORD_MIN_LENGTH, passwordProblems, verifyPassword } from './password';
import { newToken, tokenHash, tokenMatches } from './token';

describe('passwords', () => {
  it('[IAM-001] hashes with a fresh salt and verifies only the same password', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(await verifyPassword('correct horse battery staple', a)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', a)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });

  it('treats Unicode spellings of the same text as the same password', async () => {
    const composed = 'café au lait, s’il vous plaît';
    const decomposed = 'café au lait, s’il vous plaît';
    expect(await verifyPassword(decomposed, await hashPassword(composed))).toBe(true);
  });

  it('[IAM-001] applies the default length policy', () => {
    expect(passwordProblems('short')).toEqual([
      `must be at least ${PASSWORD_MIN_LENGTH} characters`,
    ]);
    expect(passwordProblems('x'.repeat(PASSWORD_MIN_LENGTH))).toEqual([]);
    expect(passwordProblems('x'.repeat(300))).toEqual(['must be at most 256 characters']);
  });
});

describe('tokens', () => {
  it('are unguessable, hash deterministically and match only themselves', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(t);
    expect(tokenHash(t)).toBe(tokenHash(t));
    expect(tokenMatches(t, tokenHash(t))).toBe(true);
    expect(tokenMatches(newToken(), tokenHash(t))).toBe(false);
    expect(tokenMatches(t, 'zz')).toBe(false);
  });

  it('never matches a different token', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
        expect(tokenMatches(a, tokenHash(b))).toBe(a === b);
      }),
    );
  });
});
