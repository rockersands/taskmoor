import { expect, type Page, test } from '@playwright/test';

/**
 * Frontend origins (M1-108; OPS-017, IAM-025; ADR-087), against the backends web-server.ts runs
 * with the built frontend (single-server mode, `TASKMOOR_ROLE=all`):
 *
 * - (3) same-origin mode: the backend on localhost:4176 serves the app itself, signs in, opens
 *   the sync socket on its own origin, and its frontends page names itself with the version it
 *   serves;
 * - (1) registration without a restart: the cross-origin backend (api.taskmoor.localhost:8794)
 *   lists two kits in its environment; kit-server.ts serves a third at
 *   kit2.taskmoor.localhost:4183 that it does not list. An administrator registers it on the
 *   frontends page, the kit signs in and works at once, the list shows the version it reported,
 *   and once removed it is refused again.
 */
const SINGLE = 'http://localhost:4176';
const API = 'http://api.taskmoor.localhost:8794';
const UNLISTED = 'http://kit2.taskmoor.localhost:4183';
const ADMIN = { email: 'rui@routes.test', password: 'lantern harbour meadow 4521' };

async function signIn(page: Page) {
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
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

test('[OPS-017] (3) single-server mode: the backend serves the app and names itself', async ({
  page,
}) => {
  const failed: string[] = [];
  page.on('response', (res) => {
    // Refused origins and server errors; a 401 before signing in is expected.
    if (res.status() === 403 || res.status() >= 500) {
      failed.push(`${res.status()} ${new URL(res.url()).pathname}`);
    }
  });
  const position = syncPosition(page);
  const { version } = await (await page.request.get(`${SINGLE}/api/meta`)).json();
  await page.goto(`${SINGLE}/#/sign-in`);
  await signIn(page);
  await expect(page).toHaveURL(`${SINGLE}/#/home`);
  // The realtime socket on the page's own origin, no frontend registration needed.
  expect(await position).toContain('position');

  await page.goto(`${SINGLE}/#/admin`);
  await page.getByRole('link', { name: 'Frontends' }).click();
  await expect(page.getByRole('heading', { name: 'Frontends', level: 1 })).toBeVisible();
  const self = page.getByRole('region', { name: 'This server' });
  await expect(self).toContainText(SINGLE);
  await expect(self).toContainText(`Serves the app itself, version ${version}.`);
  await expect(page.getByText('No frontend is registered yet.')).toBeVisible();
  // No sideways scrolling on a phone either.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expect(failed).toEqual([]);
});

test('[OPS-017] (1) a frontend registered by an administrator signs in at once, and stops when removed', async ({
  page,
  browser,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'one registration journey: the list is shared');
  const refused = async () =>
    (await page.request.get(`${API}/api/meta`, { headers: { origin: UNLISTED } })).status();
  expect(await refused()).toBe(403);
  const { version } = await (await page.request.get(`${API}/api/meta`)).json();

  // The administrator, on the backend's own pages.
  await page.goto(`${API}/#/sign-in`);
  await signIn(page);
  await expect(page).toHaveURL(`${API}/#/home`);
  await page.goto(`${API}/#/admin/frontends`);
  await expect(page.getByRole('heading', { name: 'Frontends', level: 1 })).toBeVisible();
  // The environment's two kits are listed apart.
  const environment = page.getByRole('region', { name: 'From the server’s environment' });
  await expect(environment.getByRole('heading', { level: 3 })).toHaveCount(2);

  await page.getByRole('textbox', { name: 'Origin' }).fill(UNLISTED);
  await page.getByRole('textbox', { name: 'Label' }).fill('Second kit');
  await page.getByRole('button', { name: 'Add frontend' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'was added' })).toBeVisible();
  const registered = page.getByRole('region', { name: 'Registered frontends' });
  const item = registered.getByRole('listitem').filter({ hasText: UNLISTED });
  await expect(item).toContainText('Has not reported its version yet.');

  // The kit, in a browser of its own: it signs in with the backend's cookie and goes live.
  const kitContext = await browser.newContext();
  const kit = await kitContext.newPage();
  const position = syncPosition(kit);
  await kit.goto(`${UNLISTED}/sign-in`);
  await signIn(kit);
  await expect(kit).toHaveURL(`${UNLISTED}/home`);
  await kit.goto(`${UNLISTED}/tickets/RT-1`);
  await expect(kit.getByRole('heading', { level: 1, name: /Deep link target/ })).toBeVisible();
  expect(await position).toContain('position');

  // It reported its version when it loaded.
  await page.reload();
  await expect(item).toContainText(`Runs version ${version}`);

  // Removed: refused at once.
  await item.getByRole('button', { name: `Remove ${UNLISTED}` }).click();
  await item.getByRole('button', { name: 'Remove it' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'was removed' })).toBeVisible();
  await expect(item).toHaveCount(0);
  expect(await refused()).toBe(403);
  const call = await kit.evaluate(async (api) => {
    try {
      return (await fetch(`${api}/api/v1/session`, { credentials: 'include' })).status;
    } catch {
      return 'refused';
    }
  }, API);
  // No CORS answer any more: the browser hides the 403 and the call fails.
  expect(call).toBe('refused');
  await kitContext.close();
});
