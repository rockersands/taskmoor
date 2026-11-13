import { expect, type Page, test } from '@playwright/test';

/**
 * Frontend and backend versions end to end (M1-106; API-017, API-018, OPS-017): the real meta
 * endpoint answers through the app's own origin without signing in, and the app reacts to a
 * version skew. The skew is made by answering the app's meta request with another window,
 * since one backend cannot be two releases at once. It uses the attachments database
 * (preview 4174) and its administrator (Ada Attach).
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

/** The real meta answer, with the backend's frontend window replaced. */
async function backendWants(page: Page, frontend: { minimum: string | null; recommended: string }) {
  await page.route('**/api/meta', async (route) => {
    const real = await route.fetch();
    const body = { ...(await real.json()), version: '99.1.0', frontend };
    await route.fulfill({ response: real, json: body });
  });
}

test('[API-017] the meta endpoint answers without signing in, signing a nonce', async ({
  playwright,
}) => {
  const anonymous = await playwright.request.newContext({ baseURL: BASE });
  const res = await anonymous.get('/api/meta?nonce=e2e-nonce-0123456789');
  expect(res.status()).toBe(200);
  // No CORS answer for a caller without an Origin; listed frontends get theirs (M1-107).
  expect(res.headers()['access-control-allow-origin']).toBeUndefined();
  const body = await res.json();
  expect(body.product).toBe('taskmoor');
  expect(body.instance.keyAlgorithm).toBe('Ed25519');
  expect(body.signature.nonce).toBe('e2e-nonce-0123456789');
  await anonymous.dispose();
});

test('[OPS-017] (2) one release behind: the app works and shows the update notice', async ({
  page,
}) => {
  expect((await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN })).status()).toBe(200);
  await backendWants(page, { minimum: null, recommended: '99.1.0' });
  await page.goto(`${BASE}/#/home`);
  const notice = page.getByRole('region', { name: 'A newer version is available.' });
  await expect(notice).toContainText('the server runs 99.1.0');
  await expect(page.getByRole('banner')).toBeVisible();
  await notice.getByRole('button', { name: 'Not now' }).click();
  await expect(notice).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('[API-018] (2) too old for the backend: "update required" instead of the app', async ({
  page,
}) => {
  expect((await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN })).status()).toBe(200);
  await backendWants(page, { minimum: '99.0.0', recommended: '99.1.0' });
  await page.goto(`${BASE}/#/home`);
  await expect(page.getByRole('heading', { level: 1, name: 'Update required' })).toBeVisible();
  // Not the app: the stand-alone frame, with only the product name on top and no navigation.
  await expect(page.getByRole('banner')).toHaveText('Taskmoor');
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
});
