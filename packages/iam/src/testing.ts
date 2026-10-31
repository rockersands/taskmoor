import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ExternalKeyService } from './envelope';

/**
 * A key service in process, for tests (ADR-098): it holds its own random key, as a KMS or
 * Vault does, wraps what it is given and records the calls so tests can see it only ever
 * receives data keys. `down` makes it fail like an unreachable service.
 */
export class FakeKeyService implements ExternalKeyService {
  readonly kind: 'kms' | 'vault';
  readonly keyRef: string;
  /** Every plaintext the service was asked to encrypt, as received. */
  readonly encrypted: Uint8Array[] = [];
  decryptions = 0;
  down = false;
  private readonly key = randomBytes(32);

  constructor(options: { kind?: 'kms' | 'vault'; keyRef?: string } = {}) {
    this.kind = options.kind ?? 'kms';
    this.keyRef = options.keyRef ?? 'fake-key-1';
  }

  async encrypt(plaintext: Uint8Array): Promise<string> {
    if (this.down) throw new Error('key service unreachable');
    this.encrypted.push(Uint8Array.from(plaintext));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `fake:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
  }

  async decrypt(ciphertext: string): Promise<Uint8Array> {
    if (this.down) throw new Error('key service unreachable');
    this.decryptions += 1;
    const raw = Buffer.from(ciphertext.replace(/^fake:/, ''), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  }
}
