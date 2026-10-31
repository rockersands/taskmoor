import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { parseAllowedOrigins } from '../config';
import { frontendOrigin, frontendRedirectUri } from '../network/frontends';
import { WEB_CLIENT_ID } from '../oauth/tokens';

const PUBLIC_URL = 'https://api.example.com';
/** Listed in the environment, as TASKMOOR_ALLOWED_ORIGINS would. */
const LISTED = 'https://listed.example.org';
/** Registered by an administrator during the tests. */
const NEW = 'https://second.example.net';
const PASSWORD = 'harbour lantern willow';
let address = 0;
const nextAddress = () => `100.81.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    list
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
      ?.split(';')[0] ?? ''
  );
}

/** What a WebSocket handshake ends in: 101 when it opened, the HTTP status when refused. */
function handshake(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('open', () => {
      resolve(101);
      ws.close();
    });
    ws.on('error', () => resolve(-1));
  });
}

describe('frontend origin rules (M1-108)', () => {
  it('[IAM-025] takes exact https origins, http only for this machine, no paths or wildcards', () => {
    expect(frontendOrigin('https://Tracker.Example.com')).toBe('https://tracker.example.com');
    expect(frontendOrigin('https://tracker.example.com:443/')).toBe('https://tracker.example.com');
    expect(frontendOrigin('https://tracker.example.com:8443')).toBe(
      'https://tracker.example.com:8443',
    );
    expect(frontendOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(frontendOrigin('http://app.taskmoor.localhost:4181')).toBe(
      'http://app.taskmoor.localhost:4181',
    );
    expect(frontendOrigin('http://127.0.0.1:4182')).toBe('http://127.0.0.1:4182');
    for (const bad of [
      'http://tracker.example.com',
      'https://*.example.com',
      'https://%2A.example.com',
      '*',
      'https://tracker.example.com/app',
      'https://tracker.example.com/?x=1',
      'https://tracker.example.com/?',
      'https://tracker.example.com/#',
      'https://user@tracker.example.com',
      'ftp://tracker.example.com',
      'tracker.example.com',
      'null',
      '',
    ]) {
      expect(frontendOrigin(bad), bad).toBeNull();
    }
    // The environment's list follows the same rule.
    expect(() => parseAllowedOrigins('https://*.example.com')).toThrow(/TASKMOOR_ALLOWED_ORIGINS/);
  });

  it('[IAM-025] takes redirect URIs on the frontend’s own origin only, without a fragment', () => {
    expect(frontendRedirectUri('https://a.example.com/tracker/', 'https://a.example.com')).toBe(
      'https://a.example.com/tracker/',
    );
    expect(frontendRedirectUri('https://b.example.com/', 'https://a.example.com')).toBeNull();
    expect(frontendRedirectUri('https://a.example.com/#x', 'https://a.example.com')).toBeNull();
    expect(frontendRedirectUri('https://u@a.example.com/', 'https://a.example.com')).toBeNull();
  });
});

/**
 * Registered frontends (M1-108; IAM-025, OPS-017; ADR-087): a site administrator adds a
 * frontend's origin and it works at once, over CORS, OAuth sign-in and both sockets, with no
 * restart; removed, it is refused again. The environment's list keeps working beside it.
 */
describe('registered frontend origins (M1-108)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  /** A second process on the same database, like another API replica. */
  let replica: FastifyInstance;
  let base = '';
  let admin = '';
  let member = '';

  const call = (options: InjectOptions, on = app) =>
    on.inject({ remoteAddress: nextAddress(), ...options });
  const asAdmin = (options: InjectOptions) =>
    call({ ...options, headers: { cookie: admin, ...options.headers } });

  const meta = (origin: string, on = app, query = '') =>
    call({ method: 'GET', url: `/api/meta${query}`, headers: { origin } }, on);

  function authorize(redirectUri: string) {
    const challenge = createHash('sha256')
      .update(randomBytes(32).toString('base64url'))
      .digest('base64url');
    return asAdmin({
      method: 'GET',
      url: `/api/v1/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: WEB_CLIENT_ID,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
    });
  }

  async function signIn(email: string): Promise<string> {
    const res = await call({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    return sessionCookie(res.headers['set-cookie']);
  }

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      version: '1.4.2',
      roles: ['api', 'realtime'],
      publicUrl: PUBLIC_URL,
      allowedOrigins: [LISTED],
    });
    replica = await buildApp({
      db: database.db,
      version: '1.4.2',
      roles: ['api'],
      publicUrl: PUBLIC_URL,
      allowedOrigins: [LISTED],
      originsTtlMs: 50,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const hash = await hashPassword(PASSWORD);
    await database.db
      .insertInto('app_user')
      .values([
        { workspace_id: 1, email: 'ada@example.com', name: 'Ada', password_hash: hash },
        { workspace_id: 1, email: 'bo@example.com', name: 'Bo', password_hash: hash },
      ])
      .execute();
    await database.db
      .updateTable('app_user')
      .set({ is_site_admin: true })
      .where('email', '=', 'ada@example.com')
      .execute();
    admin = await signIn('ada@example.com');
    member = await signIn('bo@example.com');
  });

  afterAll(async () => {
    await app.close();
    await replica.close();
  });

  it('[OPS-017] (1) a new origin works without a restart and stops when removed: CORS', async () => {
    expect((await meta(NEW)).statusCode).toBe(403);
    expect((await meta(NEW, replica)).statusCode).toBe(403);

    const added = await asAdmin({
      method: 'POST',
      url: '/api/v1/admin/frontends',
      payload: { origin: `${NEW}/`, label: 'Second kit' },
    });
    expect(added.statusCode, added.body).toBe(201);
    const frontend = added.json().frontend;
    expect(frontend).toMatchObject({
      origin: NEW,
      label: 'Second kit',
      redirectUris: [`${NEW}/`],
      websocket: true,
      lastVersion: null,
      addedBy: { name: 'Ada' },
      inEnvironment: false,
    });

    // At once in the process that made the change...
    const now = await meta(NEW);
    expect(now.statusCode).toBe(200);
    expect(now.headers['access-control-allow-origin']).toBe(NEW);
    const preflight = await call({
      method: 'OPTIONS',
      url: '/api/v1/tickets',
      headers: { origin: NEW, 'access-control-request-method': 'POST' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(NEW);
    // ...and in another process within its TTL, without a restart.
    await expect
      .poll(async () => (await meta(NEW, replica)).statusCode, { timeout: 2000 })
      .toBe(200);

    const removed = await asAdmin({
      method: 'DELETE',
      url: `/api/v1/admin/frontends/${frontend.id}`,
    });
    expect(removed.statusCode).toBe(204);
    const refused = await meta(NEW);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'origin_not_allowed' });
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
    await expect
      .poll(async () => (await meta(NEW, replica)).statusCode, { timeout: 2000 })
      .toBe(403);
    // The environment's list is untouched.
    expect((await meta(LISTED)).headers['access-control-allow-origin']).toBe(LISTED);
  });

  it('[IAM-025] OAuth sign-in returns only to a registered frontend’s exact URIs', async () => {
    const target = 'https://oauth.example.net';
    const app2 = `${target}/app/`;
    expect((await authorize(app2)).statusCode).toBe(400);
    const added = await asAdmin({
      method: 'POST',
      url: '/api/v1/admin/frontends',
      payload: { origin: target, redirectUris: [app2] },
    });
    expect(added.statusCode, added.body).toBe(201);
    const id = added.json().frontend.id;
    const granted = await authorize(app2);
    expect(granted.statusCode).toBe(302);
    const back = new URL(String(granted.headers.location));
    expect(`${back.origin}${back.pathname}`).toBe(app2);
    expect(back.searchParams.get('code')).toBeTruthy();
    // Not its root: only the URIs it lists.
    expect((await authorize(`${target}/`)).statusCode).toBe(400);

    // Changed to the root, the old URI stops at once.
    const changed = await asAdmin({
      method: 'PATCH',
      url: `/api/v1/admin/frontends/${id}`,
      payload: { redirectUris: [`${target}/`] },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await authorize(app2)).statusCode).toBe(400);
    expect((await authorize(`${target}/`)).statusCode).toBe(302);

    await asAdmin({ method: 'DELETE', url: `/api/v1/admin/frontends/${id}` });
    expect((await authorize(`${target}/`)).statusCode).toBe(400);
    // The environment's frontend keeps its root.
    expect((await authorize(`${LISTED}/`)).statusCode).toBe(302);
  });

  it('[IAM-025] both sockets follow the list and the frontend’s socket grant', async () => {
    const target = 'https://sockets.example.net';
    const sync = `ws://${base}/api/v1/sync/socket`;
    const collab = `ws://${base}/api/v1/collab`;
    const both = async () => [
      await handshake(sync, { cookie: admin, origin: target }),
      await handshake(collab, { cookie: admin, origin: target }),
    ];
    expect(await both()).toEqual([403, 403]);
    const added = await asAdmin({
      method: 'POST',
      url: '/api/v1/admin/frontends',
      payload: { origin: target },
    });
    const id = added.json().frontend.id;
    expect(await both()).toEqual([101, 101]);

    // Kept off the sockets: HTTP still works, the handshakes do not.
    const off = await asAdmin({
      method: 'PATCH',
      url: `/api/v1/admin/frontends/${id}`,
      payload: { websocket: false },
    });
    expect(off.json().frontend.websocket).toBe(false);
    expect(await both()).toEqual([403, 403]);
    expect((await meta(target)).statusCode).toBe(200);

    await asAdmin({
      method: 'PATCH',
      url: `/api/v1/admin/frontends/${id}`,
      payload: { websocket: true },
    });
    expect(await both()).toEqual([101, 101]);
    await asAdmin({ method: 'DELETE', url: `/api/v1/admin/frontends/${id}` });
    expect(await both()).toEqual([403, 403]);
    // The environment's frontend still opens both.
    expect(await handshake(sync, { cookie: admin, origin: LISTED })).toBe(101);
    expect(await handshake(collab, { cookie: admin, origin: LISTED })).toBe(101);
  });

  it('[OPS-017] lists the frontends with the versions they report', async () => {
    const target = 'https://versions.example.net';
    const added = await asAdmin({
      method: 'POST',
      url: '/api/v1/admin/frontends',
      payload: { origin: target, label: 'Versions', redirectUris: [], websocket: false },
    });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json().frontend.redirectUris).toEqual([]);
    // The frontend reads the meta endpoint with its version.json's version.
    expect((await meta(target, app, '?frontend=1.3.0')).statusCode).toBe(200);
    // A version nobody could ship, and a frontend outside the list, are not written down.
    await meta(target, app, `?frontend=${encodeURIComponent('<script>')}`);
    await meta('https://stranger.example.net', app, '?frontend=9.9.9');
    await meta(LISTED, app, '?frontend=1.4.2');

    const list = await asAdmin({ method: 'GET', url: '/api/v1/admin/frontends' });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.self).toEqual({ origin: PUBLIC_URL, servedVersion: null });
    expect(body.backend).toEqual({
      version: '1.4.2',
      frontend: { minimum: '1.3.0', recommended: '1.4.0' },
    });
    expect(body.environment).toEqual([{ origin: LISTED, redirectUris: [`${LISTED}/`] }]);
    const row = body.frontends.find((f: { origin: string }) => f.origin === target);
    expect(row).toMatchObject({ label: 'Versions', lastVersion: '1.3.0', websocket: false });
    expect(Date.parse(row.lastSeenAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(
      body.frontends.some((f: { origin: string }) => f.origin === 'https://stranger.example.net'),
    ).toBe(false);

    // A newer version is written at once.
    await meta(target, app, '?frontend=1.4.2');
    const again = await asAdmin({ method: 'GET', url: '/api/v1/admin/frontends' });
    expect(
      again.json().frontends.find((f: { origin: string }) => f.origin === target).lastVersion,
    ).toBe('1.4.2');

    // An origin the environment lists too is marked, so removing it is understood.
    const both = await asAdmin({
      method: 'POST',
      url: '/api/v1/admin/frontends',
      payload: { origin: LISTED, label: 'Also listed' },
    });
    expect(both.json().frontend.inEnvironment).toBe(true);
    await meta(LISTED, app, '?frontend=1.4.2');
    const listed = await asAdmin({ method: 'GET', url: '/api/v1/admin/frontends' });
    expect(
      listed.json().frontends.find((f: { origin: string }) => f.origin === LISTED).lastVersion,
    ).toBe('1.4.2');
    await asAdmin({ method: 'DELETE', url: `/api/v1/admin/frontends/${both.json().frontend.id}` });
    expect((await meta(LISTED)).statusCode).toBe(200);
  });

  it('[IAM-025] refuses bad origins, duplicates, this server’s own origin and other people', async () => {
    const add = (payload: object) =>
      asAdmin({ method: 'POST', url: '/api/v1/admin/frontends', payload });
    for (const origin of [
      'https://*.example.com',
      'http://tracker.example.com',
      'https://tracker.example.com/app',
    ]) {
      const res = await add({ origin });
      expect(res.statusCode, origin).toBe(400);
      expect(res.json()).toEqual({
        error: 'invalid_request',
        fields: { origin: 'invalid_origin' },
      });
    }
    expect((await add({ origin: PUBLIC_URL })).json().fields).toEqual({ origin: 'own_origin' });
    const elsewhere = await add({
      origin: 'https://dup.example.net',
      redirectUris: ['https://dup.example.net/', 'https://other.example.net/'],
    });
    expect(elsewhere.json().fields).toEqual({ 'redirectUris.1': 'invalid_redirect_uri' });
    expect((await add({ origin: 'https://dup.example.net' })).statusCode).toBe(201);
    const duplicate = await add({ origin: 'https://DUP.example.net/' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: 'origin_exists' });

    for (const options of [
      { method: 'GET', url: '/api/v1/admin/frontends' },
      { method: 'POST', url: '/api/v1/admin/frontends', payload: { origin: 'https://x.example' } },
      { method: 'DELETE', url: '/api/v1/admin/frontends/1' },
    ] as InjectOptions[]) {
      const res = await call({ ...options, headers: { cookie: member } });
      expect(res.statusCode, options.url as string).toBe(403);
    }
    expect(
      (await asAdmin({ method: 'DELETE', url: '/api/v1/admin/frontends/999999' })).statusCode,
    ).toBe(404);
  });
});
