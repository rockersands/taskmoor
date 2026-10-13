import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';

const TOKEN = 'e2e-setup-token-0123456789';
const ADMIN = { name: 'Kalo', email: 'kalo@example.com', password: 'a long enough passphrase' };
const FIREFOX_ON_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0';
const SAFARI_ON_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

// The backend has one setup to give; these tests share it in order and only run on desktop,
// because the mobile project would otherwise race for the same one-time token. Every test
// after the first needs the administrator it creates, so they all live in this serial file
// (the config runs files in parallel, so their order across files is not guaranteed).
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'one setup per backend; desktop runs it');

async function signInThroughApi(
  request: APIRequestContext,
  who: { email: string; password: string },
): Promise<void> {
  const res = await request.post('/api/v1/session', {
    data: { email: who.email, password: who.password },
  });
  expect(res.status()).toBe(200);
}

async function signInThroughForm(page: Page, who: { email: string; password: string }) {
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** New contexts need the base URL the project configured. */
const at = (baseURL: string | undefined) => (baseURL ? { baseURL } : {});

const heading = (page: Page) => page.getByRole('heading', { level: 1 });

test('[OPS-003] the setup link creates the administrator and signs them in', async ({ page }) => {
  await page.goto(`./#/setup?token=${TOKEN}`);
  await expect(heading(page)).toHaveText('Set up Taskmoor');
  await page.getByLabel('Instance name').fill('E2E Tracker');
  await page.getByLabel('Name', { exact: true }).fill(ADMIN.name);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByLabel('Confirm password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Finish setup' }).click();

  await expect(heading(page)).toHaveText('Home');
  await page.goto('./#/settings');
  await expect(heading(page)).toHaveText('Settings');
});

test('[OPS-003] the token is rejected once used', async ({ page }) => {
  const res = await page.request.post('/api/v1/setup', {
    data: { token: TOKEN, instanceName: 'Again', admin: ADMIN },
  });
  expect(res.status()).toBe(409);
  await page.goto(`./#/setup?token=${TOKEN}`);
  await expect(page.getByText('already set up')).toBeVisible();
});

test('[IAM-001] signing out through the user menu and back in with the password works', async ({
  page,
}) => {
  // A fresh browser context: sign in through the API first (it shares the page's cookie jar).
  await signInThroughApi(page.request, ADMIN);
  await page.goto('./#/settings');
  await expect(heading(page)).toHaveText('Settings');

  // The menu button pattern from the keyboard: arrows open and move, Escape returns.
  const menuButton = page.getByRole('button', { name: ADMIN.name, exact: true });
  await expect(menuButton).toHaveAttribute('aria-haspopup', 'menu');
  await menuButton.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Account' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(menuButton).toBeFocused();

  await menuButton.click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(heading(page)).toHaveText('Sign in');
  await expect(page).toHaveURL(/#\/sign-in$/);
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  // The backend ended the session too, not just the page.
  expect((await page.request.get('/api/v1/session')).status()).toBe(401);

  await signInThroughForm(page, { email: ADMIN.email, password: 'not the password' });
  await expect(page.getByRole('alert')).toContainText('do not match');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await signInThroughForm(page, ADMIN);
  await expect(heading(page)).toHaveText('Home');
  await expect(page.getByRole('button', { name: ADMIN.name, exact: true })).toBeVisible();
});

test('[IAM-001] repeated failures lock that email and the form says how long to wait', async ({
  page,
}) => {
  // An email nobody has: the lock applies to the submitted email, so the administrator is
  // unaffected. Unique per run, because counters live in the backend.
  const email = `nobody-${Date.now()}@example.com`;
  await page.goto('./#/sign-in');
  for (let attempt = 1; attempt <= 5; attempt++) {
    const answer = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/session') && r.request().method() === 'POST',
    );
    await signInThroughForm(page, { email, password: `wrong guess number ${attempt}` });
    expect((await answer).status()).toBe(401);
    await expect(page.getByRole('alert')).toContainText('do not match');
  }
  const locked = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/session') && r.request().method() === 'POST',
  );
  await signInThroughForm(page, { email, password: 'wrong guess number 6' });
  expect((await locked).status()).toBe(429);
  await expect(page.getByRole('alert')).toHaveText(
    /^Too many attempts\. Try again in \d+ seconds\.$/,
  );

  await signInThroughForm(page, ADMIN);
  await expect(heading(page)).toHaveText('Home');
});

test('[IAM-001] [IAM-004] a person manages sessions and changes the password on the Account page', async ({
  page,
  playwright,
  baseURL,
}) => {
  const RIVER = {
    name: 'River Stone',
    email: 'river@example.com',
    password: 'a first long passphrase',
  };
  const NEW_PASSWORD = 'a second long passphrase';
  await signInThroughApi(page.request, ADMIN);
  const created = await page.request.post('/api/v1/users', {
    data: { email: RIVER.email, name: RIVER.name, password: RIVER.password },
  });
  expect(created.status()).toBe(201);
  expect((await page.request.delete('/api/v1/session')).status()).toBe(204);

  // River is also signed in on a laptop and a phone.
  const laptop = await playwright.request.newContext({
    ...at(baseURL),
    userAgent: FIREFOX_ON_LINUX,
  });
  const phone = await playwright.request.newContext({
    ...at(baseURL),
    userAgent: SAFARI_ON_IPHONE,
  });
  await signInThroughApi(laptop, RIVER);
  await signInThroughApi(phone, RIVER);

  await page.goto('./#/sign-in');
  await signInThroughForm(page, RIVER);
  await expect(heading(page)).toHaveText('Home');
  await page.getByRole('button', { name: RIVER.name, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Account' }).click();
  await expect(heading(page)).toHaveText('Account');

  const sessions = page.getByRole('region', { name: 'Sessions' });
  await expect(sessions.getByRole('listitem')).toHaveCount(3);
  const here = sessions.getByRole('listitem').filter({ hasText: 'This device' });
  await expect(here).toContainText('Chrome on Windows');
  await expect(here).toContainText(/IP address/);
  await expect(here.getByRole('button')).toHaveCount(0);
  await expect(sessions.getByRole('listitem').filter({ hasText: 'Firefox on Linux' })).toHaveCount(
    1,
  );

  // Sign out the phone from here.
  await sessions.getByRole('button', { name: 'Sign out Safari on iOS' }).click();
  await expect(sessions.getByRole('status')).toHaveText('Signed out Safari on iOS.');
  await expect(sessions.getByRole('listitem')).toHaveCount(2);
  expect((await phone.get('/api/v1/session')).status()).toBe(401);

  // A weak password is refused with a translated reason.
  const password = page.getByRole('region', { name: 'Password' });
  await password.getByLabel('Current password', { exact: true }).fill(RIVER.password);
  await password.getByLabel('New password', { exact: true }).fill('river stone 12345');
  await password.getByLabel('Confirm new password', { exact: true }).fill('river stone 12345');
  await password.getByRole('button', { name: 'Change password' }).click();
  await expect(password.getByRole('alert')).toContainText('It contains your name');

  await password.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await password.getByLabel('Confirm new password', { exact: true }).fill(NEW_PASSWORD);
  await password.getByRole('button', { name: 'Change password' }).click();
  await expect(password.getByRole('status')).toHaveText(
    'Password changed. 1 other session was signed out.',
  );
  await expect(sessions.getByRole('listitem')).toHaveCount(1);
  expect((await laptop.get('/api/v1/session')).status()).toBe(401);
  await laptop.dispose();
  await phone.dispose();

  // Sign out and back in: the old password no longer works, the new one does.
  await page.getByRole('button', { name: RIVER.name, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(heading(page)).toHaveText('Sign in');
  await signInThroughForm(page, RIVER);
  await expect(page.getByRole('alert')).toContainText('do not match');
  await signInThroughForm(page, { email: RIVER.email, password: NEW_PASSWORD });
  await expect(heading(page)).toHaveText('Home');
});

test('[IAM-001] an activation link lets a new person choose a password and signs them in', async ({
  page,
}) => {
  await signInThroughApi(page.request, ADMIN);
  const res = await page.request.post('/api/v1/users', {
    data: { email: 'nia@example.com', name: 'Nia Okafor' },
  });
  expect(res.status()).toBe(201);
  const { activationLink } = (await res.json()) as { activationLink: string };
  expect((await page.request.delete('/api/v1/session')).status()).toBe(204);
  const { hash } = new URL(activationLink);
  expect(hash).toMatch(/^#\/password\?token=/);
  const token = new URLSearchParams(hash.split('?')[1]).get('token') ?? '';

  const apiUrls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) apiUrls.push(r.url());
  });
  await page.goto(`./${hash}`);
  await expect(heading(page)).toHaveText('Choose a password for Nia Okafor');
  await expect(page.getByRole('navigation')).toHaveCount(0);

  const next = page.getByLabel('New password', { exact: true });
  const confirm = page.getByLabel('Confirm new password', { exact: true });
  await next.fill('okafor builds bridges');
  await confirm.fill('okafor builds bridges');
  await page.getByRole('button', { name: 'Save password and sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('It contains your name');

  await next.fill('a quiet harbour at dawn');
  await confirm.fill('a quiet harbour at dawn');
  await page.getByRole('button', { name: 'Show new password' }).click();
  await expect(next).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Save password and sign in' }).click();
  await expect(heading(page)).toHaveText('Home');
  await expect(page.getByRole('button', { name: 'Nia Okafor', exact: true })).toBeVisible();
  // The token travelled in request bodies only, never in a URL a server would log.
  expect(apiUrls.length).toBeGreaterThan(0);
  expect(apiUrls.filter((url) => url.includes(token))).toEqual([]);

  // The link works once.
  await page.goto(`./${hash}`);
  await expect(page.getByText(/invalid, has expired or was already used/)).toBeVisible();
});

test('[IAM-008] the account page and the user menu work on a small phone', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 360, height: 740 },
    ...at(baseURL),
  });
  const page = await context.newPage();
  await signInThroughApi(context.request, ADMIN);
  await page.goto('./#/account');
  await expect(heading(page)).toHaveText('Account');
  await expect(
    page.getByRole('region', { name: 'Sessions' }).getByRole('listitem'),
  ).not.toHaveCount(0);

  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);

  const targets = [
    page.getByRole('button', { name: ADMIN.name, exact: true }),
    page.getByRole('button', { name: 'Show current password' }),
    page.getByRole('button', { name: 'Show new password' }),
    page.getByRole('button', { name: 'Show password confirmation' }),
    page.getByRole('button', { name: 'Save profile' }),
    page.getByRole('button', { name: 'Change password' }),
    page.getByLabel('Time zone'),
    page.getByLabel('Language and region'),
  ];
  for (const target of targets) {
    const box = await target.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  for (const toggle of targets.slice(0, 4)) {
    expect((await toggle.boundingBox())?.width).toBeGreaterThanOrEqual(44);
  }

  await page.getByRole('button', { name: ADMIN.name, exact: true }).tap();
  const menu = page.getByRole('menu', { name: ADMIN.name });
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
  for (const item of await menu.getByRole('menuitem').all()) {
    expect((await item.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }

  await menu.getByRole('menuitem', { name: 'Sign out' }).tap();
  await expect(heading(page)).toHaveText('Sign in');
  expect(await overflow()).toBeLessThanOrEqual(0);
  await context.close();
});

test('[OPS-010] the administrator opens the system status from Settings', async ({ page }) => {
  await signInThroughApi(page.request, ADMIN);
  await page.goto('./#/settings');
  await page.getByRole('link', { name: 'System status' }).click();
  await expect(heading(page)).toHaveText('System status');
  const database = page.getByRole('region', { name: 'Database' });
  await expect(database.getByText('Connected')).toBeVisible();
  await expect(database.getByText(/^\d+ applied$/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Runtime' }).getByText(/^v\d+\./)).toBeVisible();

  // Everyone else is turned away by the backend as well as the page.
  await page.request.delete('/api/v1/session');
  expect((await page.request.get('/api/v1/admin/system')).status()).toBe(401);
});
