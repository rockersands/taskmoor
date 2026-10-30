import { createHash, randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX, WEB_CLIENT_ID } from '../oauth/tokens';

const PUBLIC_URL = 'https://api.example.com';
const FRONTEND = 'https://tracker.example.org';
const REDIRECT = `${FRONTEND}/`;
const PASSWORD = 'lantern copper meadow';
let address = 0;
const nextAddress = () => `100.79.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    list
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
      ?.split(';')[0] ?? ''
  );
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * OAuth 2.1 with PKCE for frontends on another site (M1-107; IAM-024, API-002, ADR-080): the
 * code flow through this backend's own sign-in, short-lived bearer tokens, refresh rotation and
 * reuse detection that signs the person out.
 */
describe('OAuth sign-in for a frontend on another site (M1-107)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;

  const call = (options: InjectOptions) => app.inject({ remoteAddress: nextAddress(), ...options });

  async function signIn(email = 'ada@example.com'): Promise<string> {
    const res = await call({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    return sessionCookie(res.headers['set-cookie']);
  }

  function authorizeUrl(challenge: string, extra: Record<string, string> = {}) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: WEB_CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      ...extra,
    });
    return `/api/v1/oauth/authorize?${params}`;
  }

  async function code(cookie: string, challenge: string): Promise<string> {
    const res = await call({ method: 'GET', url: authorizeUrl(challenge), headers: { cookie } });
    expect(res.statusCode, res.body).toBe(302);
    const back = new URL(res.headers.location as string);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    return back.searchParams.get('code') as string;
  }

  const token = (form: Record<string, string>) =>
    call({
      method: 'POST',
      url: '/api/v1/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: FRONTEND },
      payload: new URLSearchParams({ client_id: WEB_CLIENT_ID, ...form }).toString(),
    });

  async function signInThroughOAuth(cookie?: string) {
    const browser = cookie ?? (await signIn());
    const { verifier, challenge } = pkce();
    const res = await token({
      grant_type: 'authorization_code',
      code: await code(browser, challenge),
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(res.statusCode, res.body).toBe(200);
    return { cookie: browser, tokens: res.json() as Tokens };
  }

  const asBearer = (
    access: string,
    options: InjectOptions = { method: 'GET', url: '/api/v1/session' },
  ) =>
    call({
      ...options,
      headers: { ...(options.headers ?? {}), authorization: `Bearer ${access}`, origin: FRONTEND },
    });

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      version: 'test',
      publicUrl: PUBLIC_URL,
      allowedOrigins: [FRONTEND],
      accessTokenTtlMs: 1500,
    });
    await app.ready();
    for (const email of ['ada@example.com', 'bo@example.com']) {
      await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email,
          name: email.split('@')[0] as string,
          password_hash: await hashPassword(PASSWORD),
          is_site_admin: false,
        })
        .execute();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('[IAM-024] signs a frontend in with a code and PKCE, and calls the API with the bearer token', async () => {
    const cookie = await signIn();
    const { verifier, challenge } = pkce();
    const res = await call({ method: 'GET', url: authorizeUrl(challenge), headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers['cache-control']).toBe('no-store');
    const back = new URL(res.headers.location as string);
    expect(back.searchParams.get('state')).toBe('xyz');
    // RFC 9207: the answer names who issued it.
    expect(back.searchParams.get('iss')).toBe(PUBLIC_URL);
    const exchanged = await token({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') as string,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    expect(exchanged.headers['access-control-allow-origin']).toBe(FRONTEND);
    const tokens = exchanged.json() as Tokens;
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(tokens.refresh_token.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
    expect(tokens.expires_in).toBeGreaterThan(0);
    const me = await asBearer(tokens.access_token);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ user: expect.objectContaining({ email: 'ada@example.com' }) });
    // The family is a session of its own, started by OAuth, under the browser's session.
    const family = await database.db
      .selectFrom('user_session')
      .select(['client_id', 'parent_id', 'token_hash'])
      .where('client_id', '=', WEB_CLIENT_ID)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(family.token_hash).toBeNull();
    expect(family.parent_id).not.toBeNull();
    const event = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload'])
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({ type: 'session.started', payload: { method: 'oauth' } });
  });

  it('[IAM-024] sends a browser that is not signed in to this backend’s sign-in page and back', async () => {
    const { challenge } = pkce();
    const res = await call({ method: 'GET', url: authorizeUrl(challenge) });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location.startsWith(`${PUBLIC_URL}/#/sign-in?continue=`)).toBe(true);
    const back = decodeURIComponent(location.split('continue=')[1] ?? '');
    expect(back).toBe(authorizeUrl(challenge));
  });

  it('[IAM-025] never redirects to an address that is not registered, and requires PKCE', async () => {
    const cookie = await signIn();
    const { challenge } = pkce();
    for (const redirect of [
      'https://evil.example/',
      `${FRONTEND}/other`,
      'https://tracker.example.org',
    ]) {
      const res = await call({
        method: 'GET',
        url: authorizeUrl(challenge, { redirect_uri: redirect }),
        headers: { cookie },
      });
      expect(res.statusCode, redirect).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
    const wrongClient = await call({
      method: 'GET',
      url: authorizeUrl(challenge, { client_id: 'someone-else' }),
      headers: { cookie },
    });
    expect(wrongClient.statusCode).toBe(400);
    const plain = await call({
      method: 'GET',
      url: authorizeUrl(challenge, { code_challenge_method: 'plain' }),
      headers: { cookie },
    });
    expect(plain.statusCode).toBe(302);
    const back = new URL(plain.headers.location as string);
    expect(back.searchParams.get('error')).toBe('invalid_request');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('[IAM-024] refuses a wrong verifier, another redirect URI and a code used twice', async () => {
    const cookie = await signIn();
    const first = pkce();
    const wrong = await token({
      grant_type: 'authorization_code',
      code: await code(cookie, first.challenge),
      redirect_uri: REDIRECT,
      code_verifier: pkce().verifier,
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: 'invalid_grant' });

    const second = pkce();
    const once = await code(cookie, second.challenge);
    const exchange = () =>
      token({
        grant_type: 'authorization_code',
        code: once,
        redirect_uri: REDIRECT,
        code_verifier: second.verifier,
      });
    const ok = await exchange();
    expect(ok.statusCode).toBe(200);
    const { access_token } = ok.json() as Tokens;
    expect((await asBearer(access_token)).statusCode).toBe(200);
    // The same code again: refused, and the family it made is ended with the browser session.
    const again = await exchange();
    expect(again.statusCode).toBe(400);
    expect((await asBearer(access_token)).statusCode).toBe(401);
    const signedOut = await call({ method: 'GET', url: '/api/v1/session', headers: { cookie } });
    expect(signedOut.statusCode).toBe(401);
  });

  it('[IAM-024] rotates the refresh token on every use', async () => {
    const { tokens } = await signInThroughOAuth();
    const res = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    expect(res.statusCode, res.body).toBe(200);
    const next = res.json() as Tokens;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await asBearer(next.access_token)).statusCode).toBe(200);
    // JSON bodies work as well as forms.
    const json = await call({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: {
        grant_type: 'refresh_token',
        client_id: WEB_CLIENT_ID,
        refresh_token: next.refresh_token,
      },
    });
    expect(json.statusCode).toBe(200);
    // Another client may not use it.
    const other = await token({
      grant_type: 'refresh_token',
      refresh_token: (json.json() as Tokens).refresh_token,
      client_id: 'someone-else',
    });
    expect(other.statusCode).toBe(401);
    expect(other.json()).toEqual({ error: 'invalid_client' });
  });

  it('[IAM-024] (2) a refresh token used twice revokes the whole family and signs the person out', async () => {
    const { cookie, tokens } = await signInThroughOAuth();
    // A second frontend tab of the same browser: another family under the same session.
    const sibling = await signInThroughOAuth(cookie);
    const rotated = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    expect(rotated.statusCode).toBe(200);
    const current = rotated.json() as Tokens;

    // The spent token comes back (a thief, or a copy): refused, and everything ends.
    const replay = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual({ error: 'invalid_grant' });
    expect((await asBearer(current.access_token)).statusCode).toBe(401);
    expect((await asBearer(sibling.tokens.access_token)).statusCode).toBe(401);
    const refreshAgain = await token({
      grant_type: 'refresh_token',
      refresh_token: current.refresh_token,
    });
    expect(refreshAgain.statusCode).toBe(400);
    expect(
      (await call({ method: 'GET', url: '/api/v1/session', headers: { cookie } })).statusCode,
    ).toBe(401);
    const event = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload'])
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(event).toEqual({ type: 'session.revoked', payload: { count: 3, by: 'reuse' } });
  });

  it('[IAM-024] access tokens live minutes: an expired one answers invalid_token', async () => {
    const { tokens } = await signInThroughOAuth();
    expect(tokens.expires_in).toBeLessThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const res = await asBearer(tokens.access_token);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_token' });
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
    // The frontend reads that header across origins.
    expect(res.headers['access-control-expose-headers']).toContain('www-authenticate');
    // The refresh token still works.
    const res2 = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    expect(res2.statusCode).toBe(200);
  });

  it('[IAM-024] signing out from the frontend ends its family and the browser session behind it', async () => {
    const { cookie, tokens } = await signInThroughOAuth();
    const out = await asBearer(tokens.access_token, { method: 'DELETE', url: '/api/v1/session' });
    expect(out.statusCode).toBe(204);
    expect((await asBearer(tokens.access_token)).statusCode).toBe(401);
    expect(
      (await call({ method: 'GET', url: '/api/v1/session', headers: { cookie } })).statusCode,
    ).toBe(401);
    const refresh = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    expect(refresh.statusCode).toBe(400);
  });

  it('[IAM-024] “sign out other browsers” from the frontend keeps its own family', async () => {
    const elsewhere = await signIn();
    const { tokens } = await signInThroughOAuth();
    const res = await asBearer(tokens.access_token, {
      method: 'DELETE',
      url: '/api/v1/sessions/others',
    });
    expect(res.statusCode).toBe(200);
    expect((await asBearer(tokens.access_token)).statusCode).toBe(200);
    expect(
      (await call({ method: 'GET', url: '/api/v1/session', headers: { cookie: elsewhere } }))
        .statusCode,
    ).toBe(401);
    const refresh = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    expect(refresh.statusCode).toBe(200);
  });

  it('[IAM-024] a revoked token ends its family, and a deactivated person cannot refresh', async () => {
    const { cookie, tokens } = await signInThroughOAuth();
    const revoke = await call({
      method: 'POST',
      url: '/api/v1/oauth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${tokens.refresh_token}&client_id=${WEB_CLIENT_ID}`,
    });
    expect(revoke.statusCode).toBe(200);
    expect((await asBearer(tokens.access_token)).statusCode).toBe(401);
    // The browser session at the backend stays: only the frontend's family ended.
    expect(
      (await call({ method: 'GET', url: '/api/v1/session', headers: { cookie } })).statusCode,
    ).toBe(200);
    // Unknown tokens get the same answer (RFC 7009).
    const unknown = await call({
      method: 'POST',
      url: '/api/v1/oauth/revoke',
      payload: { token: 'tmr_nothing', client_id: WEB_CLIENT_ID },
    });
    expect(unknown.statusCode).toBe(200);

    const bo = await signInThroughOAuth(await signIn('bo@example.com'));
    await database.db
      .updateTable('app_user')
      .set({ deactivated_at: new Date() })
      .where('email', '=', 'bo@example.com')
      .execute();
    expect((await asBearer(bo.tokens.access_token)).statusCode).toBe(401);
    const refused = await token({
      grant_type: 'refresh_token',
      refresh_token: bo.tokens.refresh_token,
    });
    expect(refused.statusCode).toBe(400);
  });

  it('[API-002] refuses unknown grant types and token requests without their fields', async () => {
    const unsupported = await token({ grant_type: 'password' });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json()).toEqual({ error: 'unsupported_grant_type' });
    const missing = await token({ grant_type: 'authorization_code', code: 'x' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: 'invalid_request' });
  });
});
