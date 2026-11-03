import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';
import { ENFORCE_BUDGETS, expectWithinBudget } from './budget';

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
test.skip(
  ({ isMobile, browserName }) => isMobile || browserName !== 'chromium',
  'one setup per backend; desktop Chromium runs it',
);

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
  // Exact: "Sign in with <provider>" buttons sit next to it once single sign-on is set up.
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** New contexts need the base URL the project configured. */
const at = (baseURL: string | undefined) => (baseURL ? { baseURL } : {});

const heading = (page: Page) => page.getByRole('heading', { level: 1 });

async function signOutThroughMenu(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(heading(page)).toHaveText('Sign in');
}

/** Creates a person with a password, as the administrator, and leaves nobody signed in. */
async function createPerson(
  request: APIRequestContext,
  who: { name: string; email: string; password: string },
) {
  await signInThroughApi(request, ADMIN);
  const created = await request.post('/api/v1/users', {
    data: { email: who.email, name: who.name, password: who.password },
  });
  expect(created.status()).toBe(201);
  expect((await request.delete('/api/v1/session')).status()).toBe(204);
}

// An authenticator app, in a few lines: RFC 6238 with HMAC-SHA-1, 6 digits, 30-second steps.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.replace(/[\s=]/g, '').toUpperCase()) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totp(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const usedSteps = new Map<string, number>();
const currentStep = () => Math.floor(Date.now() / 30_000);

/**
 * A code the backend has not accepted yet: each time step works once, and the backend allows
 * one step of clock drift, so the next code may come from the step ahead. Waits only when even
 * that one is used up.
 */
async function freshCode(secret: string): Promise<string> {
  const step = Math.max(currentStep(), (usedSteps.get(secret) ?? -1) + 1);
  while (step > currentStep() + 1) await new Promise((resolve) => setTimeout(resolve, 500));
  usedSteps.set(secret, step);
  return totp(secret, step);
}

/** The setup key shown next to the QR code, in groups of four. */
const SETUP_KEY = /^[A-Z2-7]{4}( [A-Z2-7]{1,4})+$/;

async function readSetupKey(page: Page): Promise<string> {
  const key = page.getByText(SETUP_KEY);
  await expect(key).toBeVisible();
  return ((await key.textContent()) ?? '').replace(/\s/g, '');
}

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

  // Site administrators must use a second factor from the start (ASVS 4.3.1; the user's decision
  // of 2026-11-01): the Security page shows it. The fresh-install run (tools/image/fresh-vm.sh)
  // enrols one at the next sign-in; this serial file turns it off for the journeys after it,
  // and its two-factor tests set the policy they need.
  await page.goto('./#/admin/security');
  const form = page.getByRole('form', { name: 'Two-factor authentication' });
  await expect(form.getByRole('radio', { name: 'Site administrators' })).toBeChecked();
  const off = await page.request.put('/api/v1/security/two-factor', {
    data: { required: 'none', groupIds: [] },
  });
  expect(off.status()).toBe(200);
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

test('[IAM-007] a person creates an API token on the Account page, uses it and revokes it', async ({
  page,
  playwright,
  baseURL,
}) => {
  await signInThroughApi(page.request, ADMIN);
  await page.goto('./#/account');
  await expect(heading(page)).toHaveText('Account');
  const tokens = page.getByRole('region', { name: 'API tokens' });
  await tokens.getByLabel('Token name').fill('E2E script');
  await expect(tokens.getByRole('checkbox', { name: 'Read' })).toBeChecked();
  await tokens.getByLabel('Expires after').selectOption('7');
  await tokens.getByRole('button', { name: 'Create token' }).click();

  // Shown once, focused, shaped for secret scanners.
  const secret = tokens.getByLabel('New token', { exact: true });
  await expect(secret).toBeFocused();
  const token = await secret.inputValue();
  expect(token).toMatch(/^tmk_[0-9A-Za-z]{46}$/);

  // A program without cookies uses it, within its read scope.
  const program = await playwright.request.newContext({
    ...at(baseURL),
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
  const me = await program.get('/api/v1/session');
  expect(me.status()).toBe(200);
  expect((await me.json()).user.email).toBe(ADMIN.email);
  const write = await program.patch('/api/v1/account', { data: { name: 'Changed by a script' } });
  expect(write.status()).toBe(403);
  expect(await write.json()).toEqual({ error: 'insufficient_scope', requiredScope: 'write' });
  expect((await program.get('/api/v1/users')).status()).toBe(403);

  await tokens.getByRole('button', { name: 'Done' }).click();
  await expect(tokens.getByLabel('New token', { exact: true })).toHaveCount(0);
  await tokens.getByRole('button', { name: 'Revoke E2E script' }).click();
  await expect(tokens.getByText('Revoked E2E script.')).toBeVisible();
  const item = tokens.getByRole('listitem').filter({ hasText: 'E2E script' });
  await expect(item).toContainText('Revoked');
  await expect(item).toContainText('Last used');
  const refused = await program.get('/api/v1/session');
  expect(refused.status()).toBe(401);
  expect(await refused.json()).toEqual({ error: 'invalid_token', reason: 'revoked' });
  await program.dispose();
});

test('[IAM-007] the administrator revokes every token of a person at once from the token page', async ({
  page,
  playwright,
  baseURL,
}) => {
  const SAGE = {
    name: 'Sage Rivera',
    email: 'sage@example.com',
    password: 'a third long passphrase',
  };
  await signInThroughApi(page.request, ADMIN);
  const created = await page.request.post('/api/v1/users', { data: SAGE });
  expect(created.status()).toBe(201);
  const sageId = (await created.json()).user.id as number;

  // Sage gives two scripts a token each.
  const sage = await playwright.request.newContext(at(baseURL));
  await signInThroughApi(sage, SAGE);
  const secrets: string[] = [];
  for (const name of ['Backup script', 'Chat bot']) {
    const res = await sage.post('/api/v1/account/tokens', {
      data: { name, scopes: ['read'], expiresInDays: 30 },
    });
    expect(res.status()).toBe(201);
    secrets.push((await res.json()).token);
  }
  await sage.dispose();
  const program = await playwright.request.newContext(at(baseURL));
  const use = (token: string) =>
    program.get('/api/v1/session', { headers: { authorization: `Bearer ${token}` } });
  for (const token of secrets) expect((await use(token)).status()).toBe(200);

  await page.goto('./#/settings');
  await page.getByRole('link', { name: 'API tokens' }).click();
  await expect(heading(page)).toHaveText('API tokens');
  const list = page.getByRole('region', { name: 'Tokens', exact: true });
  await expect(list.getByRole('listitem').filter({ hasText: 'Backup script' })).toContainText(
    'Sage Rivera (sage@example.com)',
  );
  const bulk = page.getByRole('region', { name: 'Revoke in bulk' });
  await bulk.getByLabel('Owner', { exact: true }).selectOption(String(sageId));
  await bulk.getByRole('button', { name: 'Revoke tokens' }).click();
  await expect(
    bulk.getByText('This revokes 2 active tokens. Programs using them stop working at once.'),
  ).toBeVisible();
  await bulk.getByRole('button', { name: 'Confirm revocation' }).click();
  await expect(bulk.getByText('Revoked 2 tokens.')).toBeVisible();
  for (const token of secrets) {
    const res = await use(token);
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token', reason: 'revoked' });
  }
  await expect(list.getByRole('listitem').filter({ hasText: 'Chat bot' })).toContainText('Revoked');
  await program.dispose();

  // Only site administrators reach the inventory.
  await page.request.delete('/api/v1/session');
  expect((await page.request.get('/api/v1/admin/tokens')).status()).toBe(401);
});

test('[IAM-007] a service-account token rotates with an overlap, so the program never stops', async ({
  page,
  playwright,
  baseURL,
}) => {
  await signInThroughApi(page.request, ADMIN);
  await page.goto('./#/settings');
  await page.getByRole('link', { name: 'Service accounts' }).click();
  await expect(heading(page)).toHaveText('Service accounts');
  const create = page.getByRole('region', { name: 'New service account' });
  await create.getByLabel('Name').fill('E2E robot');
  await create.getByLabel('What it is for').fill('Publishes release notes');
  await create.getByRole('button', { name: 'Create service account' }).click();
  await expect(create.getByText('Created E2E robot.')).toBeVisible();

  const panel = page.getByRole('region', { name: 'Tokens of E2E robot' });
  await panel.getByLabel('Token name').fill('Release key');
  await panel.getByRole('checkbox', { name: 'Write' }).check();
  await panel.getByRole('button', { name: 'Create token' }).click();
  const first = await panel.getByLabel('New token', { exact: true }).inputValue();
  expect(first).toMatch(/^tmk_[0-9A-Za-z]{46}$/);
  await panel.getByRole('button', { name: 'Done' }).click();

  const program = await playwright.request.newContext(at(baseURL));
  const use = (token: string) =>
    program.get('/api/v1/session', { headers: { authorization: `Bearer ${token}` } });
  const me = await use(first);
  expect(me.status()).toBe(200);
  expect((await me.json()).user).toMatchObject({ name: 'E2E robot', isSiteAdmin: false });
  // A service account never signs in with a password.
  const signIn = await program.post('/api/v1/session', {
    data: { email: 'e2e-robot@service.invalid', password: 'a long enough passphrase' },
  });
  expect(signIn.status()).toBe(401);

  await panel.getByLabel('After rotating, the old token keeps working for').selectOption('1');
  await panel.getByRole('button', { name: 'Rotate Release key' }).click();
  await expect(panel.getByText('Rotated Release key. Copy the new token now.')).toBeVisible();
  const second = await panel.getByLabel('New token', { exact: true }).inputValue();
  expect(second).not.toBe(first);
  // During the overlap both work; the old one is marked as replaced.
  expect((await use(first)).status()).toBe(200);
  expect((await use(second)).status()).toBe(200);
  await expect(panel.getByRole('listitem').filter({ hasText: 'Replaced' })).toHaveCount(1);

  // Deactivating the service account stops every token at once.
  await page.getByRole('button', { name: 'Deactivate E2E robot' }).click();
  await expect(page.getByRole('button', { name: 'Reactivate E2E robot' })).toBeVisible();
  for (const token of [first, second]) {
    expect(await (await use(token)).json()).toEqual({
      error: 'invalid_token',
      reason: 'owner_deactivated',
    });
  }
  await program.dispose();
});

test('[IAM-001] a person turns on an authenticator app and signs in with a code, then a recovery code', async ({
  page,
}) => {
  const INES = { name: 'Ines Duarte', email: 'ines@example.com', password: 'a tidy row of mint' };
  await createPerson(page.request, INES);
  await page.goto('./#/sign-in');
  await signInThroughForm(page, INES);
  await expect(heading(page)).toHaveText('Home');

  await page.goto('./#/account');
  const twoFactor = page.getByRole('region', { name: 'Two-factor authentication' });
  await expect(twoFactor.getByText('Two-factor authentication is off.')).toBeVisible();
  await twoFactor.getByRole('button', { name: 'Set up authenticator app' }).click();
  await expect(
    twoFactor.getByRole('img', { name: 'QR code for your authenticator app' }),
  ).toBeVisible();
  const secret = await readSetupKey(page);
  await twoFactor.getByLabel('Code from the app').fill(await freshCode(secret));
  await twoFactor.getByRole('button', { name: 'Turn on' }).click();

  // The recovery codes are shown once, with the first factor.
  const saveCodes = twoFactor.getByRole('region', { name: 'Save your recovery codes' });
  const codeList = saveCodes.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(codeList).toHaveCount(10);
  const recoveryCodes = await codeList.allTextContents();
  for (const code of recoveryCodes) expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  await expect(saveCodes.getByRole('button', { name: 'Done' })).toBeDisabled();
  await saveCodes.getByRole('checkbox', { name: 'I have saved these codes' }).check();
  await saveCodes.getByRole('button', { name: 'Done' }).click();
  await expect(twoFactor.getByText('Two-factor authentication is on.')).toBeVisible();
  await expect(twoFactor.getByText('10 recovery codes left.')).toBeVisible();

  // The password alone no longer starts a session.
  await signOutThroughMenu(page, INES.name);
  await signInThroughForm(page, INES);
  const step = page.getByRole('form', { name: 'Two-factor authentication' });
  const code = step.getByLabel('Authentication code');
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  expect((await page.request.get('/api/v1/session')).status()).toBe(401);
  await code.fill(await freshCode(secret));
  await step.getByRole('button', { name: 'Verify' }).click();
  await expect(heading(page)).toHaveText('Home');

  // A recovery code signs in once.
  const [first, second] = recoveryCodes as [string, string];
  await signOutThroughMenu(page, INES.name);
  await signInThroughForm(page, INES);
  await step.getByRole('button', { name: 'Use a recovery code' }).click();
  await step.getByLabel('Recovery code', { exact: true }).fill(first);
  await step.getByRole('button', { name: 'Verify' }).click();
  await expect(heading(page)).toHaveText('Home');
  await page.goto('./#/account');
  await expect(twoFactor.getByText('9 recovery codes left.')).toBeVisible();

  await signOutThroughMenu(page, INES.name);
  await signInThroughForm(page, INES);
  await step.getByRole('button', { name: 'Use a recovery code' }).click();
  await step.getByLabel('Recovery code', { exact: true }).fill(first);
  await step.getByRole('button', { name: 'Verify' }).click();
  await expect(step.getByRole('alert')).toHaveText(
    'That recovery code is not valid or was already used.',
  );
  await step.getByLabel('Recovery code', { exact: true }).fill(second.toLowerCase());
  await step.getByRole('button', { name: 'Verify' }).click();
  await expect(heading(page)).toHaveText('Home');
});

test('[IAM-001] a person registers a security key and signs in with it', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'the virtual authenticator is a Chromium tool');
  // Chromium's virtual authenticator stands in for a USB key that is touched at once.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'usb',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });

  const OMAR = {
    name: 'Omar Haddad',
    email: 'omar@example.com',
    password: 'lanterns over the bay',
  };
  await createPerson(page.request, OMAR);
  await page.goto('./#/sign-in');
  await signInThroughForm(page, OMAR);
  await expect(heading(page)).toHaveText('Home');

  await page.goto('./#/account');
  const twoFactor = page.getByRole('region', { name: 'Two-factor authentication' });
  await twoFactor.getByRole('button', { name: 'Add a security key' }).click();
  await twoFactor.getByLabel('Name of the key').fill('Desk key');
  await twoFactor.getByRole('button', { name: 'Register key' }).click();

  // The key is the first factor, so recovery codes come with it.
  const saveCodes = twoFactor.getByRole('region', { name: 'Save your recovery codes' });
  await expect(saveCodes.getByRole('listitem')).toHaveCount(10);
  await saveCodes.getByRole('checkbox', { name: 'I have saved these codes' }).check();
  await saveCodes.getByRole('button', { name: 'Done' }).click();
  await expect(twoFactor.getByText('Two-factor authentication is on.')).toBeVisible();
  const key = twoFactor.getByRole('listitem').filter({ hasText: 'Desk key' });
  await expect(key).toContainText('Not used yet');

  await signOutThroughMenu(page, OMAR.name);
  await signInThroughForm(page, OMAR);
  const step = page.getByRole('form', { name: 'Two-factor authentication' });
  await expect(step.getByText('Use your security key to finish signing in.')).toBeVisible();
  await expect(step.getByLabel('Authentication code')).toHaveCount(0);
  await step.getByRole('button', { name: 'Use a security key' }).click();
  await expect(heading(page)).toHaveText('Home');

  // Removing the key asks for the password; without a factor, two-factor is off again.
  await page.goto('./#/account');
  await expect(key).toContainText('Last used');
  await twoFactor.getByRole('button', { name: 'Remove Desk key' }).click();
  const confirm = twoFactor.getByRole('form', { name: 'Remove Desk key' });
  await confirm.getByLabel('Current password', { exact: true }).fill(OMAR.password);
  await confirm.getByRole('button', { name: 'Remove' }).click();
  await expect(twoFactor.getByText('Removed Desk key.')).toBeVisible();
  await expect(twoFactor.getByText('Two-factor authentication is off.')).toBeVisible();
  await expect(twoFactor.getByText('No security keys yet.')).toBeVisible();
});

test('[IAM-001] when the policy covers everyone, a person without a second factor enrols at sign-in', async ({
  page,
  browser,
  baseURL,
}) => {
  const THEO = {
    name: 'Theo Lindqvist',
    email: 'theo@example.com',
    password: 'copper kettles hum',
  };
  await createPerson(page.request, THEO);
  await signInThroughApi(page.request, ADMIN);
  const savePolicy = () =>
    page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/security/two-factor') && r.request().method() === 'PUT',
    );
  try {
    await page.goto('./#/settings');
    await page.getByRole('link', { name: 'Security' }).click();
    await expect(heading(page)).toHaveText('Security');
    const policy = page.getByRole('form', { name: 'Two-factor authentication' });
    const nobody = policy.getByRole('radio', { name: 'Nobody: everyone decides for themselves' });
    await expect(nobody).toBeChecked();
    await policy.getByRole('radio', { name: 'Everyone', exact: true }).check();
    const saved = savePolicy();
    await policy.getByRole('button', { name: 'Save policy' }).click();
    expect((await saved).status()).toBe(200);
    await expect(policy.getByRole('status')).toHaveText('Policy saved.');

    // Theo signs in on a phone: the app must be set up before the session starts.
    const context = await browser.newContext({
      ...devices['Pixel 7'],
      viewport: { width: 360, height: 740 },
      ...at(baseURL),
    });
    const phone = await context.newPage();
    await phone.goto('./#/sign-in');
    await signInThroughForm(phone, THEO);
    await expect(
      phone.getByRole('heading', { level: 2, name: 'Set up two-factor authentication' }),
    ).toBeVisible();
    await expect(
      phone.getByText(/Your administrator requires two-factor authentication/),
    ).toBeVisible();
    expect((await context.request.get('/api/v1/session')).status()).toBe(401);
    await expect(
      phone.getByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeVisible();
    expect(
      await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    const secret = await readSetupKey(phone);
    await phone.getByLabel('Code from the app').fill(await freshCode(secret));
    await phone.getByRole('button', { name: 'Verify and continue' }).click();

    const saveCodes = phone.getByRole('region', { name: 'Save your recovery codes' });
    await expect(saveCodes.getByRole('listitem')).toHaveCount(10);
    await expect(saveCodes.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await saveCodes.getByRole('checkbox', { name: 'I have saved these codes' }).check();
    await saveCodes.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(phone)).toHaveText('Home');
    expect((await context.request.get('/api/v1/session')).status()).toBe(200);

    // The app is Theo's only factor and the policy requires one: it stays on.
    await phone.goto('./#/account');
    const twoFactor = phone.getByRole('region', { name: 'Two-factor authentication' });
    await expect(twoFactor.getByRole('button', { name: 'Switch off the app' })).toBeDisabled();
    await expect(twoFactor.getByText(/so your last method cannot be switched off/)).toBeVisible();
    await context.close();

    // Back to nobody, through the page.
    await nobody.check();
    const reset = savePolicy();
    await policy.getByRole('button', { name: 'Save policy' }).click();
    expect((await reset).status()).toBe(200);
  } finally {
    // Whatever happened above, later tests sign the administrator in with a password alone.
    const reset = await page.request.put('/api/v1/security/two-factor', {
      data: { required: 'none', groupIds: [] },
    });
    expect(reset.status()).toBe(200);
  }
});

test('[IAM-008] the chosen skin is painted at once and follows the person to another browser', async ({
  page,
  browser,
  baseURL,
}) => {
  await signInThroughApi(page.request, ADMIN);
  await page.goto('./#/account');
  const appearance = page.getByRole('region', { name: 'Appearance' });
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/account') && r.request().method() === 'PATCH',
  );
  await appearance.getByRole('radio', { name: 'Dark' }).check();
  expect((await saved).status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'dark');

  // A reload is dark from the first paint: the boot script runs before the app.
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.skin)).toBe('dark');
  await expect(appearance.getByRole('radio', { name: 'Dark' })).toBeChecked();

  // Another browser, light by default, turns dark when the person signs in there.
  const other = await browser.newContext({ ...at(baseURL), colorScheme: 'light' });
  const phone = await other.newPage();
  await phone.goto('./');
  await expect(phone.locator('html')).toHaveAttribute('data-skin', 'light');
  await signInThroughApi(other.request, ADMIN);
  await phone.reload();
  await expect(phone.locator('html')).toHaveAttribute('data-skin', 'dark');
  await other.close();

  // Back to System for whatever runs next.
  await appearance.getByRole('radio', { name: 'System' }).check();
  await expect(appearance.getByText('Appearance saved to your account.')).toBeVisible();
});

// The fake provider of e2e/api-server.ts (M1-080): it signs in one person, Sam, at sso.test.
const IDP = {
  issuer: 'http://127.0.0.1:8788',
  clientId: 'taskmoor-e2e',
  clientSecret: 'e2e-client-secret-0123456789',
};
const SAM = { name: 'Sam Rivera', email: 'sam@sso.test' };

/** Opens the provider's editor on the admin page, changes it and saves. */
async function editProvider(
  page: Page,
  change: (form: ReturnType<Page['getByRole']>) => Promise<void>,
) {
  await page.goto('./#/admin/identity-providers');
  await page.getByRole('button', { name: 'Edit Staff accounts' }).click();
  const form = page.getByRole('form', { name: 'Edit Staff accounts' });
  await change(form);
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved Staff accounts.')).toBeVisible();
}

test('[IAM-003] [IAM-004] the administrator adds an identity provider; people sign in with it, and only with it once enforced', async ({
  page,
}) => {
  await signInThroughApi(page.request, ADMIN);
  await page.goto('./#/settings');
  await page.getByRole('link', { name: 'Single sign-on' }).click();
  await expect(heading(page)).toHaveText('Single sign-on');
  // The address to register at the provider comes from the backend's public URL.
  await expect(page.getByRole('textbox', { name: 'Redirect URI to register' })).toHaveValue(
    'http://localhost:4173/api/v1/auth/oidc/callback',
  );

  // At first the provider only signs in people who already have an account.
  await page.getByRole('button', { name: 'Add an identity provider' }).click();
  const form = page.getByRole('form', { name: 'New identity provider' });
  await form.getByLabel('Name', { exact: true }).fill('Staff accounts');
  await form.getByLabel('Issuer URL').fill(IDP.issuer);
  await form.getByLabel('Client ID').fill(IDP.clientId);
  await form.getByLabel('Client secret', { exact: true }).fill(IDP.clientSecret);
  await form.getByLabel('Domain', { exact: true }).fill('sso.test');
  await form.getByLabel('Domain', { exact: true }).press('Enter');
  await form.getByRole('checkbox', { name: 'Create accounts at a first sign-in' }).uncheck();
  await form.getByRole('button', { name: 'Add provider' }).click();
  await expect(page.getByText('Added Staff accounts.')).toBeVisible();
  await expect(page.getByText('Only existing accounts sign in')).toBeVisible();

  try {
    // Signed out, the sign-in page offers the provider. Sam has no account here yet, so the
    // round trip ends back on the sign-in page with the reason, which the address then loses.
    await signOutThroughMenu(page, ADMIN.name);
    await page.getByRole('button', { name: 'Sign in with Staff accounts' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'There is no account for you here yet. Ask your administrator to create one. If you were invited, sign in with the very address the invitation went to.',
    );
    await expect.poll(() => new URL(page.url()).hash).toBe('#/sign-in');

    // With accounts created at a first sign-in, Sam gets one and lands on the start page.
    await signInThroughForm(page, ADMIN);
    await expect(page.getByRole('button', { name: ADMIN.name, exact: true })).toBeVisible();
    await editProvider(page, (edit) =>
      edit.getByRole('checkbox', { name: 'Create accounts at a first sign-in' }).check(),
    );
    await signOutThroughMenu(page, ADMIN.name);
    await page.getByRole('button', { name: 'Sign in with Staff accounts' }).click();
    await expect(page.getByRole('button', { name: SAM.name, exact: true })).toBeVisible();
    await expect(heading(page)).toHaveText('Home');
    await signOutThroughMenu(page, SAM.name);

    // Enforced: the email leads to the provider, the password field goes away, and the backend
    // refuses a password for the domain whatever the page shows.
    await signInThroughForm(page, ADMIN);
    await expect(page.getByRole('button', { name: ADMIN.name, exact: true })).toBeVisible();
    await editProvider(page, (edit) =>
      edit.getByRole('checkbox', { name: 'Enforce single sign-on for these domains' }).check(),
    );
    await signOutThroughMenu(page, ADMIN.name);
    await page.getByLabel('Email').fill(SAM.email);
    await page.getByLabel('Email').blur();
    await expect(page.getByText('This address signs in with Staff accounts.')).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
    const refused = await page.request.post('/api/v1/session', {
      data: { email: SAM.email, password: 'any password at all' },
    });
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'sso_required' });
    await page.getByLabel('Email').press('Enter');
    await expect(page.getByRole('button', { name: SAM.name, exact: true })).toBeVisible();
    await signOutThroughMenu(page, SAM.name);

    // Deleted through the page, after confirmation: the sign-in page offers nothing again.
    await signInThroughForm(page, ADMIN);
    await expect(page.getByRole('button', { name: ADMIN.name, exact: true })).toBeVisible();
    await page.goto('./#/admin/identity-providers');
    await page.getByRole('button', { name: 'Delete Staff accounts' }).click();
    await page.getByRole('button', { name: 'Delete provider' }).click();
    await expect(page.getByText('Deleted Staff accounts.')).toBeVisible();
    await signOutThroughMenu(page, ADMIN.name);
    await expect(page.getByRole('button', { name: 'Sign in with Staff accounts' })).toHaveCount(0);
  } finally {
    // Whatever failed above, later runs against a reused backend start without the provider.
    await signInThroughApi(page.request, ADMIN);
    const listed = await page.request.get('/api/v1/identity-providers');
    for (const p of ((await listed.json()) as { providers: { id: number }[] }).providers) {
      await page.request.delete(`/api/v1/identity-providers/${p.id}`);
    }
    await page.request.delete('/api/v1/session');
  }
});

// The SAML provider of e2e/api-server.ts (M1-081): it signs in one person, Riley, at saml.test.
const SAML_IDP = 'http://127.0.0.1:8789';
const RILEY = { name: 'Riley Chen' };

test('[IAM-002] the administrator adds a SAML identity provider from its metadata; people sign in through it', async ({
  page,
}) => {
  await signInThroughApi(page.request, ADMIN);
  await page.goto('./#/admin/identity-providers');
  await page.getByRole('button', { name: 'Add an identity provider' }).click();
  const form = page.getByRole('form', { name: 'New identity provider' });
  await form.getByLabel('Name', { exact: true }).fill('Partner SAML');
  await form.getByRole('radio', { name: 'SAML 2.0' }).check();
  const metadata = await (await page.request.get(`${SAML_IDP}/metadata`)).text();
  await form.getByLabel('Identity provider metadata').fill(metadata);
  await form.getByLabel('Domain', { exact: true }).fill('saml.test');
  await form.getByLabel('Domain', { exact: true }).press('Enter');
  await form.getByRole('button', { name: 'Add provider' }).click();
  await expect(page.getByText('Added Partner SAML.')).toBeVisible();
  // The addresses to register at the identity provider, from the backend's public URL.
  await expect(
    page.getByText(/^http:\/\/localhost:4173\/api\/v1\/auth\/saml\/\d+\/acs$/),
  ).toBeVisible();

  try {
    // The provider's page posts the response across sites; the browser that started the
    // sign-in then collects it, with the cookie a cross-site POST would not carry.
    await signOutThroughMenu(page, ADMIN.name);
    await page.getByRole('button', { name: 'Sign in with Partner SAML' }).click();
    await expect(page.getByRole('button', { name: RILEY.name, exact: true })).toBeVisible();
    await expect(heading(page)).toHaveText('Home');
    await signOutThroughMenu(page, RILEY.name);

    // The next sign-in finds Riley's account again, by the provider's persistent name ID.
    await page.getByRole('button', { name: 'Sign in with Partner SAML' }).click();
    await expect(page.getByRole('button', { name: RILEY.name, exact: true })).toBeVisible();
    await signOutThroughMenu(page, RILEY.name);
  } finally {
    await signInThroughApi(page.request, ADMIN);
    const listed = await page.request.get('/api/v1/identity-providers');
    for (const p of ((await listed.json()) as { providers: { id: number }[] }).providers) {
      await page.request.delete(`/api/v1/identity-providers/${p.id}`);
    }
    await page.request.delete('/api/v1/session');
  }
});

test('[CORE-025] [OPS-009] the administrator undeletes a ticket and a whole track from the trash', async ({
  page,
}) => {
  await signInThroughApi(page.request, ADMIN);
  const track = await page.request.post('/api/v1/tracks', {
    data: { key: 'BIN', name: 'Bin', mode: 'shared' },
  });
  expect(track.status()).toBe(201);
  const trackId = ((await track.json()) as { track: { id: number } }).track.id;
  const created = await page.request.post('/api/v1/tickets', {
    data: { track: 'BIN', summary: 'Deleted by mistake' },
  });
  expect(created.status()).toBe(201);
  const { key } = ((await created.json()) as { ticket: { key: string } }).ticket;
  await page.request.patch(`/api/v1/tickets/${key}`, {
    data: { summary: 'Deleted by mistake, renamed' },
  });
  expect((await page.request.delete(`/api/v1/tickets/${key}`)).status()).toBe(204);

  await page.goto('./#/settings');
  await page.getByRole('link', { name: 'Trash' }).click();
  await expect(heading(page)).toHaveText('Trash');
  await expect(page.getByText(/wait here for 30 days/)).toBeVisible();
  const tickets = page.getByRole('region', { name: 'Tickets' });
  await expect(tickets.getByText(`${key} Deleted by mistake, renamed`)).toBeVisible();
  await tickets.getByRole('button', { name: `Restore ${key}` }).click();
  await expect(page.getByText(`${key} is back.`)).toBeVisible();
  await expect(tickets.getByText(`${key} Deleted by mistake, renamed`)).toHaveCount(0);
  // It came back with its history: the edit, the deletion and the restore.
  const restored = await page.request.get(`/api/v1/tickets/${key}`);
  expect(((await restored.json()) as { ticket: { trash: unknown } }).ticket.trash).toBeNull();
  const history = await page.request.get(`/api/v1/tickets/${key}/history?order=asc`);
  const fields = ((await history.json()) as { changes: { field: string }[] }).changes.map(
    (c) => c.field,
  );
  expect(fields.filter((f) => f === 'summary').length).toBe(2);
  expect(fields.filter((f) => f === 'trash')).toEqual(['trash', 'trash']);

  // The whole track goes to the trash: its tickets with it, then back.
  expect((await page.request.delete(`/api/v1/tracks/${trackId}`)).status()).toBe(204);
  expect((await page.request.get(`/api/v1/tickets/${key}`)).status()).toBe(404);
  await page.reload();
  const tracks = page.getByRole('region', { name: 'Tracks' });
  await expect(tracks.getByText('BIN Bin (1 ticket)')).toBeVisible();
  await tracks.getByRole('button', { name: 'Restore track BIN' }).click();
  await expect(page.getByText('Track BIN is back.')).toBeVisible();
  await expect(tracks.getByText('No tracks in the trash.')).toBeVisible();
  expect((await page.request.get(`/api/v1/tickets/${key}`)).status()).toBe(200);
  await page.request.delete('/api/v1/session');
});

// The directory of e2e/api-server.ts (M1-082): Morgan and Noor in Designers, inside Studio. Its
// passwords are made per run by playwright.config.ts.
const LDAP_URL = 'ldap://127.0.0.1:8790';
const MORGAN = { name: 'Morgan Lee', email: 'morgan@ldap.test' };

test('[IAM-005] the administrator adds a directory; it syncs and its people sign in with their directory password', async ({
  page,
}) => {
  await signInThroughApi(page.request, ADMIN);
  await page.goto('./#/settings');
  await page.getByRole('link', { name: 'LDAP and Active Directory' }).click();
  await expect(heading(page)).toHaveText('LDAP and Active Directory');
  await page.getByRole('button', { name: 'Add a directory' }).click();
  const form = page.getByRole('form', { name: 'New directory' });
  await form.getByLabel('Name', { exact: true }).fill('Studio LDAP');
  await form.getByRole('radio', { name: 'OpenLDAP' }).check();
  await form.getByLabel('URL', { exact: true }).fill(LDAP_URL);
  await form.getByLabel('Bind DN', { exact: true }).fill('cn=sync,dc=e2e,dc=test');
  await form
    .getByLabel('Password', { exact: true })
    .fill(process.env.TASKMOOR_E2E_LDAP_BIND_PASSWORD as string);
  await form.getByLabel('Base DN', { exact: true }).fill('dc=e2e,dc=test');
  await form.getByRole('button', { name: 'Test connection' }).click();
  await expect(form.getByText('Connected. 2 people and 2 groups match the filters.')).toBeVisible();
  await form.getByRole('button', { name: 'Add directory' }).click();
  await expect(page.getByText('Added Studio LDAP. Its first sync starts shortly.')).toBeVisible();

  try {
    // The worker runs the first sync; the page looks again until it has.
    await expect(page.getByText('2 accounts, 2 groups')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Sync Studio LDAP now' }).click();
    await expect(page.getByText('A sync of Studio LDAP is on its way.')).toBeVisible();
    await expect(page.getByText(/^Sync .*: nothing changed$/)).toBeVisible({ timeout: 30_000 });

    // Morgan has no Taskmoor password: the directory checks the one typed here.
    await signOutThroughMenu(page, ADMIN.name);
    await signInThroughForm(page, {
      email: MORGAN.email,
      password: process.env.TASKMOOR_E2E_LDAP_USER_PASSWORD as string,
    });
    await expect(page.getByRole('button', { name: MORGAN.name, exact: true })).toBeVisible();
    await expect(heading(page)).toHaveText('Home');
    await signOutThroughMenu(page, MORGAN.name);
  } finally {
    await signInThroughApi(page.request, ADMIN);
    const listed = await page.request.get('/api/v1/directories');
    for (const d of ((await listed.json()) as { directories: { id: number }[] }).directories) {
      await page.request.delete(`/api/v1/directories/${d.id}`);
    }
    await page.request.delete('/api/v1/session');
  }
});

test("[CORE-013] [CORE-008] the create form follows the track's field rules: required for Bugs only, hidden never shown", async ({
  page,
}) => {
  await signInThroughApi(page.request, ADMIN);
  const track = await page.request.post('/api/v1/tracks', {
    data: { key: 'FORM', name: 'Forms', mode: 'shared' },
  });
  expect(track.status()).toBe(201);
  const trackId = ((await track.json()) as { track: { id: number } }).track.id;
  const types = (
    (await (await page.request.get('/api/v1/tracks/FORM/ticket-types')).json()) as {
      ticketTypes: { id: number; name: string }[];
    }
  ).ticketTypes;
  const bug = types.find((t) => t.name === 'Bug')?.id as number;
  const field = await page.request.post('/api/v1/fields', {
    data: {
      name: 'Severity',
      type: 'select',
      context: { trackIds: [trackId], options: [{ value: 'Blocker' }, { value: 'Minor' }] },
    },
  });
  expect(field.status()).toBe(201);
  const fieldId = ((await field.json()) as { field: { id: number } }).field.id;
  const rules = await page.request.post('/api/v1/field-rule-sets', {
    data: {
      name: 'Form rules',
      rules: [
        { ticketTypeId: bug, field: 'dueDate', required: true },
        { ticketTypeId: bug, field: `cf[${fieldId}]`, required: true },
        { ticketTypeId: null, field: 'environment', hidden: true },
      ],
    },
  });
  expect(rules.status()).toBe(201);
  const ruleSetId = ((await rules.json()) as { fieldRuleSet: { id: number } }).fieldRuleSet.id;
  expect(
    (
      await page.request.patch(`/api/v1/tracks/${trackId}`, {
        data: { fieldRuleSetId: ruleSetId },
      })
    ).status(),
  ).toBe(200);

  await page.goto('./#/create');
  await expect(heading(page)).toHaveText('Create ticket');
  await page.getByLabel('Track').selectOption({ label: 'FORM Forms' });
  await page.getByLabel('Ticket type').selectOption({ label: 'Bug' });
  await expect(page.getByLabel('Due date (required)')).toBeVisible();
  await expect(page.getByLabel('Severity (required)')).toBeVisible();
  // Hidden by the rules: not on the form at all.
  await expect(page.getByLabel('Environment')).toHaveCount(0);
  // The backend refuses what is missing, at each field (CORE-008 (3)).
  await page.getByLabel('Summary (required)').fill('Checkout fails');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(
    page.getByText('Some fields need attention before the ticket can be created.'),
  ).toBeVisible();
  await expect(page.getByLabel('Due date (required)')).toHaveAccessibleDescription(
    'This field is required.',
  );
  await expect(page.getByLabel('Severity (required)')).toHaveAccessibleDescription(
    'This field is required.',
  );
  await page.getByLabel('Due date (required)').fill('2026-12-01');
  await page.getByLabel('Severity (required)').selectOption({ label: 'Blocker' });
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('FORM-1 was created.')).toBeVisible();
  const created = (await (await page.request.get('/api/v1/tickets/FORM-1')).json()) as {
    ticket: { dueDate: string; fields: Record<string, { value: string }> };
  };
  expect(created.ticket.dueDate).toBe('2026-12-01');
  expect(created.ticket.fields[String(fieldId)]?.value).toBe('Blocker');

  // A Chore needs neither: optional there, so a summary is enough.
  await page.getByLabel('Ticket type').selectOption({ label: 'Chore' });
  await expect(page.getByLabel('Due date', { exact: true })).toBeVisible();
  await page.getByLabel('Summary (required)').fill('Tidy the cart code');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('FORM-2 was created.')).toBeVisible();
  await page.request.delete('/api/v1/session');
});

/** axe on the page as it stands: its serious and critical violations, each with its count. */
const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
async function seriousAxeViolations(page: Page): Promise<string[]> {
  // Evaluated, not a script element, which the app's content security policy refuses (M1-107).
  await page.evaluate(readFileSync(AXE, 'utf8'));
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (context: Document) => Promise<{
            violations: { id: string; impact?: string | null; nodes: unknown[] }[];
          }>;
        };
      }
    ).axe;
    const { violations } = await axe.run(document);
    return violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} (${v.nodes.length})`);
  });
}

// The workflow editor (M1-030): a workflow built in the browser, checked, published, and read
// back through the API with its rules.
test('[WF-002] [WF-012] the administrator builds a workflow with rules in the editor, fixes an unreachable status and publishes it, with no serious axe issue', async ({
  page,
}) => {
  await signInThroughApi(page.request, ADMIN);
  let workflowId: string | undefined;
  try {
    await page.goto('./#/settings');
    await page.getByRole('link', { name: 'Workflows' }).click();
    await expect(heading(page)).toHaveText('Workflows');
    await page.getByRole('button', { name: 'Create a workflow' }).click();
    const form = page.getByRole('form', { name: 'New workflow' });
    expect(await seriousAxeViolations(page)).toEqual([]);
    await form.getByLabel('Name', { exact: true }).fill('Support flow');
    await expect(form.getByLabel('Initial status')).toHaveValue(/\d+/);
    await form.getByRole('button', { name: 'Create workflow' }).click();
    await expect(heading(page)).toHaveText('Support flow');
    workflowId = /#\/admin\/workflows\/(\d+)/.exec(page.url())?.[1];
    expect(workflowId).toBeTruthy();

    for (const status of ['Active', 'Closed']) {
      await page.getByLabel('Add a status').selectOption({ label: status });
      await page.getByRole('button', { name: 'Add to workflow' }).click();
    }
    const statuses = page.getByRole('list', { name: 'Statuses in this workflow' });
    await expect(statuses.getByRole('button')).toHaveText(['Open', 'Active', 'Closed']);

    // A transition with a guard, a check and an effect.
    await page.getByRole('button', { name: 'Add a transition' }).click();
    await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
    await page.getByLabel('Name', { exact: true }).fill('Start work');
    const panel = page.getByRole('region', { name: 'Transition: Start work' });
    await panel.getByLabel('Goes to').selectOption({ label: 'Active' });
    await panel.getByLabel('New guard').selectOption({ label: 'Holds a track permission' });
    await panel.getByRole('button', { name: 'Add guard' }).click();
    await expect(
      panel.getByRole('group', { name: 'Guard 1: Holds a track permission' }),
    ).toBeVisible();
    await panel.getByLabel('New check').selectOption({ label: 'A field is filled in' });
    await panel.getByRole('button', { name: 'Add check' }).click();
    const check = panel.getByRole('group', { name: 'Check 1: A field is filled in' });
    await check.getByLabel('Field').selectOption({ label: 'Assignee' });
    await panel.getByLabel('New effect').selectOption({ label: 'Assign to the person running it' });
    await panel.getByRole('button', { name: 'Add effect' }).click();
    expect(await seriousAxeViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Saved draft version 2.')).toBeVisible();

    // Nothing leads to Closed yet: the checks say so, and a global transition fixes it.
    const checks = page.getByRole('region', { name: 'Checks before publishing' });
    await expect(
      checks.getByText('No transition leads to Closed: tickets can never get there.'),
    ).toBeVisible();
    await checks.getByRole('button', { name: 'Show Closed' }).click();
    await expect(page.getByRole('heading', { name: 'Status: Closed' })).toBeFocused();
    await page.getByRole('button', { name: 'Add a transition from Closed' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Close');
    const close = page.getByRole('region', { name: 'Transition: Close' });
    await close.getByRole('radio', { name: 'Any status (a global transition)' }).check();
    await close.getByLabel('Goes to').selectOption({ label: 'Closed' });
    await expect(checks.getByText('No problems found.')).toBeVisible();

    // Publishing saves the draft first, then shows what it changes.
    await page.getByRole('button', { name: 'Publish' }).click();
    const publish = page.getByRole('region', { name: 'Publish version 2' });
    await expect(publish.getByText('No track uses this workflow yet.')).toBeVisible();
    expect(await seriousAxeViolations(page)).toEqual([]);
    await publish.getByRole('button', { name: 'Publish now' }).click();
    await expect(
      page.getByText('Version 2 is published. The next transition of every ticket uses it.'),
    ).toBeVisible();
    await expect(page.getByText('Published version 2')).toBeVisible();

    // The published version holds the rules, as the API reads them.
    const read = await page.request.get(`/api/v1/workflows/${workflowId}`);
    expect(read.status()).toBe(200);
    const { workflow } = (await read.json()) as {
      workflow: {
        published: {
          version: number;
          definition: {
            statuses: { statusId: number }[];
            transitions: {
              name: string;
              from: unknown;
              guards?: unknown;
              checks?: unknown;
              effects?: unknown;
            }[];
          };
        };
        draft: unknown;
      };
    };
    expect(workflow.published.version).toBe(2);
    expect(workflow.draft).toBeNull();
    expect(workflow.published.definition.statuses).toHaveLength(3);
    const start = workflow.published.definition.transitions.find((x) => x.name === 'Start work');
    expect(start?.guards).toEqual({
      all: [{ type: 'permission', permission: 'transition_tickets' }],
    });
    expect(start?.checks).toEqual([{ type: 'field-required', field: 'assignee' }]);
    expect(start?.effects).toEqual([{ type: 'assign-to-current-user' }]);
    expect(workflow.published.definition.transitions.find((x) => x.name === 'Close')?.from).toBe(
      'any',
    );
  } finally {
    if (workflowId) await page.request.delete(`/api/v1/workflows/${workflowId}`);
    await page.request.delete('/api/v1/session');
  }
});

test('[WF-002] the workflow editor works on a small phone without sideways scrolling', async ({
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
  const listed = await context.request.get('/api/v1/workflows');
  const { workflows } = (await listed.json()) as {
    workflows: { id: number; isDefault: boolean }[];
  };
  const standard = workflows.find((w) => w.isDefault);
  await page.goto(`./#/admin/workflows/${standard?.id}`);
  await expect(heading(page)).toHaveText('Default workflow');
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);

  const targets = [
    page.getByRole('button', { name: 'Diagram', exact: true }),
    page.getByRole('button', { name: 'Text', exact: true }),
    page.getByRole('button', { name: 'Version history' }),
    page.getByRole('button', { name: 'Show the diagram' }),
    page.getByRole('button', { name: 'Add a transition' }),
    page.getByLabel('Add a status'),
    ...(await page.getByRole('list', { name: 'Transitions' }).getByRole('button').all()),
  ];
  for (const target of targets) {
    expect((await target.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }

  // The diagram scrolls inside its own frame; the page stays put.
  await page.getByRole('button', { name: 'Show the diagram' }).tap();
  const diagram = page.getByRole('region', { name: 'Diagram' });
  await expect(diagram).toBeVisible();
  expect(await diagram.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await overflow()).toBeLessThanOrEqual(0);
  expect(await seriousAxeViolations(page)).toEqual([]);

  await page
    .getByRole('list', { name: 'Transitions' })
    .getByRole('button', { name: 'Close' })
    .tap();
  await expect(page.getByRole('heading', { name: 'Transition: Close' })).toBeFocused();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await context.close();
});

// Workflow files (M1-127): a workflow downloads from the workflows page in Taskmoor's own
// format and comes back in as a new workflow, with a report of what this workspace lacks.
test('[WF-011] the administrator downloads a workflow file and imports it as a new workflow, with a report and no serious axe issue', async ({
  page,
}) => {
  await signInThroughApi(page.request, ADMIN);
  let imported: string | undefined;
  try {
    await page.goto('./#/admin/workflows');
    await expect(heading(page)).toHaveText('Workflows');
    const downloading = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download Default workflow as a workflow file' }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('Default workflow.workflow.json');
    const file = JSON.parse(await readFile((await download.path()) as string, 'utf8')) as {
      format: string;
      version: number;
      workflow: { name: string };
      statuses: { id: number; name: string; stage: string; description: string }[];
      groups?: { id: number; name: string }[];
      definition: {
        statuses: { statusId: number }[];
        transitions: { name: string; guards?: unknown }[];
      };
    };
    expect(file.format).toBe('taskmoor-workflow');
    expect(file.version).toBe(1);
    expect(file.statuses.map((x) => x.name)).toEqual(['New', 'Active', 'In Review', 'Closed']);

    // As another server's file would be: a status and a group this workspace does not have.
    file.workflow.name = 'Imported flow';
    const parked = file.statuses.length + 1;
    file.statuses.push({ id: parked, name: 'Parked', stage: 'new', description: '' });
    file.definition.statuses.push({ statusId: parked });
    file.groups = [{ id: 1, name: 'Night shift' }];
    const first = file.definition.transitions[0] as { name: string; guards?: unknown };
    first.guards = { type: 'user-in-group', group: '1' };

    await page.getByRole('button', { name: 'Import a workflow' }).click();
    const form = page.getByRole('form', { name: 'Import a workflow file' });
    await form.getByLabel('Workflow file').setInputFiles({
      name: 'imported.workflow.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(file)),
    });
    await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Imported flow');
    expect(await seriousAxeViolations(page)).toEqual([]);
    await form.getByRole('button', { name: 'Import', exact: true }).click();

    const report = page.getByRole('region', { name: 'Imported Imported flow' });
    await expect(report.getByRole('heading', { name: 'Imported Imported flow' })).toBeFocused();
    await expect(report.getByText('New: found here by name')).toBeVisible();
    await expect(report.getByText('Parked: created, in the New stage')).toBeVisible();
    await expect(
      report.getByText(
        `Group Night shift, in the transition ${first.name}: the guard that names it never passes.`,
      ),
    ).toBeVisible();
    expect(await seriousAxeViolations(page)).toEqual([]);
    await report.getByRole('link', { name: 'Open Imported flow' }).click();
    await expect(heading(page)).toHaveText('Imported flow');
    imported = /#\/admin\/workflows\/(\d+)/.exec(page.url())?.[1];
    expect(imported).toBeTruthy();
  } finally {
    if (imported) await page.request.delete(`/api/v1/workflows/${imported}`);
    const statuses = await page.request.get('/api/v1/statuses');
    const parked = (
      (await statuses.json()) as { statuses: { id: number; name: string }[] }
    ).statuses.find((x) => x.name === 'Parked');
    if (parked) await page.request.delete(`/api/v1/statuses/${parked.id}`);
    await page.request.delete('/api/v1/session');
  }
});

test('[WF-011] downloading and importing workflows works on a small phone without sideways scrolling', async ({
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
  await page.goto('./#/admin/workflows');
  await expect(heading(page)).toHaveText('Workflows');
  await page.getByRole('button', { name: 'Import a workflow' }).tap();
  await expect(page.getByRole('form', { name: 'Import a workflow file' })).toBeVisible();
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  const targets = [
    page.getByRole('button', { name: 'Import a workflow' }),
    page.getByRole('link', { name: 'Download Default workflow as a workflow file' }),
    page.getByRole('button', { name: 'Import', exact: true }),
    page.getByLabel('Import as'),
  ];
  for (const target of targets) {
    expect((await target.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  expect(await seriousAxeViolations(page)).toEqual([]);
  await context.close();
});

test('[NTF-004] a person chooses a daily digest and turns one email off from the notification settings', async ({
  page,
}) => {
  await signInThroughApi(page.request, ADMIN);
  // Where notification emails link to.
  await page.goto('./#/account/notifications');
  const section = page.getByRole('region', { name: 'Notifications' });
  await expect(section.getByRole('radio', { name: /At once/ })).toBeChecked();
  await section.getByRole('radio', { name: /Daily digest/ }).check();
  await expect(section.getByText('Notification settings saved.')).toBeVisible();
  await section.getByRole('checkbox', { name: 'Email: Ticket moved to another track' }).uncheck();
  await expect(
    section.getByRole('checkbox', { name: 'Email: Ticket moved to another track' }),
  ).not.toBeChecked();
  // Saved with the account: still so after a reload.
  await page.reload();
  await expect(section.getByRole('radio', { name: /Daily digest/ })).toBeChecked();
  await expect(
    section.getByRole('checkbox', { name: 'Email: Ticket moved to another track' }),
  ).not.toBeChecked();
  await expect(
    section.getByRole('checkbox', { name: 'Inbox: Ticket moved to another track' }),
  ).toBeChecked();
  // Back to the defaults for the tests after this one.
  await section.getByRole('radio', { name: /At once/ }).check();
  await section.getByRole('checkbox', { name: 'Email: Ticket moved to another track' }).check();
  await expect(section.getByText('Notification settings saved.')).toBeVisible();
  // An unknown unsubscribe link says so, without a session.
  await page.request.delete('/api/v1/session');
  await page.goto('./#/unsubscribe?token=no-such-token-0123456789');
  await expect(page.getByText(/This unsubscribe link is not valid/)).toBeVisible();
});

/** Opens a ticket by changing the hash and returns how long its heading took to show (ms). */
async function openTicket(page: Page, key: string): Promise<number> {
  return page.evaluate(async (wanted) => {
    window.location.hash = '#/home';
    await new Promise((resolve) => setTimeout(resolve, 50));
    const start = performance.now();
    window.location.hash = `#/tickets/${wanted}`;
    await new Promise<void>((resolve) => {
      const check = () =>
        document.querySelector('h1')?.textContent?.includes(wanted)
          ? resolve()
          : requestAnimationFrame(check);
      check();
    });
    return performance.now() - start;
  }, key);
}

test('[NTF-008] a ticket opens from the local copy in under 100 ms and from the server in under 300 ms', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInThroughApi(page.request, ADMIN);
  const track = await page.request.post('/api/v1/tracks', {
    data: { key: 'SYNC', name: 'Sync', mode: 'shared' },
  });
  expect(track.status()).toBe(201);
  const created = await page.request.post('/api/v1/tickets', {
    data: { track: 'SYNC', summary: 'Opens fast' },
  });
  expect(created.status()).toBe(201);

  // Cold: no local copy (the sync endpoints are cut off), so the page asks the server.
  await page.route('**/api/v1/sync/**', (route) => route.abort());
  await page.goto('./#/home');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const cold = [];
  for (let i = 0; i < 3; i++) cold.push(await openTicket(page, 'SYNC-1'));
  expectWithinBudget(testInfo, Math.min(...cold), 300, 'ticket open from the server (ms)');

  // Warm: the local copy has it; the page shows it before the server answers.
  await page.unroute('**/api/v1/sync/**');
  await page.goto('./#/home');
  await page.reload();
  await expect(page.locator('html[data-sync-position]')).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.syncPosition ?? ''))
    .not.toBe('');
  const warm = [];
  for (let i = 0; i < 3; i++) warm.push(await openTicket(page, 'SYNC-1'));
  expectWithinBudget(testInfo, Math.min(...warm), 100, 'ticket open from the local copy (ms)');

  // A change made elsewhere reaches the local copy through the socket: within a second in the
  // benchmark run, at all in every run. The position is read before the change is made: on a
  // quiet machine the delta can land before a read made after it, which then waits forever.
  await expect(page.getByRole('heading', { level: 1 })).toContainText('SYNC-1');
  const before = await page.evaluate(() => document.documentElement.dataset.syncPosition);
  const edited = await page.request.patch('/api/v1/tickets/SYNC-1', {
    data: { summary: 'Opens fast, renamed' },
  });
  expect(edited.status()).toBe(200);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.syncPosition), {
      timeout: ENFORCE_BUDGETS ? 1500 : 10_000,
    })
    .not.toBe(before);
  await context.close();
});

test('[WF-007] [CORE-013] a locked field and a locked status show read-only, with who may change them', async ({
  page,
}) => {
  await signInThroughApi(page.request, ADMIN);
  // The administrator is not in Approvers: the field and the status keep them out.
  const group = await page.request.post('/api/v1/groups', { data: { name: 'Approvers' } });
  expect(group.status()).toBe(201);
  const approvers = ((await group.json()) as { group: { id: number } }).group.id;
  const statuses = (
    (await (await page.request.get('/api/v1/statuses')).json()) as {
      statuses: { id: number; name: string }[];
    }
  ).statuses;
  const S = (name: string) => statuses.find((s) => s.name === name)?.id as number;
  const workflow = await page.request.post('/api/v1/workflows', {
    data: {
      name: 'Approvers attach',
      definition: {
        initialStatusId: S('New'),
        statuses: [{ statusId: S('New') }, { statusId: S('Approved') }],
        transitions: [{ id: 1, name: 'Approve', from: [S('New')], to: S('Approved') }],
        statusPermissions: { [String(S('New'))]: { attach: [{ group: String(approvers) }] } },
      },
    },
  });
  expect(workflow.status()).toBe(201);
  const rules = await page.request.post('/api/v1/field-rule-sets', {
    data: {
      name: 'Approvers date the work',
      rules: [{ field: 'dueDate', editableBy: [{ groupId: approvers }] }],
    },
  });
  expect(rules.status()).toBe(201);
  const track = await page.request.post('/api/v1/tracks', {
    data: { key: 'LOCK', name: 'Locks', mode: 'shared' },
  });
  expect(track.status()).toBe(201);
  const trackId = ((await track.json()) as { track: { id: number } }).track.id;
  // Every ticket type of the track uses the workflow, through a workflow map (M1-028).
  const map = await page.request.post('/api/v1/workflow-maps', {
    data: {
      name: 'Approvers attach',
      defaultWorkflowId: ((await workflow.json()) as { workflow: { id: number } }).workflow.id,
    },
  });
  expect(map.status()).toBe(201);
  const set = await page.request.patch(`/api/v1/tracks/${trackId}`, {
    data: {
      workflowMapId: ((await map.json()) as { workflowMap: { id: number } }).workflowMap.id,
      fieldRuleSetId: ((await rules.json()) as { fieldRuleSet: { id: number } }).fieldRuleSet.id,
    },
  });
  expect(set.status()).toBe(200);

  // The create form: the due date is read-only and says who sets it.
  await page.goto('./#/create');
  await expect(heading(page)).toHaveText('Create ticket');
  await page.getByLabel('Track').selectOption({ label: 'LOCK Locks' });
  const due = page.getByLabel('Due date');
  await expect(due).toBeDisabled();
  await expect(due).toHaveAccessibleDescription('Only the Approvers group can set this field.');
  await expect(page.getByLabel('Summary (required)')).toBeEnabled();
  // The API refuses it as well, naming the field.
  const refused = await page.request.post('/api/v1/tickets', {
    data: { track: 'LOCK', summary: 'Dated', dueDate: '2026-12-01' },
  });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ permission: 'edit_field' });

  // The ticket page: in status New only Approvers add files.
  const created = await page.request.post('/api/v1/tickets', {
    data: { track: 'LOCK', summary: 'Locked files' },
  });
  expect(created.status()).toBe(201);
  await page.goto('./#/tickets/LOCK-1');
  const panel = page.getByRole('region', { name: 'Attachments' });
  await expect(
    panel.getByText('In status New, only the Approvers group can add or remove files.'),
  ).toBeVisible();
  await expect(panel.getByLabel('Attach files')).toHaveCount(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
});
