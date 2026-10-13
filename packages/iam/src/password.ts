import {
  createHash,
  createHmac,
  randomBytes,
  type ScryptOptions,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

/**
 * Password hashing (ADR-019).
 *
 * - Argon2id with OWASP's recommended cost (19 MiB, two passes, one lane), computed in
 *   WebAssembly so the image needs no native addon. The encoded form carries its parameters.
 * - A pepper (ASVS 2.4.5): a secret key kept outside the database, from the environment or a
 *   key file in the data directory. The password is keyed with HMAC-SHA-256 before Argon2id,
 *   so a copy of the user table alone cannot be attacked offline. Peppered hashes are stored as
 *   `pepper:<key id>:<argon2id encoding>`; the key id is the first 8 hex digits of the key's
 *   SHA-256, so a changed or missing key is detected rather than mistaken for a wrong password.
 * - M0 stored scrypt hashes, and installs without a pepper store plain Argon2id. Both still
 *   verify; `needsRehash` tells sign-in to replace them with today's scheme.
 */
export const ARGON2 = {
  memorySize: 19_456,
  iterations: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

export interface Pepper {
  /** Names the key in stored hashes; derived from the key, never secret. */
  id: string;
  key: Buffer;
}

/**
 * The peppers an install knows: the active one hashes new passwords; older ones (from before a
 * key rotation, or merged in by a restore) still verify, and sign-in moves hashes to the active
 * key. `find` may reload its source when asked for an id it does not know yet.
 */
export interface PepperRing {
  active: Pepper | undefined;
  find(id: string): Pepper | undefined;
}

export function pepperRing(active?: Pepper, others: readonly Pepper[] = []): PepperRing {
  const all = new Map([...others, ...(active ? [active] : [])].map((p) => [p.id, p]));
  return { active, find: (id) => all.get(id) };
}

function asRing(peppers: Pepper | PepperRing | undefined): PepperRing {
  if (!peppers) return pepperRing();
  return 'find' in peppers ? peppers : pepperRing(peppers);
}

/** A pepper from a secret of at least 32 bytes (raw, or text such as base64url). */
export function pepperFromSecret(secret: Buffer | string): Pepper {
  const key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  if (key.length < 32) throw new Error('A password pepper needs at least 32 bytes');
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 8), key };
}

/** Unicode normalisation, so the same password typed on different keyboards matches (ASVS 2.1.4). */
function prepare(password: string): string {
  return password.normalize('NFKC');
}

function keyed(password: string, pepper: Pepper): string {
  return createHmac('sha256', pepper.key).update(prepare(password)).digest('base64');
}

async function argon2Encoded(input: string): Promise<string> {
  return argon2id({ password: input, salt: randomBytes(16), ...ARGON2, outputType: 'encoded' });
}

async function argon2Matches(input: string, encoded: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: input, hash: encoded });
  } catch {
    return false;
  }
}

export async function hashPassword(password: string, pepper?: Pepper): Promise<string> {
  if (!pepper) return argon2Encoded(prepare(password));
  return `pepper:${pepper.id}:${await argon2Encoded(keyed(password, pepper))}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
  peppers?: Pepper | PepperRing,
): Promise<boolean> {
  if (stored.startsWith('pepper:')) {
    const [, id, encoded] = splitPeppered(stored);
    const pepper = id ? asRing(peppers).find(id) : undefined;
    if (!pepper || !encoded) return false;
    return argon2Matches(keyed(password, pepper), encoded);
  }
  if (stored.startsWith('$argon2id$')) return argon2Matches(prepare(password), stored);
  if (stored.startsWith('scrypt$')) return verifyScrypt(prepare(password), stored);
  return false;
}

function splitPeppered(stored: string): [string, string, string] {
  const first = stored.indexOf(':');
  const second = stored.indexOf(':', first + 1);
  if (first < 0 || second < 0) return ['', '', ''];
  return [stored.slice(0, first), stored.slice(first + 1, second), stored.slice(second + 1)];
}

/** The key id a peppered hash was made with, or null for a hash without a pepper. */
export function pepperIdOf(stored: string): string | null {
  return stored.startsWith('pepper:') ? splitPeppered(stored)[1] || null : null;
}

const ARGON2_PARAMS = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/;

/** True when the stored hash is not today's scheme (algorithm, cost or pepper) and should be replaced. */
export function needsRehash(stored: string, pepper?: Pepper): boolean {
  let encoded = stored;
  if (stored.startsWith('pepper:')) {
    const [, id, rest] = splitPeppered(stored);
    if (!pepper || id !== pepper.id) return true;
    encoded = rest;
  } else if (pepper) {
    return true;
  }
  const m = ARGON2_PARAMS.exec(encoded);
  if (!m) return true;
  return (
    Number(m[1]) < ARGON2.memorySize ||
    Number(m[2]) < ARGON2.iterations ||
    Number(m[3]) !== ARGON2.parallelism
  );
}

const dummies = new Map<string, Promise<string>>();

/**
 * Verifies against a throwaway hash of the same cost. Sign-in calls it for unknown accounts and
 * accounts without a password, so a wrong email takes as long as a wrong password.
 */
export async function verifyAgainstDummy(password: string, pepper?: Pepper): Promise<false> {
  const slot = pepper?.id ?? '';
  let dummy = dummies.get(slot);
  if (!dummy) {
    dummy = hashPassword(randomBytes(24).toString('base64url'), pepper);
    dummies.set(slot, dummy);
  }
  await verifyPassword(password, await dummy, pepper);
  return false;
}

/** The hashing operations with the install's peppers bound, as the server passes them around. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
  verifyDummy(password: string): Promise<false>;
  needsRehash(stored: string): boolean;
  /** The pepper's key id, or null when hashing without one. */
  pepperId: string | null;
}

export function passwordHasher(peppers?: Pepper | PepperRing): PasswordHasher {
  const ring = asRing(peppers);
  return {
    hash: (password) => hashPassword(password, ring.active),
    verify: (password, stored) => verifyPassword(password, stored, ring),
    verifyDummy: (password) => verifyAgainstDummy(password, ring.active),
    needsRehash: (stored) => needsRehash(stored, ring.active),
    get pepperId() {
      return ring.active?.id ?? null;
    },
  };
}

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

/** M0's format: scrypt$N$r$p$salt$hash, base64url. Verify only; nothing writes it any more. */
async function verifyScrypt(password: string, stored: string): Promise<boolean> {
  const [, n, r, p, salt, hash] = stored.split('$');
  if (!n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) * 2,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** M0's hash function, kept so tests can produce legacy hashes and prove they upgrade. */
export async function hashPasswordScryptForTests(password: string): Promise<string> {
  const N = 2 ** 15;
  const salt = randomBytes(16);
  const hash = await scrypt(prepare(password), salt, 32, { N, r: 8, p: 1, maxmem: 128 * N * 16 });
  return ['scrypt', N, 8, 1, salt.toString('base64url'), hash.toString('base64url')].join('$');
}
