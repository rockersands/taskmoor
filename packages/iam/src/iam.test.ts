import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  ARGON2,
  hashPassword,
  hashPasswordScryptForTests,
  needsRehash,
  passwordHasher,
  pepperFromSecret,
  pepperIdOf,
  pepperRing,
  verifyAgainstDummy,
  verifyPassword,
} from './password';
import { checkPassword, PASSWORD_MIN_LENGTH, passwordProblems } from './policy';
import { LOCKOUT, lockoutSeconds, throttleKeys } from './throttle';
import { newToken, tokenHash, tokenMatches } from './token';

describe('password hashing', () => {
  it('[IAM-001] hashes with Argon2id and a fresh salt, and verifies only the same password', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
    expect(a).toMatch(
      new RegExp(
        `^\\$argon2id\\$v=19\\$m=${ARGON2.memorySize},t=${ARGON2.iterations},p=${ARGON2.parallelism}\\$[A-Za-z0-9+/]+\\$[A-Za-z0-9+/]+$`,
      ),
    );
    expect(await verifyPassword('correct horse battery staple', a)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', a)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', '$argon2id$v=19$broken')).toBe(false);
  });

  it('[IAM-001] still verifies M0 scrypt hashes and asks for them to be replaced', async () => {
    const legacy = await hashPasswordScryptForTests('correct horse battery staple');
    expect(legacy).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery staple', legacy)).toBe(true);
    expect(await verifyPassword('wrong horse battery staple', legacy)).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
    expect(needsRehash(await hashPassword('correct horse battery staple'))).toBe(false);
    expect(needsRehash('$argon2id$v=19$m=4096,t=3,p=1$c2FsdA$aGFzaA')).toBe(true);
  });

  it('treats Unicode spellings of the same text as the same password', async () => {
    const composed = 'café au lait, s’il vous plaît';
    const decomposed = 'café au lait, s’il vous plaît';
    expect(await verifyPassword(decomposed, await hashPassword(composed))).toBe(true);
  });

  it('never accepts a password against the dummy hash', async () => {
    expect(await verifyAgainstDummy('correct horse battery staple')).toBe(false);
  });
});

describe('password pepper (ASVS 2.4.5)', () => {
  const oldKey = pepperFromSecret('an old secret key that is long enough!!');
  const newKey = pepperFromSecret('a new secret key that is long enough too');

  it('[IAM-001] keys the password with a secret kept outside the database', async () => {
    const stored = await hashPassword('correct horse battery staple', newKey);
    expect(stored.startsWith(`pepper:${newKey.id}:$argon2id$`)).toBe(true);
    expect(pepperIdOf(stored)).toBe(newKey.id);
    expect(await verifyPassword('correct horse battery staple', stored, newKey)).toBe(true);
    // Without the key, or with another one, the hash is useless.
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(false);
    expect(await verifyPassword('correct horse battery staple', stored, oldKey)).toBe(false);
    expect(pepperIdOf(await hashPassword('x'))).toBeNull();
  });

  it('[IAM-001] verifies hashes of older keys and asks for them to move to the active one', async () => {
    const ring = pepperRing(newKey, [oldKey]);
    const old = await hashPassword('correct horse battery staple', oldKey);
    const plain = await hashPassword('correct horse battery staple');
    const hasher = passwordHasher(ring);
    expect(await hasher.verify('correct horse battery staple', old)).toBe(true);
    expect(await hasher.verify('correct horse battery staple', plain)).toBe(true);
    expect(hasher.needsRehash(old)).toBe(true);
    expect(hasher.needsRehash(plain)).toBe(true);
    const fresh = await hasher.hash('correct horse battery staple');
    expect(pepperIdOf(fresh)).toBe(newKey.id);
    expect(hasher.needsRehash(fresh)).toBe(false);
    expect(hasher.pepperId).toBe(newKey.id);
  });

  it('refuses a pepper shorter than 32 bytes', () => {
    expect(() => pepperFromSecret('too short')).toThrow(/32 bytes/);
  });
});

describe('password policy', () => {
  it('[IAM-001] applies the default length policy, counting characters rather than bytes', () => {
    expect(passwordProblems('short')).toEqual([
      `must be at least ${PASSWORD_MIN_LENGTH} characters`,
    ]);
    expect(passwordProblems('x'.repeat(129))).toEqual(['must be at most 128 characters']);
    // Twelve emoji are twelve characters (24 UTF-16 units).
    expect(checkPassword('🦊🐙🌵🍋🎲🚲🧭🪁🎻🛶🧩🪴')).toEqual([]);
    expect(checkPassword('🦊🐙🌵🍋🎲🚲🧭🪁🎻🛶🧩')).toEqual(['too_short']);
  });

  it('[IAM-001] refuses passwords from the breached list, also with padding', () => {
    expect(checkPassword('qwerty123456')).toEqual(['common']);
    expect(checkPassword('1qaz2wsx3edc')).toEqual(['common']);
    expect(checkPassword('Password2026!!')).toEqual(['common']);
    expect(checkPassword('  dragon  123 ')).toEqual(['common']);
    expect(checkPassword('correct horse battery staple')).toEqual([]);
  });

  it('[IAM-001] refuses repeated patterns and plain sequences, and nothing else by shape', () => {
    expect(checkPassword('aaaaaaaaaaaa')).toEqual(['predictable']);
    expect(checkPassword('abcdabcdabcdabcd')).toEqual(['predictable']);
    expect(checkPassword('345678901234')).toEqual(['predictable']);
    expect(checkPassword('zyxwvutsrqpo')).toEqual(['predictable']);
    // No composition rules (ASVS 2.1.9): lower case only, spaces only as separators, all fine.
    expect(checkPassword('ladder violet harbour')).toEqual([]);
    expect(checkPassword('tr0mbone-Q!uince')).toEqual([]);
  });

  it('[IAM-001] refuses a password containing the email, the name or the product', () => {
    const identity = ['kalo.mendez@example.com', 'Kalo Mendez'];
    expect(checkPassword('mendez is my password', { identity })).toEqual(['contains_identity']);
    expect(checkPassword('kalo.mendez@example.com!', { identity })).toEqual(['contains_identity']);
    expect(checkPassword('my taskmoor password', { identity })).toEqual(['contains_identity']);
    expect(checkPassword('ladder violet harbour', { identity })).toEqual([]);
  });

  it('honours a stricter policy', () => {
    const policy = { minLength: 16, maxLength: 64 };
    expect(checkPassword('ladder violet ok', { policy })).toEqual([]);
    expect(checkPassword('ladder violet', { policy })).toEqual(['too_short']);
  });
});

describe('sign-in throttling', () => {
  it('[IAM-001] allows five failures, then locks for 30 s doubling to 15 minutes', () => {
    expect([1, 2, 3, 4].map(lockoutSeconds)).toEqual([0, 0, 0, 0]);
    expect([5, 6, 7, 8, 9, 10, 11, 50].map(lockoutSeconds)).toEqual([
      30, 60, 120, 240, 480, 900, 900, 900,
    ]);
  });

  it('[IAM-001] never shrinks the lockout as failures grow, and caps it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), (n) => {
        expect(lockoutSeconds(n + 1)).toBeGreaterThanOrEqual(lockoutSeconds(n));
        expect(lockoutSeconds(n)).toBeLessThanOrEqual(LOCKOUT.maxSeconds);
      }),
    );
  });

  it('keys an attempt by the submitted email and by the address', () => {
    expect(throttleKeys(' Kalo@Example.com ', '203.0.113.9')).toEqual({
      account: 'email:kalo@example.com',
      address: 'ip:203.0.113.9',
    });
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
