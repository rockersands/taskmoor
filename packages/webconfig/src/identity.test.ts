import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signedMetaText, verifyInstance } from './identity';

function instance(id: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    id,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    answer(nonce: string) {
      const value = sign(null, Buffer.from(signedMetaText(id, nonce)), privateKey).toString(
        'base64url',
      );
      return { instance: { id, publicKey: this.publicKey }, signature: { value } };
    },
  };
}

describe('instance identity', () => {
  const nonce = 'n0nce-of-twenty-chars';

  it('[API-017] accepts the pinned instance’s signature over the nonce sent', async () => {
    const a = instance('a1');
    expect(await verifyInstance(a, a.answer(nonce), nonce)).toBe(true);
  });

  it('[API-017] refuses another instance, another nonce or a forged signature', async () => {
    const a = instance('a1');
    const b = instance('b2');
    // A frontend built for A, talking to B.
    expect(await verifyInstance(a, b.answer(nonce), nonce)).toBe(false);
    // B claiming A's id and key, signing with its own private key.
    const claimed = {
      instance: { id: a.id, publicKey: a.publicKey },
      signature: b.answer(nonce).signature,
    };
    expect(await verifyInstance(a, claimed, nonce)).toBe(false);
    // A replayed answer to another nonce.
    expect(await verifyInstance(a, a.answer('another-nonce-value'), nonce)).toBe(false);
    expect(await verifyInstance(a, { ...a.answer(nonce), signature: null }, nonce)).toBe(false);
    expect(await verifyInstance(a, { ...a.answer(nonce), signature: { value: '!!' } }, nonce)).toBe(
      false,
    );
  });
});
