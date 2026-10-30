import { describe, expect, it } from 'vitest';
import { OAuthClient, type OAuthEnvironment } from './oauth';

const API = 'https://api.example.net';
const APP = 'https://tracker.example.org';

/** A page at `href` with its own storage, history and backend. */
function page(href: string, storage = new Map<string, string>()) {
  const listeners: Record<string, (() => void)[]> = {};
  const requests: { url: string; body: URLSearchParams }[] = [];
  const answers: (() => Response)[] = [];
  const state = { href, assigned: '' };
  let clock = 1_000_000;
  const env: OAuthEnvironment = {
    location: {
      get href() {
        return state.href;
      },
      origin: new URL(href).origin,
      assign: (url: string | URL) => {
        state.assigned = String(url);
      },
    },
    history: {
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
        if (url) state.href = new URL(String(url), state.href).href;
      },
    },
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
      removeItem: (key) => void storage.delete(key),
    },
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
      const answer = answers.shift();
      if (!answer) throw new TypeError('offline');
      return answer();
    },
    crypto: globalThis.crypto,
    addEventListener: (type, listener) => {
      listeners[type] = [...(listeners[type] ?? []), listener];
    },
    now: () => clock,
  };
  return {
    env,
    state,
    storage,
    requests,
    answer: (status: number, body: object) =>
      answers.push(() => new Response(JSON.stringify(body), { status })),
    fire: (type: string) => {
      for (const listener of listeners[type] ?? []) listener();
    },
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const tokens = (n: number) => ({
  access_token: `tma_access${n}`,
  refresh_token: `tmr_refresh${n}`,
  expires_in: 600,
  token_type: 'Bearer',
});

describe('signing in at a backend on another site (M1-107)', () => {
  it('[IAM-024] starts a code flow with PKCE (S256) and a state, and comes back to the page', async () => {
    const first = page(`${APP}/#/boards/7`);
    const client = new OAuthClient(API, '/', first.env);
    expect(await client.begin()).toBe(true);
    const authorize = new URL(first.state.assigned);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${API}/api/v1/oauth/authorize`);
    const q = authorize.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('taskmoor-web');
    expect(q.get('redirect_uri')).toBe(`${APP}/`);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = q.get('state') as string;

    // The backend sends the browser back with a code; the same tab's storage holds the verifier.
    const back = page(
      `${APP}/?code=abc&state=${state}&iss=${encodeURIComponent(API)}`,
      first.storage,
    );
    back.answer(200, tokens(1));
    const returned = new OAuthClient(API, '/', back.env);
    expect(await returned.complete()).toBe('signed-in');
    const [exchange] = back.requests;
    expect(exchange?.url).toBe(`${API}/api/v1/oauth/token`);
    expect(exchange?.body.get('grant_type')).toBe('authorization_code');
    expect(exchange?.body.get('code')).toBe('abc');
    const verifier = exchange?.body.get('code_verifier') as string;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(q.get('code_challenge'));
    // The address the person was at, without the code.
    expect(back.state.href).toBe(`${APP}/#/boards/7`);
    expect(await returned.accessToken()).toBe('tma_access1');
  });

  it('[IAM-024] refuses an answer for another sign-in or from another backend', async () => {
    const first = page(`${APP}/`);
    await new OAuthClient(API, '/', first.env).begin();
    const forged = page(`${APP}/?code=abc&state=forged`, first.storage);
    const client = new OAuthClient(API, '/', forged.env);
    expect(await client.complete()).toEqual({ error: 'state_mismatch' });
    expect(forged.requests).toEqual([]);
    expect(forged.state.href).toBe(`${APP}/`);
    expect(client.failure()).toBe('state_mismatch');

    const state = new URL(first.state.assigned).searchParams.get('state');
    const mixedUp = page(
      `${APP}/?code=abc&state=${state}&iss=https%3A%2F%2Fother.example`,
      first.storage,
    );
    expect(await new OAuthClient(API, '/', mixedUp.env).complete()).toEqual({
      error: 'issuer_mismatch',
    });
  });

  it('[IAM-024] rotates the refresh token and signs out when the backend refuses it', async () => {
    const tab = page(`${APP}/`);
    const client = new OAuthClient(API, '/', tab.env);
    await client.begin();
    const state = new URL(tab.state.assigned).searchParams.get('state');
    const back = page(`${APP}/?code=abc&state=${state}`, tab.storage);
    back.answer(200, tokens(1));
    const signedIn = new OAuthClient(API, '/', back.env);
    await signedIn.complete();
    let signedOut = 0;
    signedIn.onSignedOut(() => {
      signedOut += 1;
    });
    // Close to expiry: one refresh, even when several requests ask at once.
    back.tick(590_000);
    back.answer(200, tokens(2));
    expect(await Promise.all([signedIn.accessToken(), signedIn.accessToken()])).toEqual([
      'tma_access2',
      'tma_access2',
    ]);
    expect(back.requests.at(-1)?.body.get('refresh_token')).toBe('tmr_refresh1');
    // The backend refused the token: the page forgets everything and says so.
    back.answer(400, { error: 'invalid_grant' });
    expect(await signedIn.forceRefresh()).toBeNull();
    expect(signedIn.hasTokens()).toBe(false);
    expect(signedOut).toBe(1);
  });

  it('[IAM-024] (3) keeps the refresh token out of storage while the page lives, never in localStorage', async () => {
    const tab = page(`${APP}/`);
    const client = new OAuthClient(API, '/', tab.env);
    await client.begin();
    const state = new URL(tab.state.assigned).searchParams.get('state');
    const back = page(`${APP}/?code=abc&state=${state}`, tab.storage);
    back.answer(200, tokens(1));
    const signedIn = new OAuthClient(API, '/', back.env);
    await signedIn.complete();
    expect([...back.storage.values()].join()).not.toContain('tmr_');
    // Unloading (a reload) puts it aside for the next page, which takes it out again.
    back.fire('pagehide');
    expect(back.storage.get('taskmoor.oauth.refresh')).toBe('tmr_refresh1');
    const reloaded = page(`${APP}/`, back.storage);
    const next = new OAuthClient(API, '/', reloaded.env);
    expect(reloaded.storage.has('taskmoor.oauth.refresh')).toBe(false);
    reloaded.answer(200, tokens(2));
    expect(await next.accessToken()).toBe('tma_access2');
    // A tab duplicated while that page runs finds nothing to spend twice.
    expect(
      new OAuthClient(API, '/', page(`${APP}/`, new Map(reloaded.storage)).env).hasTokens(),
    ).toBe(false);
    expect(globalThis.localStorage?.length ?? 0).toBe(0);
  });

  it('[IAM-024] does not bounce back to the backend on its own right after a failed sign-in', async () => {
    const tab = page(`${APP}/`);
    const client = new OAuthClient(API, '/', tab.env);
    expect(await client.begin({ auto: true })).toBe(true);
    // Came back without a code: an automatic start now would loop.
    expect(await client.begin({ auto: true })).toBe(false);
    tab.tick(20_000);
    expect(await client.begin({ auto: true })).toBe(true);
    // A person's click always goes.
    expect(await client.begin()).toBe(true);
  });
});
