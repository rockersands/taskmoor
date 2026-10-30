import { concat, fromBase64url, fromHex, sha256, toBase64url } from './bytes';
import { type RandomSource, systemRandom } from './random';

/**
 * The secrets the Builder generates for one instance (M1-109; OPS-014, spec 05b section 1.2):
 * the instance's id and Ed25519 key pair, the database password, the password pepper, the
 * token-signing key, the master key for stored provider keys and the one-time setup token.
 * Every one carries at least 128 bits from the random source. Only the instance id and the
 * public half of the key reach the frontend kit.
 */
export interface GeneratedSecrets {
  instanceId: string;
  instanceKey: {
    /** The Ed25519 private key's 32-byte seed, base64url. */
    seed: string;
    /** SPKI DER, base64url: what the meta endpoint publishes. */
    publicKey: string;
    /** `SHA256:` and the base64url digest of the public key's DER, as the server shows it. */
    fingerprint: string;
  };
  databasePassword: string;
  passwordPepper: string;
  tokenSigningKey: string;
  masterKey: string;
  setupToken: string;
}

/** The secret values a kit must never show outside the backend, for scanning. */
export function secretValues(s: GeneratedSecrets): string[] {
  return [
    s.instanceKey.seed,
    s.databasePassword,
    s.passwordPepper,
    s.tokenSigningKey,
    s.masterKey,
    s.setupToken,
  ];
}

// DER prefixes of an Ed25519 key: PKCS #8 around the 32-byte seed, SPKI around the public key.
const PKCS8_PREFIX = fromHex('302e020100300506032b657004220420');
const SPKI_PREFIX = fromHex('302a300506032b6570032100');

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Letters and digits without bias: bytes at or above 248 (4 × 62) are drawn again. */
async function alphanumeric(random: RandomSource, length: number): Promise<string> {
  let out = '';
  while (out.length < length) {
    for (const b of await random.bytes(length)) {
      if (b < 248 && out.length < length) out += ALPHANUMERIC[b % 62];
    }
  }
  return out;
}

/** A version 4 UUID from 16 random bytes. */
async function uuid(random: RandomSource): Promise<string> {
  const b = await random.bytes(16);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The Ed25519 private key for a seed, as Web Crypto takes it. */
export function instancePrivateKey(seed: string) {
  return crypto.subtle.importKey(
    'pkcs8',
    concat(PKCS8_PREFIX, fromBase64url(seed)),
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
}

/** The public key (SPKI DER, base64url) and its fingerprint for a seed. */
export async function instancePublicKey(
  seed: string,
): Promise<{ publicKey: string; fingerprint: string }> {
  const jwk = await crypto.subtle.exportKey('jwk', await instancePrivateKey(seed));
  const spki = concat(SPKI_PREFIX, fromBase64url(jwk.x ?? ''));
  return { publicKey: toBase64url(spki), fingerprint: await keyFingerprint(toBase64url(spki)) };
}

export async function keyFingerprint(publicKey: string): Promise<string> {
  return `SHA256:${toBase64url(await sha256(fromBase64url(publicKey)))}`;
}

export async function generateSecrets(
  random: RandomSource = systemRandom,
): Promise<GeneratedSecrets> {
  const key = async () => toBase64url(await random.bytes(32));
  const instanceId = await uuid(random);
  const seed = await key();
  return {
    instanceId,
    instanceKey: { seed, ...(await instancePublicKey(seed)) },
    databasePassword: await alphanumeric(random, 32),
    passwordPepper: await key(),
    tokenSigningKey: await key(),
    masterKey: await key(),
    setupToken: await key(),
  };
}
