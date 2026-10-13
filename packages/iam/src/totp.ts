import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { Pepper, PepperRing } from './password';

/**
 * Time-based one-time passwords (RFC 6238 with HMAC-SHA-1, 6 digits, 30-second steps), the
 * authenticator-app factor of IAM-001. Written here rather than taken from a library: the
 * algorithm is 20 lines and the RFC's test vectors check it.
 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_STEP_SECONDS = 30;

/** A new secret: 20 random bytes (160 bits, RFC 4226's recommendation), base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** The code for one time step (RFC 4226 dynamic truncation). */
export function totpCode(secret: string | Buffer, step: number, digits = 6): string {
  const key = typeof secret === 'string' ? base32Decode(secret) : secret;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, '0');
}

/**
 * Checks a code against the current step and one step either side (clock drift). A step at
 * or before `lastStep` is refused, so a code works once (ASVS 2.8.4). Returns the matching
 * step to store as the new `lastStep`, or null.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now: Date,
  lastStep: number | null = null,
): number | null {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const current = totpStep(now);
  for (const step of [current - 1, current, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = totpCode(secret, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return step;
  }
  return null;
}

/** The provisioning URI an authenticator app reads from a QR code. */
export function otpauthUri(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Recovery codes: ten codes of ten base32 characters (50 bits each), shown once as
 * XXXXX-XXXXX. Stored as hashes; each works once.
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Recovery codes compare without case, spaces or dashes. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Secrets the server must read back (TOTP seeds) are sealed with AES-256-GCM under a key
 * derived from the password pepper (HKDF-SHA-256), so a copy of the database alone does not
 * reveal them. `enc1:<pepper id>:<iv>:<ciphertext>:<tag>`, base64url; without a pepper (a
 * development install) the value is stored as `plain:<secret>`.
 */
function sealKey(pepper: Pepper): Buffer {
  return Buffer.from(hkdfSync('sha256', pepper.key, Buffer.alloc(0), 'taskmoor sealed secret', 32));
}

export function sealSecret(plain: string, pepper: Pepper | undefined): string {
  if (!pepper) return `plain:${plain}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(pepper), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'enc1',
    pepper.id,
    iv.toString('base64url'),
    body.toString('base64url'),
    tag.toString('base64url'),
  ].join(':');
}

export function openSecret(sealed: string, peppers: PepperRing | undefined): string | null {
  if (sealed.startsWith('plain:')) return sealed.slice('plain:'.length);
  const [scheme, id, iv, body, tag] = sealed.split(':');
  if (scheme !== 'enc1' || !id || !iv || !body || !tag) return null;
  const pepper = peppers?.find(id);
  if (!pepper) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', sealKey(pepper), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
