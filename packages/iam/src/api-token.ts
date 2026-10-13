import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { tokenHash } from './token';

/**
 * API tokens (IAM-007, ADR-034): `tmk_`, 40 random base62 characters (238 bits) and a 6-character
 * base62 CRC32 of them. The prefix lets secret scanners find leaked tokens with one pattern; the
 * checksum lets them, and the server, tell a real token from look-alike text without a lookup.
 * Like sessions, only the SHA-256 of a token is stored and the token is shown once.
 */
export const API_TOKEN_PREFIX = 'tmk_';
const RANDOM_LENGTH = 40;
const CHECKSUM_LENGTH = 6;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** What a secret scanner looks for: `tmk_` and 46 base62 characters. */
export const API_TOKEN_PATTERN = /\btmk_[0-9A-Za-z]{46}\b/;

/** Random base62 text; bytes of 248 and above are skipped so every character is equally likely. */
function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= 248) continue;
      out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

function base62(value: number, width: number): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < width; i++) {
    out = BASE62[rest % 62] + out;
    rest = Math.floor(rest / 62);
  }
  return out;
}

function checksum(random: string): string {
  return base62(crc32(random), CHECKSUM_LENGTH);
}

/** A fresh API token and the hash the database keeps. */
export function newApiToken(): { token: string; hash: string } {
  const random = randomBase62(RANDOM_LENGTH);
  const token = `${API_TOKEN_PREFIX}${random}${checksum(random)}`;
  return { token, hash: tokenHash(token) };
}

/** True for text shaped like an API token with a valid checksum; says nothing about validity. */
export function isWellFormedApiToken(text: string): boolean {
  if (text.length !== API_TOKEN_PREFIX.length + RANDOM_LENGTH + CHECKSUM_LENGTH) return false;
  if (!text.startsWith(API_TOKEN_PREFIX)) return false;
  const body = text.slice(API_TOKEN_PREFIX.length);
  if (!/^[0-9A-Za-z]+$/.test(body)) return false;
  const random = body.slice(0, RANDOM_LENGTH);
  return body.slice(RANDOM_LENGTH) === checksum(random);
}
