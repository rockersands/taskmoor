import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
} from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { openSecret, type PepperRing, sealSecret } from '@taskmoor/iam';
import { signedMetaText } from '@taskmoor/webconfig';
import type { Kysely } from 'kysely';

/**
 * The instance's identity (M1-106; API-017; ADR-070): an id and an Ed25519 key pair, made the
 * first time something asks for them and kept in `instance_setting`. The private key is sealed
 * with the password pepper, like the other secrets the server reads back, so a copy of the
 * database alone cannot sign as the instance. A frontend kit pins the id and public key and asks
 * the meta endpoint to sign a nonce of its choosing (`@taskmoor/webconfig` verifies it).
 *
 * The identity never changes by itself: a restore brings the old one back, and a lost pepper
 * leaves the public half readable but signing refused, rather than quietly a new instance.
 */
export const IDENTITY_KEY = 'identity';

interface Stored {
  id: string;
  /** SPKI DER, base64url. */
  publicKey: string;
  /** PKCS #8 DER in base64url, sealed. */
  privateKey: string;
  createdAt: string;
}

export interface InstanceIdentity {
  id: string;
  publicKey: string;
  /** `SHA256:` and the base64url SHA-256 of the public key's DER. */
  fingerprint: string;
  /** The signature over a nonce, base64url; null when the private key cannot be opened. */
  signNonce(nonce: string): string | null;
}

export const keyFingerprint = (publicKey: string) =>
  `SHA256:${createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url')}`;

/** PKCS #8 DER of an Ed25519 key around its 32-byte seed. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function make(peppers: PepperRing | undefined, preset?: { id: string; seed: string }): Stored {
  const { publicKey, privateKey } = preset
    ? (() => {
        const key = createPrivateKey({
          key: Buffer.concat([PKCS8_PREFIX, Buffer.from(preset.seed, 'base64url')]),
          format: 'der',
          type: 'pkcs8',
        });
        return { privateKey: key, publicKey: createPublicKey(key) };
      })()
    : generateKeyPairSync('ed25519');
  return {
    id: preset?.id ?? randomUUID(),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: sealSecret(
      privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
      peppers?.active,
    ),
    createdAt: new Date().toISOString(),
  };
}

/** The private key, or null when the pepper that sealed it is gone or the value is damaged. */
function openPrivateKey(sealed: string, peppers: PepperRing | undefined): KeyObject | null {
  const opened = openSecret(sealed, peppers);
  if (opened === null) return null;
  try {
    return createPrivateKey({
      key: Buffer.from(opened, 'base64url'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch {
    return null;
  }
}

/**
 * The instance's identity, made on first use (from the Builder kit's id and key when given);
 * two processes racing keep the first one written.
 */
export async function loadIdentity(
  db: Kysely<Database>,
  peppers: PepperRing | undefined,
  preset?: { id: string; seed: string },
): Promise<InstanceIdentity> {
  const read = async () =>
    (
      await db
        .selectFrom('instance_setting')
        .select('value')
        .where('key', '=', IDENTITY_KEY)
        .executeTakeFirst()
    )?.value as Stored | undefined;
  let stored = await read();
  if (!stored) {
    await db
      .insertInto('instance_setting')
      .values({ key: IDENTITY_KEY, value: JSON.stringify(make(peppers, preset)) })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute();
    stored = await read();
    if (!stored) throw new Error('the instance identity could not be stored');
  }
  const { id, publicKey } = stored;
  const privateKey = openPrivateKey(stored.privateKey, peppers);
  return {
    id,
    publicKey,
    fingerprint: keyFingerprint(publicKey),
    signNonce: (nonce) =>
      privateKey
        ? sign(null, Buffer.from(signedMetaText(id, nonce)), privateKey).toString('base64url')
        : null,
  };
}
