import { expect, type Page, test } from '@playwright/test';

/**
 * The built frontend served by the backend itself (M1-105, OPS-013, OPS-017), in both routing
 * modes: hash routing (4176) and clean URLs (4177), started by web-server.ts with an
 * administrator, the RT track, ticket RT-1 and "Routes board". The same journey runs on each:
 * deep links, links inside the app, back, reload, and the other mode's links.
 */
const HASH = 'http://localhost:4176';
const PATH = 'http://localhost:4177';
const ADMIN = { email: 'rui@routes.test', password: 'lantern harbour meadow 4521' };

/** Requests for the app's own files that failed: a deep path must not break relative URLs. */
function failedFiles(page: Page): string[] {
  const failed: string[] = [];
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (res.status() >= 400 && !url.pathname.startsWith('/api/')) failed.push(url.pathname);
  });
  return failed;
}

async function signIn(page: Page) {
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

const ticketHeading = (page: Page) =>
  page.getByRole('heading', { level: 1, name: /Deep link target/ });

test('[OPS-013] [OPS-017] clean URLs: deep links, links, history and old hash links', async ({
  page,
}) => {
  const failed = failedFiles(page);
  await page.goto(`${PATH}/sign-in`);
  // The backend filled the slot: clean URLs from the root, the name given at setup.
  expect(await page.evaluate(() => document.querySelector('base')?.getAttribute('href'))).toBe('/');
  await expect(page).toHaveTitle('Routes path · Taskmoor');
  await signIn(page);
  await expect(page).toHaveURL(`${PATH}/home`);

  // A deep link straight to a page, then links inside the app, all as paths.
  await page.goto(`${PATH}/tracks`);
  await expect(page.getByRole('heading', { name: 'Tracks', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Routes', exact: true }).click();
  await expect(page).toHaveURL(`${PATH}/tracks/RT`);
  await page.getByRole('link', { name: 'Board', exact: true }).click();
  await expect(page).toHaveURL(`${PATH}/tracks/RT/board`);
  const boardUrl = page.url();
  await page.getByRole('link', { name: /^RT-1\b/ }).click();
  await expect(page).toHaveURL(`${PATH}/tickets/RT-1`);
  await expect(ticketHeading(page)).toBeVisible();

  // Back and forward walk the history; a reload asks the server for the deep path.
  await page.goBack();
  await expect(page).toHaveURL(boardUrl);
  await expect(page.getByRole('link', { name: /^RT-1\b/ })).toBeVisible();
  await page.goForward();
  await expect(ticketHeading(page)).toBeVisible();
  await page.reload();
  await expect(ticketHeading(page)).toBeVisible();

  // A hash link (an older bookmark, an email) opens its page and becomes its path.
  await page.goto(`${PATH}/#/tickets/RT-1`);
  await expect(page).toHaveURL(`${PATH}/tickets/RT-1`);
  await expect(ticketHeading(page)).toBeVisible();

  // The skip link moves to the content without leaving the page.
  await page.getByRole('link', { name: 'Skip to content' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await expect(page).toHaveURL(`${PATH}/tickets/RT-1`);
  expect(failed).toEqual([]);
});

test('[OPS-013] [OPS-017] hash routing: routes in the fragment, clean links redirected', async ({
  page,
}) => {
  const failed = failedFiles(page);
  await page.goto(`${HASH}/#/sign-in`);
  expect(await page.locator('base').count()).toBe(0);
  await signIn(page);
  await expect(page).toHaveURL(`${HASH}/#/home`);

  // A clean link reaches its page through the server's redirect to the hash route.
  await page.goto(`${HASH}/tracks`);
  await expect(page).toHaveURL(`${HASH}/#/tracks`);
  await expect(page.getByRole('heading', { name: 'Tracks', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Routes', exact: true }).click();
  await expect(page).toHaveURL(`${HASH}/#/tracks/RT`);
  await page.getByRole('link', { name: 'Board', exact: true }).click();
  await expect(page).toHaveURL(`${HASH}/#/tracks/RT/board`);
  const boardUrl = page.url();
  await page.getByRole('link', { name: /^RT-1\b/ }).click();
  await expect(page).toHaveURL(`${HASH}/#/tickets/RT-1`);
  await expect(ticketHeading(page)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(boardUrl);
  await page.reload();
  await expect(page.getByRole('link', { name: /^RT-1\b/ })).toBeVisible();
  expect(failed).toEqual([]);
});

test('[OPS-017] the frontend the backend serves is the version it was built with', async ({
  request,
}) => {
  for (const base of [HASH, PATH]) {
    const health = await (await request.get(`${base}/health`)).json();
    const artefact = await (await request.get(`${base}/version.json`)).json();
    expect(artefact).toMatchObject({ name: 'taskmoor-web', version: health.version });
  }
});
