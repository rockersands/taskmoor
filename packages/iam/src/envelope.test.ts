import { randomBytes } from 'node:crypto';
import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  EnvelopeError,
  ExternalKek,
  KeyRing,
  LocalKek,
  openEnvelope,
  rewrapEnvelope,
  sealEnvelope,
} from './envelope';
import { pepperFromSecret } from './password';
import { FakeKeyService } from './testing';

/** A master key as the Builder writes it: 32 random bytes in base64url, made at run time. */
const masterKey = () => randomBytes(32).toString('base64url');
/** A provider credential shaped so no secret scanner mistakes it for a real one. */
const fakeKey = () => `fake-ai-key-${randomBytes(18).toString('hex')}`;

describe('envelope encryption (IAM-020, ADR-098)', () => {
  it('[IAM-020] seals each secret under its own data key, wrapped by the master key', async () => {
    const ring = new KeyRing(LocalKek.fromSecret(masterKey()));
    const secret = fakeKey();
    const a = await sealEnvelope(secret, ring, 'ws1:apiKey');
    const b = await sealEnvelope(secret, ring, 'ws1:apiKey');
    expect(a.kekId).toMatch(/^master:[A-Za-z0-9_-]{12}$/);
    // Fresh data key and nonce each time: the same secret never looks the same twice.
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    for (const part of [a.kekId, a.wrappedKey, a.ciphertext]) expect(part).not.toContain(secret);
    expect(await openEnvelope(a, ring, 'ws1:apiKey')).toBe(secret);
  });

  it('[IAM-020] refuses a sealed value moved to another slot, tampered with, or under another key', async () => {
    const ring = new KeyRing(LocalKek.fromSecret(masterKey()));
    const sealed = await sealEnvelope(fakeKey(), ring, 'ws1:apiKey');
    await expect(openEnvelope(sealed, ring, 'ws2:apiKey')).rejects.toThrow(EnvelopeError);
    const flipped = `${sealed.ciphertext.slice(0, -2)}${sealed.ciphertext.endsWith('A') ? 'B' : 'A'}A`;
    await expect(
      openEnvelope({ ...sealed, ciphertext: flipped }, ring, 'ws1:apiKey'),
    ).rejects.toThrow(EnvelopeError);
    const other = new KeyRing(LocalKek.fromSecret(masterKey()));
    await expect(openEnvelope(sealed, other, 'ws1:apiKey')).rejects.toMatchObject({
      code: 'unknown_key',
    });
    await expect(sealEnvelope('x', new KeyRing(undefined), 'a')).rejects.toMatchObject({
      code: 'no_active_key',
    });
  });

  it('[IAM-020] refuses a sealed value whose tag was cut short (M1-118)', async () => {
    const ring = new KeyRing(LocalKek.fromSecret(masterKey()));
    const sealed = await sealEnvelope(fakeKey(), ring, 'ws1:apiKey');
    const parts = sealed.ciphertext.split('.');
    const tag = Buffer.from(parts[3] as string, 'base64url');
    parts[3] = tag.subarray(0, 4).toString('base64url');
    await expect(
      openEnvelope({ ...sealed, ciphertext: parts.join('.') }, ring, 'ws1:apiKey'),
    ).rejects.toThrow(EnvelopeError);
  });

  it('[IAM-020] names keys by a fingerprint that reveals nothing, the same for the same key', () => {
    const key = masterKey();
    const kek = LocalKek.fromSecret(key);
    expect(LocalKek.fromSecret(key).id).toBe(kek.id);
    expect(kek.id).not.toContain(key.slice(0, 8));
    expect(LocalKek.fromSecret(masterKey()).id).not.toBe(kek.id);
    expect(() => LocalKek.fromSecret('too short')).toThrow(/32/);
    const pepper = pepperFromSecret(randomBytes(32));
    expect(LocalKek.fromPepper(pepper).id).toBe(`pepper:${pepper.id}`);
  });

  it('[IAM-020] rotates the master key by re-wrapping data keys; the old key is then not needed', async () => {
    const oldKek = LocalKek.fromSecret(masterKey());
    const newKek = LocalKek.fromSecret(masterKey());
    const secret = fakeKey();
    const sealed = await sealEnvelope(secret, new KeyRing(oldKek), 'ws1:apiKey');
    const during = new KeyRing(newKek, [oldKek]);
    expect(await openEnvelope(sealed, during, 'ws1:apiKey')).toBe(secret);
    const rewrapped = await rewrapEnvelope(sealed, during);
    expect(rewrapped?.kekId).toBe(newKek.id);
    expect(rewrapped?.ciphertext).toBe(sealed.ciphertext);
    expect(await rewrapEnvelope(rewrapped ?? sealed, during)).toBeNull();
    expect(await openEnvelope(rewrapped ?? sealed, new KeyRing(newKek), 'ws1:apiKey')).toBe(secret);
  });

  it('[IAM-020] plugs in a key service (KMS or Vault) that only ever sees data keys', async () => {
    const kms = new FakeKeyService({ kind: 'kms', keyRef: 'arn:aws:kms:eu-west-1:000:key/test' });
    const ring = new KeyRing(new ExternalKek(kms));
    const secret = fakeKey();
    const sealed = await sealEnvelope(secret, ring, 'ws1:apiKey');
    expect(sealed.kekId).toBe('kms:arn:aws:kms:eu-west-1:000:key/test');
    expect(kms.encrypted.map((b) => b.length)).toEqual([32]);
    expect(Buffer.from(kms.encrypted[0] ?? []).toString('utf8')).not.toContain(secret);
    expect(await openEnvelope(sealed, ring, 'ws1:apiKey')).toBe(secret);
    expect(kms.decryptions).toBe(1);
    // From the master key to Vault: re-wrapping moves every data key, secrets stay the same.
    const local = LocalKek.fromSecret(masterKey());
    const before = await sealEnvelope(secret, new KeyRing(local), 'ws1:apiKey');
    const vault = new ExternalKek(new FakeKeyService({ kind: 'vault', keyRef: 'taskmoor' }));
    const moved = await rewrapEnvelope(before, new KeyRing(vault, [local]));
    expect(moved?.kekId).toBe('vault:taskmoor');
    expect(await openEnvelope(moved ?? before, new KeyRing(vault), 'ws1:apiKey')).toBe(secret);
    kms.down = true;
    await expect(openEnvelope(sealed, ring, 'ws1:apiKey')).rejects.toMatchObject({
      code: 'unreadable',
    });
  });

  it('[IAM-020] opens whatever it sealed (property)', async () => {
    const ring = new KeyRing(LocalKek.fromSecret(masterKey()));
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 500 }),
        fc.string({ maxLength: 40 }),
        async (s, aad) => {
          expect(await openEnvelope(await sealEnvelope(s, ring, aad), ring, aad)).toBe(s);
        },
      ),
    );
  });
});
