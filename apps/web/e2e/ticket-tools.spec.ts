import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/**
 * The ticket's tools end to end (ADR-120): links from a picker in the same track, a subticket with
 * its progress, a checklist reading 75%, and the slash menu putting a block in a comment. It uses
 * the attachments database (preview 4174), whose administrator and ATT track the API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

async function makeTicket(request: APIRequestContext, summary: string) {
  const res = await request.post(`${BASE}/api/v1/tickets`, {
    data: { track: 'ATT', summary },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).ticket as { id: number; key: string };
}

async function open(page: Page, key: string) {
  await page.goto(`${BASE}/#/tickets/${key}`);
  const signIn = page.getByRole('textbox', { name: 'Email' });
  if (await signIn.isVisible().catch(() => false)) {
    await signIn.fill(ADMIN.email);
    await page.getByRole('textbox', { name: 'Password' }).fill(ADMIN.password ?? '');
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(key) })).toBeVisible();
}

test.beforeEach(async ({ context }) => {
  const res = await context.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(res.status()).toBe(200);
});

test('[CORE-031] links a ticket of the track, found by name, and removes it', async ({
  context,
  page,
}) => {
  const stamp = Date.now();
  const here = await makeTicket(context.request, `Tools home ${stamp}`);
  const other = await makeTicket(context.request, `Pickable zebra${stamp}`);
  await open(page, here.key);
  const links = page.getByRole('region', { name: 'Links' });
  await links.getByRole('button', { name: 'Add a link' }).click();
  const picker = links.getByRole('combobox', { name: 'Ticket number or name' });
  await picker.click();
  await page.keyboard.type(`zebra${stamp}`);
  await expect(links.getByRole('option', { name: new RegExp(other.key) })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(links.getByRole('link', { name: other.key })).toBeVisible();
  await links.getByRole('button', { name: 'Done' }).click();
  await links.getByRole('button', { name: new RegExp(`Remove the link: .* ${other.key}`) }).click();
  await expect(links.getByRole('link', { name: other.key })).toHaveCount(0);
});

test('[CORE-032] adds a subticket and shows its progress', async ({ context, page }) => {
  const here = await makeTicket(context.request, `Parent ${Date.now()}`);
  await open(page, here.key);
  const section = page.getByRole('region', { name: 'Subtickets' });
  await section.getByRole('textbox', { name: 'New subticket' }).fill('A small part');
  await page.keyboard.press('Enter');
  await expect(section.getByText('A small part')).toBeVisible();
  await expect(section.getByText('0 of 1 closed (0%)')).toBeVisible();
});

test('[CORE-033] (1) a checklist with 3 done, 1 open and 1 rejected reads 75%', async ({
  context,
  page,
}) => {
  const here = await makeTicket(context.request, `Checks ${Date.now()}`);
  await open(page, here.key);
  const section = page.getByRole('region', { name: 'Checklists' });
  await section.getByRole('button', { name: 'Add a checklist' }).click();
  await page.keyboard.type('Steps');
  await page.keyboard.press('Enter');
  const field = section.getByRole('textbox', { name: 'Add an item to Steps' });
  for (const text of ['One', 'Two', 'Three', 'Four', 'Five']) {
    await field.fill(text);
    await page.keyboard.press('Enter');
    await expect(section.getByRole('checkbox', { name: text })).toBeVisible();
  }
  for (const text of ['One', 'Two', 'Three']) {
    await section.getByRole('checkbox', { name: text }).check();
    await expect(section.getByRole('checkbox', { name: text })).toBeChecked();
  }
  await section.getByRole('combobox', { name: 'State of Five' }).selectOption('rejected');
  await expect(section.getByText('3 of 4 done (75%)')).toBeVisible();
  // It is in the ticket's history, and still there after a reload.
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Checklists' }).getByText('3 of 4 done (75%)'),
  ).toBeVisible();
});

test('[NTF-013] the slash menu puts a panel in a comment, and it reads back', async ({
  context,
  page,
}) => {
  const here = await makeTicket(context.request, `Slash ${Date.now()}`);
  await open(page, here.key);
  const editor = page.locator('.comment-composer [contenteditable]');
  await editor.click();
  await page.keyboard.type('/warning');
  await expect(page.getByRole('listbox', { name: 'Blocks to add' })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Mind the gap');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('.comment-body [data-panel="warning"]')).toHaveText('Mind the gap');
});
