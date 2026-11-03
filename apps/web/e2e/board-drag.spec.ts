import { expect, type Page, test } from '@playwright/test';

/**
 * Dragging a card with the mouse really moves its ticket (M1-046; AGL-003, ADR-049). On the
 * workflow a site starts with, any card goes to any column, left or right, with no dialog.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

async function drag(page: Page, card: string, column: string) {
  const from = page.getByRole('link', { name: new RegExp(card) });
  const to = page.getByRole('list', { name: column, exact: true });
  await from.dragTo(to);
}

test('[AGL-003] a mouse drag moves a card to any column with nothing asked', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'dragging with a mouse is a desktop path');
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const word = `drag${Date.now()}`;
  const made = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: 'ATT', summary: `${word} one`, assigneeId: null },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const { ticket } = await made.json();

  await page.goto(`${BASE}/#/boards`);
  await page.getByLabel('Name').fill(`Drag ${word}`);
  await page.getByRole('button', { name: 'Advanced: choose the tickets with a query' }).click();
  await page.getByLabel('Tickets (a query)').fill(`track = ATT AND summary ~ ${word}`);
  await page.getByRole('button', { name: 'Create board' }).click();
  await expect(page.getByRole('link', { name: new RegExp(word) })).toBeVisible();

  // New to Active: one transition, no fields.
  await drag(page, word, 'Active');
  await expect(
    page.getByRole('list', { name: 'Active', exact: true }).getByRole('link', {
      name: new RegExp(word),
    }),
  ).toBeVisible();
  const read = async () =>
    (await (await page.request.get(`${BASE}/api/v1/tickets/${ticket.key}`)).json()).ticket.status
      .name;
  expect(await read()).toBe('Active');

  // Active to Closed: one drag, nothing asked (the user's decision, ADR-116).
  await drag(page, word, 'Closed');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('list', { name: 'Closed', exact: true }).getByRole('link', {
      name: new RegExp(word),
    }),
  ).toBeVisible();
  expect(await read()).toBe('Closed');
  await expect(page.getByRole('alert')).toHaveCount(0);

  // And back to the leftmost column.
  await drag(page, word, 'New');
  await expect(
    page.getByRole('list', { name: 'New', exact: true }).getByRole('link', {
      name: new RegExp(word),
    }),
  ).toBeVisible();
  expect(await read()).toBe('New');
});
