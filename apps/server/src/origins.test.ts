import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { buildApp } from './app';
import { SESSION_COOKIE } from './auth';
import { WEB_CLIENT_ID } from './oauth/tokens';

const PUBLIC_URL = 'https://api.example.com';
const FRONTEND = 'https://tracker.example.org';
/** A sibling subdomain the install does not list: same site, so the Lax cookie travels. */
const SIBLING = 'https://evil.example.com';
const PASSWORD = 'quartz willow ember';
let address = 0;
const nextAddress = () => `100.80.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

/** The first message a socket gets, or its close code when it closes first. */
function firstWord(ws: WebSocket): Promise<{ message?: Record<string, unknown>; code?: number }> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve({ message: JSON.parse(String(data)) }));
    ws.once('close', (code) => resolve({ code }));
  });
}

/**
 * Strict CORS, the origin check and the WebSocket origin checks (M1-107; IAM-025, ADR-080):
 * only this instance's origin and its listed frontends get in, over HTTP and both sockets, and
 * a frontend on another site opens the sockets with its OAuth access token.
 */
describe('origins: CORS, the origin check and WebSockets (M1-107)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let base = '';
  let cookie = '';
  let access = '';
  let ticketId = 0;

  const call = (options: InjectOptions) => app.inject({ remoteAddress: nextAddress(), ...options });

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api', 'realtime'],
      publicUrl: PUBLIC_URL,
      allowedOrigins: [FRONTEND],
      collabDebounceMs: 30,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'ada@example.com',
        name: 'Ada',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .execute();
    const signedIn = await call({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'ada@example.com', password: PASSWORD },
    });
    const set = [signedIn.headers['set-cookie'] ?? []].flat();
    cookie = set.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0] ?? '';
    const track = await call({
      method: 'POST',
      url: '/api/v1/tracks',
      headers: { cookie },
      payload: { key: 'ORI', name: 'Origins', mode: 'shared' },
    });
    expect(track.statusCode, track.body).toBe(201);
    const ticket = await call({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: { cookie },
      payload: { track: 'ORI', summary: 'Edited from another site' },
    });
    ticketId = ticket.json().ticket.id;
    // An access token for the frontend, through the code flow.
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorized = await call({
      method: 'GET',
      url: `/api/v1/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: WEB_CLIENT_ID,
        redirect_uri: `${FRONTEND}/`,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
      headers: { cookie },
    });
    const code = new URL(authorized.headers.location as string).searchParams.get('code');
    const tokens = await call({
      method: 'POST',
      url: '/api/v1/oauth/token',
      headers: { origin: FRONTEND },
      payload: {
        grant_type: 'authorization_code',
        client_id: WEB_CLIENT_ID,
        code,
        redirect_uri: `${FRONTEND}/`,
        code_verifier: verifier,
      },
    });
    access = tokens.json().access_token;
    expect(access).toBeTruthy();
  });

  afterAll(async () => {
    await app.close();
  });

  it('[IAM-025] (1) a request from an unlisted origin gets no CORS approval', async () => {
    for (const origin of [SIBLING, 'https://tracker.example.org.evil.test', 'null']) {
      const res = await call({ method: 'GET', url: '/api/meta', headers: { origin } });
      expect(res.statusCode, origin).toBe(403);
      expect(res.json()).toEqual({ error: 'origin_not_allowed' });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      const preflight = await call({
        method: 'OPTIONS',
        url: '/api/v1/tickets',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
      expect(preflight.statusCode, origin).toBe(403);
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('[API-017] (3) the listed frontend gets CORS approval for its exact origin', async () => {
    const meta = await call({ method: 'GET', url: '/api/meta', headers: { origin: FRONTEND } });
    expect(meta.statusCode).toBe(200);
    expect(meta.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(meta.headers['access-control-allow-credentials']).toBe('true');
    expect(meta.headers.vary).toContain('Origin');
    const preflight = await call({
      method: 'OPTIONS',
      url: '/api/v1/tickets/ORI-1',
      headers: {
        origin: FRONTEND,
        'access-control-request-method': 'PATCH',
        'access-control-request-headers':
          'authorization, content-type, taskmoor-mutation-id, taskmoor-time-zone',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(preflight.headers['access-control-allow-methods']).toContain('PATCH');
    // The web app sends the browser's time zone on every request (T-272).
    for (const header of [
      'authorization',
      'content-type',
      'taskmoor-mutation-id',
      'taskmoor-time-zone',
    ]) {
      expect(preflight.headers['access-control-allow-headers']).toContain(header);
    }
    // This instance's own pages need no CORS: same origin.
    const own = await call({ method: 'GET', url: '/api/meta', headers: { origin: PUBLIC_URL } });
    expect(own.statusCode).toBe(200);
    expect(own.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('[IAM-025] refuses changes from other origins even with the session cookie (sibling subdomains)', async () => {
    const create = (origin: string) =>
      call({
        method: 'POST',
        url: '/api/v1/tickets',
        headers: { cookie, origin },
        payload: { track: 'ORI', summary: `From ${origin}` },
      });
    const sibling = await create(SIBLING);
    expect(sibling.statusCode).toBe(403);
    expect(sibling.json()).toEqual({ error: 'origin_not_allowed' });
    // The listed sibling frontend uses the same cookie (IAM-024: the same-site layout).
    const listed = await create(FRONTEND);
    expect(listed.statusCode, listed.body).toBe(201);
    expect(listed.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect((await create(PUBLIC_URL)).statusCode).toBe(201);
    // Behind a proxy that keeps the host, the page's own origin is the host's.
    const proxied = await call({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: { cookie, origin: 'http://intranet.local:8080', host: 'intranet.local:8080' },
      payload: { track: 'ORI', summary: 'Through a proxy' },
    });
    expect(proxied.statusCode).toBe(201);
    // Programs send no Origin and are left to their credentials.
    const program = await call({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: { cookie },
      payload: { track: 'ORI', summary: 'From a program' },
    });
    expect(program.statusCode).toBe(201);
  });

  it('[IAM-025] lets a SAML provider’s form post through, which carries its own proof', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/auth/saml/1/acs',
      headers: {
        origin: 'https://idp.example.net',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'SAMLResponse=bm90aGluZw',
    });
    expect(res.statusCode).not.toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('[IAM-025] the sync socket refuses other origins and lets a bearer socket sign in', async () => {
    const sync = `ws://${base}/api/v1/sync/socket`;
    expect(await handshake(sync, { cookie, origin: SIBLING })).toBe(403);
    expect(await handshake(sync, { cookie, origin: FRONTEND })).toBe(101);
    // A frontend on another site has no cookie here: its first message is its access token.
    const bearer = new WebSocket(`${sync}?auth=bearer`, { headers: { origin: FRONTEND } });
    await new Promise((resolve) => bearer.once('open', resolve));
    const answer = firstWord(bearer);
    bearer.send(JSON.stringify({ type: 'auth', token: access }));
    expect((await answer).message).toMatchObject({ type: 'position' });
    bearer.terminate();
    const forged = new WebSocket(`${sync}?auth=bearer`, { headers: { origin: FRONTEND } });
    await new Promise((resolve) => forged.once('open', resolve));
    const refused = firstWord(forged);
    forged.send(JSON.stringify({ type: 'auth', token: 'tma_forged' }));
    expect((await refused).code).toBe(4401);
  });

  it('[IAM-025] co-editing refuses other origins and admits a bearer socket by its token', async () => {
    const collab = `ws://${base}/api/v1/collab`;
    expect(await handshake(collab, { cookie, origin: SIBLING })).toBe(403);
    expect(await handshake(collab, { cookie, origin: FRONTEND })).toBe(101);
    // Without a cookie and without asking for bearer sign-in: refused as before.
    expect(await handshake(collab, { origin: FRONTEND })).toBe(401);
    expect(await handshake(`${collab}?auth=bearer`, { origin: SIBLING })).toBe(403);

    const open = (token: string) => {
      class FromFrontend extends WebSocket {
        constructor(target: string) {
          super(target, { headers: { origin: FRONTEND } });
        }
      }
      const websocketProvider = new HocuspocusProviderWebsocket({
        url: `${collab}?auth=bearer`,
        WebSocketPolyfill: FromFrontend,
        maxAttempts: 1,
      });
      const refused: string[] = [];
      const provider = new HocuspocusProvider({
        websocketProvider,
        name: `ticket/${ticketId}/description`,
        document: new Y.Doc(),
        token,
        onAuthenticationFailed: ({ reason }) => refused.push(reason),
      });
      provider.attach();
      return { provider, websocketProvider, refused };
    };
    const editor = open(access);
    await expect.poll(() => editor.provider.isSynced, { timeout: 5000 }).toBe(true);
    editor.provider.destroy();
    editor.websocketProvider.destroy();
    const stranger = open('tma_forged');
    await expect.poll(() => stranger.refused.length, { timeout: 5000 }).toBe(1);
    stranger.provider.destroy();
    stranger.websocketProvider.destroy();
  });
});
