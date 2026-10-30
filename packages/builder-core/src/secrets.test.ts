import { createPrivateKey, createPublicKey } from 'node:crypto';
import { fc } from '@taskmoor/testkit/property';
import { signedMetaText, verifyInstance } from '@taskmoor/webconfig';
import { describe, expect, it } from 'vitest';
import { fromBase64url, toBase64url, utf8 } from './bytes';
import { seededRandom, systemRandom } from './random';
import { generateSecrets, instancePrivateKey, secretValues } from './secrets';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const seeds = fc.string({ minLength: 16, maxLength: 64 });

describe('generated secrets (M1-109)', () => {
  it('[OPS-014] gives every secret at least 128 bits, in a form the server takes', async () => {
    await fc.assert(
      fc.asyncProperty(seeds, async (seed) => {
        const s = await generateSecrets(seededRandom(seed));
        expect(s.instanceId).toMatch(UUID_V4);
        for (const key of [s.instanceKey.seed, s.passwordPepper, s.tokenSigningKey, s.masterKey]) {
          expect(fromBase64url(key)).toHaveLength(32);
        }
        expect(fromBase64url(s.setupToken)).toHaveLength(32);
        // 32 letters and digits: 32 × log2(62) ≈ 190 bits.
        expect(s.databasePassword).toMatch(/^[A-Za-z0-9]{32}$/);
        // The server wants a pepper of 32 characters or more.
        expect(s.passwordPepper.length).toBeGreaterThanOrEqual(32);
        expect(new Set(secretValues(s)).size).toBe(secretValues(s).length);
      }),
      { numRuns: 30 },
    );
  });

  it('[OPS-014] never repeats a secret across runs, seeded or not', async () => {
    await fc.assert(
      fc.asyncProperty(seeds, seeds, async (a, b) => {
        fc.pre(a !== b);
        const [x, y] = [
          await generateSecrets(seededRandom(a)),
          await generateSecrets(seededRandom(b)),
        ];
        for (const v of secretValues(x)) expect(secretValues(y)).not.toContain(v);
      }),
      { numRuns: 20 },
    );
    const [x, y] = [await generateSecrets(systemRandom), await generateSecrets(systemRandom)];
    for (const v of secretValues(x)) expect(secretValues(y)).not.toContain(v);
  });

  it('[OPS-016] gives the same secrets for the same seed', async () => {
    const seed = 'a seed for a rebuild, long enough';
    expect(await generateSecrets(seededRandom(seed))).toEqual(
      await generateSecrets(seededRandom(seed)),
    );
    expect(() => seededRandom('short')).toThrow(/16 characters/);
  });

  it('[API-017] makes an instance key Node and the meta endpoint agree on', async () => {
    const s = await generateSecrets(systemRandom);
    // Node derives the same public key from the seed, as the server will from the backend kit.
    const pkcs8 = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(fromBase64url(s.instanceKey.seed)),
    ]);
    const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }))
      .export({ type: 'spki', format: 'der' })
      .toString('base64url');
    expect(s.instanceKey.publicKey).toBe(spki);
    // A nonce signed with it passes the frontend's check against the instance.
    const nonce = 'builder-nonce-0123456789';
    const value = await crypto.subtle.sign(
      { name: 'Ed25519' },
      await instancePrivateKey(s.instanceKey.seed),
      utf8(signedMetaText(s.instanceId, nonce)),
    );
    const answer = {
      instance: { id: s.instanceId, publicKey: s.instanceKey.publicKey },
      signature: { value: toBase64url(new Uint8Array(value)) },
    };
    expect(
      await verifyInstance({ id: s.instanceId, publicKey: s.instanceKey.publicKey }, answer, nonce),
    ).toBe(true);
    expect(s.instanceKey.fingerprint).toMatch(/^SHA256:[A-Za-z0-9_-]{43}$/);
  });
});
