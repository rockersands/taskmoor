import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for secrets the server must read back (IAM-020, ADR-098): each secret is
 * encrypted with its own random data key (AES-256-GCM), and the data key is wrapped by a
 * key-encryption key that never enters the database. The row keeps the ciphertext, the wrapped
 * data key and the id of the key that wrapped it; a copy of the database alone reveals nothing.
 *
 * Key-encryption keys:
 * - `LocalKek`: derived from a secret the operator holds (the Builder kit's `MASTER_KEY`, or the
 *   install's password pepper when there is no master key);
 * - `ExternalKek`: a key held by a key service (a cloud KMS or HashiCorp Vault's transit engine)
 *   that wraps and unwraps data keys for the server and never hands its own key out.
 *
 * Rotating the key-encryption key re-wraps the data keys (`rewrapEnvelope`); the secrets' own
 * ciphertexts do not change.
 */

/** What wraps and unwraps data keys. Implementations must not log what they are given. */
export interface KeyEncryptionKey {
  /** Stored beside every data key it wraps: names the key, never reveals it. */
  readonly id: string;
  wrap(dataKey: Buffer): Promise<string>;
  unwrap(wrapped: string): Promise<Buffer>;
}

/**
 * A key service that keeps its key to itself: AWS KMS, Google Cloud KMS or Azure Key Vault
 * (`kind: 'kms'`), or HashiCorp Vault's transit secrets engine (`kind: 'vault'`). Each maps to
 * two calls: AWS KMS `Encrypt` and `Decrypt` with the key's ARN; Vault
 * `POST transit/encrypt/:name` and `transit/decrypt/:name` with base64 plaintext. The server only
 * ever sends it 32-byte data keys, never the secrets themselves.
 */
export interface ExternalKeyService {
  readonly kind: 'kms' | 'vault';
  /** The key's name at the service: an ARN, a resource name or a transit key name. */
  readonly keyRef: string;
  encrypt(plaintext: Uint8Array): Promise<string>;
  decrypt(ciphertext: string): Promise<Uint8Array>;
}

export type EnvelopeErrorCode = 'no_active_key' | 'unknown_key' | 'unreadable';

/** A secret cannot be sealed or opened. The message names keys by id only. */
export class EnvelopeError extends Error {
  constructor(
    readonly code: EnvelopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

const SCHEME = 'v1';

/** AES-256-GCM, written `v1.<iv>.<ciphertext>.<tag>` in base64url, bound to `aad`. */
function gcmSeal(key: Buffer, plain: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return [SCHEME, iv, body, cipher.getAuthTag()]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

function gcmOpen(key: Buffer, sealed: string, aad: string): Buffer {
  const [scheme, iv, body, tag] = sealed.split('.');
  if (scheme !== SCHEME || !iv || body === undefined || !tag) {
    throw new EnvelopeError('unreadable', 'The sealed value is not in a known format');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), {
      // Only a whole tag: a truncated one is easier to forge (M1-118, scan triage).
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
  } catch {
    throw new EnvelopeError('unreadable', 'The sealed value does not open with its key');
  }
}

const derive = (secret: Buffer, info: string) =>
  Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));

/** A key-encryption key derived (HKDF-SHA-256) from a secret the operator keeps. */
export class LocalKek implements KeyEncryptionKey {
  private constructor(
    readonly id: string,
    private readonly key: Buffer,
  ) {}

  /**
   * From a master key such as the Builder writes (32 random bytes in base64url) or any secret of
   * 32 characters or more. The id is `<label>:` and a fingerprint that reveals nothing.
   */
  static fromSecret(secret: string | Buffer, label = 'master'): LocalKek {
    const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
    if (bytes.length < 32) throw new Error('A master key needs at least 32 characters');
    const fingerprint = createHash('sha256')
      .update(derive(bytes, 'taskmoor envelope key id'))
      .digest('base64url')
      .slice(0, 12);
    return new LocalKek(
      `${label}:${fingerprint}`,
      derive(bytes, 'taskmoor envelope key-encryption key'),
    );
  }

  /** From a password pepper: its id names the key, as stored hashes name it. */
  static fromPepper(pepper: { id: string; key: Buffer }): LocalKek {
    return new LocalKek(
      `pepper:${pepper.id}`,
      derive(pepper.key, 'taskmoor envelope key-encryption key'),
    );
  }

  async wrap(dataKey: Buffer): Promise<string> {
    return gcmSeal(this.key, dataKey, this.id);
  }

  async unwrap(wrapped: string): Promise<Buffer> {
    return gcmOpen(this.key, wrapped, this.id);
  }
}

/** A key-encryption key held by a key service (KMS or Vault); see `ExternalKeyService`. */
export class ExternalKek implements KeyEncryptionKey {
  readonly id: string;

  constructor(private readonly service: ExternalKeyService) {
    this.id = `${service.kind}:${service.keyRef}`;
  }

  async wrap(dataKey: Buffer): Promise<string> {
    return this.service.encrypt(dataKey);
  }

  async unwrap(wrapped: string): Promise<Buffer> {
    try {
      return Buffer.from(await this.service.decrypt(wrapped));
    } catch (error) {
      throw new EnvelopeError(
        'unreadable',
        `The key service (${this.id}) did not unwrap the data key: ${error instanceof Error ? error.name : 'error'}`,
      );
    }
  }
}

/**
 * The key-encryption keys an install knows: the active one wraps new data keys; older ones
 * (before a rotation) still unwrap until everything is re-wrapped. `lookup` finds keys the ring
 * cannot list ahead of time, such as peppers a restore added.
 */
export class KeyRing {
  private readonly keys = new Map<string, KeyEncryptionKey>();

  constructor(
    readonly active: KeyEncryptionKey | undefined,
    others: readonly KeyEncryptionKey[] = [],
    private readonly lookup?: (id: string) => KeyEncryptionKey | undefined,
  ) {
    for (const key of [...others, ...(active ? [active] : [])]) this.keys.set(key.id, key);
  }

  find(id: string): KeyEncryptionKey | undefined {
    return this.keys.get(id) ?? this.lookup?.(id);
  }
}

/** A sealed secret as stored: which key wrapped its data key, the wrapped key, the ciphertext. */
export interface Envelope {
  kekId: string;
  wrappedKey: string;
  ciphertext: string;
}

/**
 * Seals a secret under a fresh data key. `aad` binds the ciphertext to where it is stored (for
 * example the workspace and slot), so a row copied elsewhere does not open.
 */
export async function sealEnvelope(plain: string, ring: KeyRing, aad: string): Promise<Envelope> {
  const kek = ring.active;
  if (!kek) throw new EnvelopeError('no_active_key', 'No key-encryption key is configured');
  const dataKey = randomBytes(32);
  try {
    return {
      kekId: kek.id,
      wrappedKey: await kek.wrap(dataKey),
      ciphertext: gcmSeal(dataKey, Buffer.from(plain, 'utf8'), aad),
    };
  } finally {
    dataKey.fill(0);
  }
}

async function dataKeyOf(envelope: Envelope, ring: KeyRing): Promise<Buffer> {
  const kek = ring.find(envelope.kekId);
  if (!kek) {
    throw new EnvelopeError(
      'unknown_key',
      `The key-encryption key ${envelope.kekId} is not configured (was the master key changed without TASKMOOR_MASTER_KEY_PREVIOUS?)`,
    );
  }
  return kek.unwrap(envelope.wrappedKey);
}

export async function openEnvelope(
  envelope: Envelope,
  ring: KeyRing,
  aad: string,
): Promise<string> {
  const dataKey = await dataKeyOf(envelope, ring);
  try {
    return gcmOpen(dataKey, envelope.ciphertext, aad).toString('utf8');
  } finally {
    dataKey.fill(0);
  }
}

/**
 * The same secret with its data key wrapped by the ring's active key, or null when it already
 * is. The ciphertext stays as it is.
 */
export async function rewrapEnvelope(envelope: Envelope, ring: KeyRing): Promise<Envelope | null> {
  const active = ring.active;
  if (!active || envelope.kekId === active.id) return null;
  const dataKey = await dataKeyOf(envelope, ring);
  try {
    return { ...envelope, kekId: active.id, wrappedKey: await active.wrap(dataKey) };
  } finally {
    dataKey.fill(0);
  }
}
