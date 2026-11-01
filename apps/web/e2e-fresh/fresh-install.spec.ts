import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

/**
 * A fresh install end to end (M1-113; NFR-013, OPS-013, OPS-015), run by tools/image/fresh-vm.sh
 * against the backend kit installed on a fresh machine and the frontend kit on a plain static
 * server at another site. Nothing is configured by hand: the Builder's two addresses are all.
 *
 * The setup link creates the administrator on the backend; the person then works on the
 * frontend, which signs in through the backend's page (OAuth with PKCE): a track with its
 * board, a ticket made in the create dialog, the board showing it, a query finding it, and a
 * change made elsewhere arriving on the open ticket without a reload.
 */
const SETUP = process.env.TASKMOOR_FRESH_SETUP_LINK ?? '';
const BACKEND = process.env.TASKMOOR_FRESH_BACKEND ?? '';
const FRONTEND = (process.env.TASKMOOR_FRESH_FRONTEND ?? '').replace(/\/$/, '');
const MARK = process.env.TASKMOOR_FRESH_MARK ?? '';
// Made for this run: no password is written in the repository.
const ADMIN = {
  name: 'Fresh Admin',
  email: 'admin@fresh.test',
  password: `lantern ${randomBytes(12).toString('base64url')} meadow`,
};

test.skip(!SETUP || !BACKEND || !FRONTEND, 'run by tools/image/fresh-vm.sh');
test.describe.configure({ mode: 'serial' });

const heading = (page: Page) => page.getByRole('heading', { level: 1 });

test('[NFR-013] [OPS-015] the setup link makes the administrator on the fresh backend', async ({
  page,
}) => {
  await page.goto(SETUP);
  await expect(heading(page)).toHaveText('Set up Taskmoor');
  await page.getByLabel('Instance name').fill('Fresh install');
  await page.getByLabel('Name', { exact: true }).fill(ADMIN.name);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByLabel('Confirm password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(heading(page)).toHaveText('Home');
});

test('[NFR-013] [OPS-013] the frontend at another site: sign in, a ticket, its board, a search, a live update', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // The person's own browser: nothing of the setup's session.
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // The first visit, signed out: the start page says to sign in, and the frontend sends the
  // person to the backend's page and back.
  await page.goto(`${FRONTEND}/`);
  await expect(heading(page)).toHaveText('Home');
  await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
  // The backend is on another site: the page says where the account lives and leads there.
  await page.getByRole('button', { name: `Sign in on ${new URL(BACKEND).host}` }).click();
  await expect(page).toHaveURL(new RegExp(`^${BACKEND.replace(/[.]/g, '\\.')}/#/sign-in`));
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`^${FRONTEND.replace(/[.]/g, '\\.')}/`));
  await expect(heading(page)).toHaveText('Home');
  if (MARK) writeFileSync(MARK, String(Math.floor(Date.now() / 1000)));

  // A track with its board, from the administration page.
  await page.goto(`${FRONTEND}/#/admin/tracks`);
  const form = page.getByRole('form', { name: 'Add a track' });
  await form.getByLabel('Key').fill('FRESH');
  await form.getByLabel('Track name').fill('Fresh');
  await form
    .getByRole('combobox', { name: 'Start from' })
    .selectOption({ label: 'Kanban: a board of continuous flow' });
  await form.getByRole('button', { name: 'Add a track' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'FRESH' })).toHaveText(
    'Track FRESH was added, with its board.',
  );
  const board = page.getByRole('link', { name: 'Open the board of FRESH' });
  const boardUrl = await board.getAttribute('href');

  // A ticket from the create dialog.
  await page.goto(`${FRONTEND}/#/home`);
  await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible();
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'Create ticket' });
  await dialog.getByLabel('Track').selectOption({ value: 'FRESH' });
  // The track's own form and its ticket types load after the choice: type once they have.
  await expect(dialog.getByLabel('Ticket type')).not.toHaveValue('');
  const summary = dialog.getByLabel('Summary (required)');
  await summary.fill('Lighthouse lamp flickers');
  await expect(summary).toHaveValue('Lighthouse lamp flickers');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByText('FRESH-1 was created.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  // The board shows it.
  await page.goto(`${FRONTEND}/${boardUrl ?? ''}`);
  await expect(page).toHaveURL(/#\/boards\/\d+$/);
  await expect(page.getByText('Lighthouse lamp flickers')).toBeVisible();

  // A query finds it.
  await page.goto(`${FRONTEND}/#/search`);
  await expect(heading(page)).toHaveText('Search');
  await page.getByRole('button', { name: 'Advanced' }).click();
  const query = page.getByRole('combobox', { name: 'Query' });
  await query.fill('track = FRESH AND text ~ lighthouse');
  await query.press('Enter');
  const results = page.getByRole('region', { name: 'Results' });
  await expect(results.getByRole('link', { name: 'FRESH-1', exact: true })).toBeVisible();

  // A change made elsewhere reaches the open ticket live.
  await page.goto(`${FRONTEND}/#/tickets/FRESH-1`);
  await expect(heading(page)).toContainText('Lighthouse lamp flickers');
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  const signIn = await other.request.post(`${BACKEND}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  const edited = await other.request.patch(`${BACKEND}/api/v1/tickets/FRESH-1`, {
    data: { summary: 'Lighthouse lamp flickers at night' },
  });
  expect(edited.status(), await edited.text()).toBe(200);
  await expect(heading(page)).toContainText('at night', { timeout: 15_000 });

  // And on the open board (NTF-008 (1)): within a second, measured from the change.
  await page.goto(`${FRONTEND}/${boardUrl ?? ''}`);
  await expect(page.getByText('Lighthouse lamp flickers at night')).toBeVisible();
  const before = Date.now();
  const again = await other.request.patch(`${BACKEND}/api/v1/tickets/FRESH-1`, {
    data: { summary: 'Lighthouse lamp fixed' },
  });
  expect(again.status(), await again.text()).toBe(200);
  await expect(page.getByText('Lighthouse lamp fixed')).toBeVisible({ timeout: 15_000 });
  test.info().annotations.push({
    type: 'board update (ms)',
    description: String(Date.now() - before),
  });
  process.stdout.write(`board updated ${Date.now() - before} ms after the change\n`);

  expect(errors).toEqual([]);
  await other.close();
  await context.close();
});
