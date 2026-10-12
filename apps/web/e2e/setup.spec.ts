import { expect, test } from '@playwright/test';

const TOKEN = 'e2e-setup-token-0123456789';
const ADMIN = { name: 'Kalo', email: 'kalo@example.com', password: 'a long enough passphrase' };

// The backend has one setup to give; these tests share it in order and only run on desktop,
// because the mobile project would otherwise race for the same one-time token.
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'one setup per backend; desktop runs it');

test('[OPS-003] the setup link creates the administrator and signs them in', async ({ page }) => {
  await page.goto(`./#/setup?token=${TOKEN}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Set up Taskmoor');
  await page.getByLabel('Instance name').fill('E2E Tracker');
  await page.getByLabel('Name', { exact: true }).fill(ADMIN.name);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByLabel('Confirm password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Finish setup' }).click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  await page.goto('./#/settings');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
});

test('[OPS-003] the token is rejected once used', async ({ page }) => {
  const res = await page.request.post('/api/v1/setup', {
    data: { token: TOKEN, instanceName: 'Again', admin: ADMIN },
  });
  expect(res.status()).toBe(409);
  await page.goto(`./#/setup?token=${TOKEN}`);
  await expect(page.getByText('already set up')).toBeVisible();
});

test('[IAM-001] signing out and back in with the password works', async ({ page }) => {
  // A fresh browser context: sign in through the API first (it shares the page's cookie jar).
  const signIn = await page.request.post('/api/v1/session', {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  await page.goto('./#/settings');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  const out = await page.request.delete('/api/v1/session');
  expect(out.status()).toBe(204);

  // Same URL, so a reload is what makes the app ask the backend again.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to continue');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('do not match');

  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
});

test('[OPS-010] the administrator opens the system status from Settings', async ({ page }) => {
  const signIn = await page.request.post('/api/v1/session', {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  await page.goto('./#/settings');
  await page.getByRole('link', { name: 'System status' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('System status');
  const database = page.getByRole('region', { name: 'Database' });
  await expect(database.getByText('Connected')).toBeVisible();
  await expect(database.getByText(/^\d+ applied$/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Runtime' }).getByText(/^v\d+\./)).toBeVisible();

  // Everyone else is turned away by the backend as well as the page.
  await page.request.delete('/api/v1/session');
  expect((await page.request.get('/api/v1/admin/system')).status()).toBe(401);
});
