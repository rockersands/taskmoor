import { expect, type Page, test } from '@playwright/test';

/**
 * A frontend on another origin than its backend (M1-107; IAM-024, IAM-025, ADR-080), both
 * layouts against one backend that web-server.ts runs at api.taskmoor.localhost:8794, with the
 * frontend kits kit-server.ts serves from plain static hosts:
 *
 * - the same site: app.taskmoor.localhost (a sibling subdomain) signs in with its own form and
 *   the backend's SameSite=Lax cookie, the backend approving its origin over CORS;
 * - another site: 127.0.0.1 gets no cookie from the backend, so it signs in on the backend's
 *   own page through OAuth with PKCE and calls it with short-lived bearer tokens.
 *
 * Every page here runs under the app's content security policy, and any violation fails it.
 */
const API = 'http://api.taskmoor.localhost:8794';
const SIBLING = 'http://app.taskmoor.localhost:4181';
const CROSS_SITE = 'http://127.0.0.1:4182';
/**
 * A page on an origin this backend does not list: a sibling subdomain, so the browser sends the
 * backend's SameSite=Lax cookie along and only the origin check stands in the way. Playwright
 * serves it, with no content security policy of ours to stop its requests first.
 */
const STRANGER = 'http://evil.taskmoor.localhost:4199';
const ADMIN = { email: 'rui@routes.test', password: 'lantern harbour meadow 4521' };

const ticketHeading = (page: Page) =>
  page.getByRole('heading', { level: 1, name: /Deep link target/ });

/** Collects what the content security policy refused, from the first page on. */
async function watchPolicy(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (event) =>
      seen.push(`${event.effectiveDirective} ${event.blockedURI}`),
    );
  });
  return () =>
    page.evaluate(() => (window as unknown as { cspViolations?: string[] }).cspViolations ?? []);
}

async function signInWithForm(page: Page) {
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Writes a comment on the open ticket and waits for it to appear. */
async function comment(page: Page, text: string) {
  const comments = page.getByRole('region', { name: 'Comments' });
  await comments.getByRole('textbox', { name: 'Add a comment' }).click();
  await page.keyboard.type(text);
  await comments.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(comments.getByRole('listitem').filter({ hasText: text })).toBeVisible();
}

/** Resolves with the first sync-socket position the page hears, proving the socket signed in. */
function syncPosition(page: Page): Promise<string> {
  return new Promise((resolve) => {
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/api/v1/sync/socket')) return;
      socket.on('framereceived', ({ payload }) => {
        if (String(payload).includes('"type":"position"')) resolve(String(payload));
      });
    });
  });
}

test('[IAM-024] (1) the same site: a sibling subdomain signs in with the backend’s cookie', async ({
  page,
  context,
}, info) => {
  const violations = await watchPolicy(page);
  const position = syncPosition(page);
  await page.goto(`${SIBLING}/sign-in`);
  await signInWithForm(page);
  await expect(page).toHaveURL(`${SIBLING}/home`);
  // The cookie belongs to the backend's host alone, sent along because both are one site.
  const cookies = await context.cookies([API, SIBLING]);
  expect(cookies.map((c) => `${c.domain} ${c.name}`)).toEqual([
    'api.taskmoor.localhost taskmoor_session',
  ]);
  expect(cookies[0]?.sameSite).toBe('Lax');
  expect(cookies[0]?.httpOnly).toBe(true);

  await page.goto(`${SIBLING}/tickets/RT-1`);
  await expect(ticketHeading(page)).toBeVisible();
  await comment(page, `From the sibling subdomain (${info.project.name})`);
  expect(await position).toContain('position');
  expect(await violations()).toEqual([]);
});

test('[IAM-024] (1) another site: the frontend signs in through OAuth with PKCE and bearer tokens', async ({
  page,
}, info) => {
  const violations = await watchPolicy(page);
  const position = syncPosition(page);
  const apiCalls: { url: string; authorization?: string; cookie?: string }[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.origin !== API ||
      !url.pathname.startsWith('/api/v1/') ||
      request.method() === 'OPTIONS'
    )
      return;
    if (!request.frame().url().startsWith(CROSS_SITE)) return;
    const headers = request.headers();
    apiCalls.push({
      url: url.pathname,
      ...(headers.authorization ? { authorization: headers.authorization } : {}),
      ...(headers.cookie ? { cookie: headers.cookie } : {}),
    });
  });

  // A deep link of the frontend: it sends the person to the backend's own sign-in page.
  await page.goto(`${CROSS_SITE}/tickets/RT-1`);
  await expect(page).toHaveURL(/^http:\/\/api\.taskmoor\.localhost:8794\/#\/sign-in\?continue=/);
  await signInWithForm(page);
  // Back on the frontend, at the page the person asked for, without the code in the address.
  await expect(ticketHeading(page)).toBeVisible();
  expect(page.url()).toBe(`${CROSS_SITE}/tickets/RT-1`);

  await comment(page, `From another site (${info.project.name})`);
  expect(await position).toContain('position');
  // Every call carried a bearer token and no cookie.
  const calls = apiCalls.filter((c) => !c.url.startsWith('/api/v1/oauth/'));
  expect(calls.length).toBeGreaterThan(2);
  for (const call of calls) {
    expect(call.authorization, call.url).toMatch(/^Bearer tma_/);
    expect(call.cookie, call.url).toBeUndefined();
  }
  // IAM-024 (3): no token in localStorage (the skin the person last saw may be there).
  const stored = await page.evaluate(() =>
    Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key)}`),
  );
  expect(stored.filter((entry) => /tm[ar]_|token/i.test(entry))).toEqual([]);

  // A reload keeps the person signed in: the refresh token outlives the page, not the tab.
  const refreshed = page.waitForRequest(
    (r) =>
      r.url() === `${API}/api/v1/oauth/token` && (r.postData() ?? '').includes('refresh_token'),
  );
  await page.reload();
  await refreshed;
  await expect(ticketHeading(page)).toBeVisible();
  expect(page.url()).toBe(`${CROSS_SITE}/tickets/RT-1`);
  expect(await violations()).toEqual([]);
});

test('[IAM-024] co-editing works from another site with the access token', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'one co-editing journey is enough');
  await page.goto(`${CROSS_SITE}/tickets/RT-1`);
  await signInWithForm(page);
  await expect(ticketHeading(page)).toBeVisible();
  const description = page
    .getByRole('region', { name: 'Description' })
    .getByRole('textbox', { name: 'Description' });
  await expect(description).toHaveAttribute('contenteditable', 'true');
  await description.click();
  const text = `Typed across sites ${Date.now()}`;
  await page.keyboard.type(text);
  // Saved by the co-editing server as the person, read back with the backend's own cookie.
  await expect
    .poll(
      async () =>
        JSON.stringify(
          (await (await page.request.get(`${API}/api/v1/tickets/RT-1`)).json()).ticket,
        ),
      { timeout: 15_000 },
    )
    .toContain(text);
});

test('[IAM-024] (2) replaying a used refresh token revokes the family and signs the person out', async ({
  page,
}) => {
  const refreshTokens: string[] = [];
  page.on('response', async (response) => {
    if (response.url() !== `${API}/api/v1/oauth/token` || !response.ok()) return;
    refreshTokens.push(((await response.json()) as { refresh_token: string }).refresh_token);
  });
  await page.goto(`${CROSS_SITE}/tickets/RT-1`);
  await signInWithForm(page);
  await expect(ticketHeading(page)).toBeVisible();
  // A reload spends the first refresh token for a second one.
  await page.reload();
  await expect(ticketHeading(page)).toBeVisible();
  await expect.poll(() => refreshTokens.length).toBe(2);

  // Someone replays the spent token: refused, and the whole family ends.
  const replay = await page.request.post(`${API}/api/v1/oauth/token`, {
    form: {
      grant_type: 'refresh_token',
      client_id: 'taskmoor-web',
      refresh_token: refreshTokens[0] as string,
    },
  });
  expect(replay.status()).toBe(400);
  expect(await replay.json()).toEqual({ error: 'invalid_grant' });

  // The page's own token is gone with it: the next start lands on the backend's sign-in page,
  // since the session there ended too.
  await page.reload();
  await expect(page).toHaveURL(/^http:\/\/api\.taskmoor\.localhost:8794\/#\/sign-in\?continue=/);
  await expect(page.getByLabel('Email')).toBeVisible();
});

test('[IAM-025] (1) other origins are refused over HTTP and WebSocket', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the browser’s checks are the same on a phone');
  // Signed in at the backend: its cookie is in this browser and goes to it from any same-site page.
  const signedIn = await page.request.post(`${API}/api/v1/session`, { data: ADMIN });
  expect(signedIn.status()).toBe(200);
  await page.route(`${STRANGER}/`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Elsewhere</title>' }),
  );
  await page.goto(`${STRANGER}/`);
  const outcome = await page.evaluate(async (api) => {
    const read = await fetch(`${api}/api/meta`).then(
      () => 'read',
      () => 'refused',
    );
    const post = await fetch(`${api}/api/v1/session`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', password: 'x' }),
    }).then(
      () => 'sent',
      () => 'refused',
    );
    const socket = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`${api.replace('http', 'ws')}/api/v1/sync/socket`);
      // Opened, the socket would say where the log stands, signed in by the cookie.
      ws.onmessage = () => resolve('signed in');
      ws.onclose = () => resolve('closed');
    });
    return { read, post, socket };
  }, API);
  expect(outcome).toEqual({ read: 'refused', post: 'refused', socket: 'closed' });
  // What the backend answers a request from that origin: no CORS approval, 403.
  const direct = await page.request.get(`${API}/api/meta`, { headers: { origin: STRANGER } });
  expect(direct.status()).toBe(403);
  expect(direct.headers()['access-control-allow-origin']).toBeUndefined();
  // The listed frontends are approved for their exact origin.
  for (const origin of [SIBLING, CROSS_SITE]) {
    const allowed = await page.request.get(`${API}/api/meta`, { headers: { origin } });
    expect(allowed.headers()['access-control-allow-origin']).toBe(origin);
  }
});
