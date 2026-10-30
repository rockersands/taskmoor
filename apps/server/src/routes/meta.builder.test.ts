import { buildKits, generateSecrets, systemRandom, validateInputs } from '@taskmoor/builder-core';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { verifyInstance } from '@taskmoor/webconfig';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';

/**
 * A backend installed from a Builder kit (M1-109; API-017, OPS-014): it serves the kit's
 * instance id and key, so the frontend kit's pinned identity and the meta endpoint agree. A
 * database of its own, since the identity is made once per instance.
 */
describe('meta endpoint with a Builder identity (M1-109)', () => {
  const database = useMigratedDatabase();

  it('[API-017] [OPS-014] serves the identity of the kit it was installed from', async () => {
    const secrets = await generateSecrets(systemRandom);
    const form = validateInputs({
      backendUrl: 'https://api.example.com',
      frontendUrl: 'https://tracker.example.com/',
    });
    if (!form.ok) throw new Error('inputs');
    const kits = await buildKits(
      form.inputs,
      secrets,
      {},
      { backendVersion: '1.4.2', kitVersion: '1.4.2' },
    );
    const app = await buildApp({
      db: database.db,
      version: '1.4.2',
      roles: ['api'],
      instance: { id: secrets.instanceId, seed: secrets.instanceKey.seed },
    });
    const nonce = 'kit-installed-nonce-0001';
    const meta = (await app.inject({ method: 'GET', url: `/api/meta?nonce=${nonce}` })).json();
    await app.close();
    const pinned = {
      id: kits.manifest.manifest.instanceId,
      publicKey: kits.manifest.manifest.publicKey,
    };
    expect(meta.instance).toMatchObject({
      id: pinned.id,
      publicKey: pinned.publicKey,
      keyFingerprint: kits.manifest.manifest.keyFingerprint,
    });
    expect(await verifyInstance(pinned, meta, nonce)).toBe(true);
  });
});
