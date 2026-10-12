import {
  randomBytes,
  type ScryptOptions,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';

function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/**
 * Password hashing with Node's scrypt (ADR-019 names Argon2id or the built-in fallback; the
 * built-in needs no native addon in the image). The stored form carries its parameters, so they
 * can rise later and old hashes still verify: scrypt$N$r$p$salt$hash, base64url.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

/** IAM-001: the default policy's minimum. The breached-password check comes with M1. */
export const PASSWORD_MIN_LENGTH = 12;

export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > 256) problems.push('must be at most 256 characters');
  return problems;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: 128 * N * R * 2,
  });
  return ['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(
    password.normalize('NFKC'),
    Buffer.from(salt, 'base64url'),
    expected.length,
    {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(n) * Number(r) * 2,
    },
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
