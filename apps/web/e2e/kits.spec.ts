import { expect, test } from '@playwright/test';

/**
 * Frontend kits on a static host (M1-111; OPS-013, API-017): this run's build made into kits by
 * the Builder core and served by `kit-server.ts` the way a plain static host would, with /api
 * passed to the attachments backend. The zip kit runs with clean URLs and Subresource
 * Integrity; the single file runs alone; a kit pinned to another instance refuses to run. A
 * desktop journey: the kits are the same files on a phone.
 */
const ZIP = 'http://localhost:4178';
const SINGLE = 'http://localhost:4179';
const WRONG = 'http://localhost:4180';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, 'the kits are the same files on a phone');
});

test('[OPS-013] the zip kit runs on a static host with clean URLs and integrity checks', async ({
  page,
}) => {
  expect((await page.request.post(`${ZIP}/api/v1/session`, { data: ADMIN })).status()).toBe(200);
  const created = await page.request.post(`${ZIP}/api/v1/tickets`, {
    data: { track: 'ATT', summary: 'Opened from the zip kit' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const key = (await created.json()).ticket.key as string;
  const index = await (await page.request.get(`${ZIP}/`)).text();
  expect(index.match(/integrity="sha384-/g)?.length).toBeGreaterThanOrEqual(3);
  // A deep link as a clean URL, then a reload of it.
  await page.goto(`${ZIP}/tickets/${key}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Opened from the zip kit');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Opened from the zip kit');
});

test('[OPS-013] (2) the single-file kit runs from one file on its host', async ({ page }) => {
  const fetched: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.origin === SINGLE && !url.pathname.startsWith('/api/')) fetched.push(url.pathname);
  });
  expect((await page.request.post(`${SINGLE}/api/v1/session`, { data: ADMIN })).status()).toBe(200);
  await page.goto(`${SINGLE}/#/home`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  // Nothing but the page itself came from the host.
  expect(fetched).toEqual(['/']);
});

test('[API-017] (2) a kit pinned to another instance refuses to run', async ({ page }) => {
  await page.goto(`${WRONG}/`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'This app belongs to another server' }),
  ).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveCount(0);
});
