import { useMigratedDatabase } from '@taskmoor/db/testing';
import { pepperFromSecret, pepperRing } from '@taskmoor/iam';
import { expectWithinBudget } from '@taskmoor/testkit/budget';
import { verifyInstance } from '@taskmoor/webconfig';
import type { FastifyInstance } from 'fastify';
import { afterAll as after, beforeAll as before, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { IDENTITY_KEY } from '../meta/identity';
import { writeSetting } from '../setup';

/**
 * The public meta endpoint (M1-106; API-017, API-018). Its answer against the published schema
 * is checked by the API contract test; here: what it says, that it holds no secret, that the
 * identity stays put and signs nonces, and that it is fast.
 */
describe('meta endpoint (M1-106)', () => {
  const database = useMigratedDatabase();
  const peppers = pepperRing(pepperFromSecret('a pepper of at least thirty-two bytes, for tests'));
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({
      db: database.db,
      version: '1.4.2',
      roles: ['api'],
      peppers,
      publicUrl: 'https://tracker.example.com/',
    });
    await app.ready();
    await writeSetting(database.db, 'instance', { name: 'Acme tracker' });
    await database.db
      .insertInto('identity_provider')
      .values([
        {
          workspace_id: 1,
          name: 'Corporate SSO',
          kind: 'oidc',
          issuer: 'https://idp.example.com',
          client_id: 'taskmoor-web',
          client_secret_sealed: 'enc1:not-a-real-secret',
          domains: ['example.com'],
        },
        {
          workspace_id: 1,
          name: 'Partner SAML',
          kind: 'saml',
          issuer: 'urn:partner:idp',
          saml_sso_url: 'https://partner.example.org/sso',
          // Not read here; the table wants one.
          saml_certificates: ['-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'],
        },
        {
          workspace_id: 1,
          name: 'Switched off',
          kind: 'oidc',
          issuer: 'https://old.example.com',
          client_id: 'old',
          enabled: false,
        },
      ])
      .execute();
  });
  after(async () => app.close());

  const meta = async (query = '') => {
    const res = await app.inject({ method: 'GET', url: `/api/meta${query}` });
    return { res, body: res.json() };
  };

  it('[API-017] [API-018] answers without signing in: versions, sign-in methods and the instance', async () => {
    const { res, body } = await meta();
    expect(res.statusCode).toBe(200);
    // No Origin, no CORS answer: allowed frontends get theirs (origins.test.ts, M1-107).
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(body).toMatchObject({
      product: 'taskmoor',
      version: '1.4.2',
      api: { version: '1.0.0', base: '/api/v1' },
      frontend: { minimum: '1.3.0', recommended: '1.4.0' },
      instance: { name: 'Acme tracker', keyAlgorithm: 'Ed25519' },
      signIn: {
        password: true,
        providers: [
          {
            name: 'Corporate SSO',
            protocol: 'oidc',
            issuer: 'https://idp.example.com',
            clientId: 'taskmoor-web',
            ssoUrl: null,
            startUrl: expect.stringMatching(
              /^https:\/\/tracker\.example\.com\/api\/v1\/auth\/oidc\/\d+\/start$/,
            ),
          },
          {
            name: 'Partner SAML',
            protocol: 'saml',
            issuer: 'urn:partner:idp',
            clientId: null,
            ssoUrl: 'https://partner.example.org/sso',
          },
        ],
      },
    });
    expect(body.instance.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.instance.keyFingerprint).toMatch(/^SHA256:[A-Za-z0-9_-]{43}$/);
    expect(body.signature).toBeUndefined();
  });

  it('[API-017] (1) holds no secret: no sealed value, no private key', async () => {
    const { res } = await meta('?nonce=no-secret-check-nonce');
    const stored = (
      await database.db
        .selectFrom('instance_setting')
        .select('value')
        .where('key', '=', IDENTITY_KEY)
        .executeTakeFirstOrThrow()
    ).value as { privateKey: string };
    expect(stored.privateKey).toMatch(/^enc1:/);
    for (const secret of ['enc1:', stored.privateKey, 'not-a-real-secret', 'PRIVATE']) {
      expect(res.body).not.toContain(secret);
    }
  });

  it('[API-017] (2) signs a nonce so a kit pinned to this instance can tell it apart', async () => {
    const nonce = 'kit-nonce-0123456789abcdef';
    const { body } = await meta(`?nonce=${nonce}`);
    expect(body.signature.nonce).toBe(nonce);
    const pinned = { id: body.instance.id, publicKey: body.instance.publicKey };
    expect(await verifyInstance(pinned, body, nonce)).toBe(true);
    // A kit pinned to another instance refuses this one.
    expect(
      await verifyInstance({ id: 'another-instance', publicKey: pinned.publicKey }, body, nonce),
    ).toBe(false);
    // The identity outlives the process.
    const again = await buildApp({ db: database.db, version: '1.4.2', roles: ['api'], peppers });
    const second = (await again.inject({ method: 'GET', url: `/api/meta?nonce=${nonce}` })).json();
    await again.close();
    expect(second.instance).toEqual(body.instance);
    expect(await verifyInstance(pinned, second, nonce)).toBe(true);
  });

  it('[API-017] refuses a malformed nonce, and signing without the pepper that sealed the key', async () => {
    for (const nonce of ['short', 'has spaces in it here', 'x'.repeat(129)]) {
      expect((await meta(`?nonce=${encodeURIComponent(nonce)}`)).res.statusCode).toBe(400);
    }
    const other = pepperRing(pepperFromSecret('another pepper of at least thirty-two bytes!'));
    const lost = await buildApp({
      db: database.db,
      version: '1.4.2',
      roles: ['api'],
      peppers: other,
    });
    expect(
      (await lost.inject({ method: 'GET', url: '/api/meta?nonce=lost-pepper-nonce-01' })).json(),
    ).toEqual({ error: 'identity_unavailable' });
    // The public half still answers.
    expect((await lost.inject({ method: 'GET', url: '/api/meta' })).statusCode).toBe(200);
    await lost.close();
  });

  it('[API-018] a development build names no frontend window', async () => {
    const dev = await buildApp({ db: database.db, version: '0.0.0-dev', roles: ['api'] });
    expect((await dev.inject({ method: 'GET', url: '/api/meta' })).json().frontend).toEqual({
      minimum: null,
      recommended: null,
    });
    await dev.close();
  });

  it('[API-017] (3) answers within 100 ms at p95', async () => {
    const times: number[] = [];
    for (let i = 0; i < 60; i++) {
      const start = performance.now();
      await meta(`?nonce=timing-nonce-${String(i).padStart(6, '0')}`);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    expectWithinBudget(times[Math.floor(times.length * 0.95)] as number, 100, 'meta p95 (ms)');
  });

  it('[API-017] keeps an identity written by a restore instead of making a new one', async () => {
    const restored = {
      id: '00000000-0000-4000-8000-000000000001',
      publicKey: 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE',
      privateKey: 'plain:not-used',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await writeSetting(database.db, IDENTITY_KEY, restored);
    const fresh = await buildApp({ db: database.db, version: '1.4.2', roles: ['api'], peppers });
    const body = (await fresh.inject({ method: 'GET', url: '/api/meta' })).json();
    await fresh.close();
    expect(body.instance).toMatchObject({ id: restored.id, publicKey: restored.publicKey });
  });
});
