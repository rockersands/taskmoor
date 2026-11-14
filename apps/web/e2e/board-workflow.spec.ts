import { expect, test } from '@playwright/test';
import { uniqueKey } from './unique';

/**
 * Board-managed workflows end to end (M1-126; WF-010; ADR-116): a local-mode track's board has
 * its columns as the track's statuses from the start, an added column becomes a status, a
 * card dragged straight to the rightmost column is closed as Completed, and dragged back it is
 * open again. It uses the attachments database (preview 4174) and its administrator.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

test('[WF-010] columns become statuses, and the rightmost column closes a card as Completed', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  expect((await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN })).status()).toBe(200);
  const key = uniqueKey('BW', testInfo);
  const suffix = key.slice(2);
  const track = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Board workflow ${suffix}`, mode: 'local' },
  });
  expect(track.status(), await track.text()).toBe(201);
  const made = await page.request.get(`${BASE}/api/v1/tracks/${key}/board`);
  expect(made.status(), await made.text()).toBe(200);
  const boardId = (await made.json()).board.id as number;
  const ticket = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: key, summary: 'Goes straight to the end' },
  });
  const ticketKey = (await ticket.json()).ticket.key as string;

  // The columns are the statuses, and a new column a status of its own.
  await page.goto(`${BASE}/#/boards/${boardId}/settings`);
  await expect(
    page.getByRole('checkbox', { name: 'This board’s columns are its track’s statuses' }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Add a column' }).click();
  const names = page.getByRole('textbox', { name: /^Name of column \d+$/ });
  const added = names.last();
  await added.fill(`Waiting ${suffix}`);
  // Moved left of the rightmost column, which keeps closing tickets.
  await page.getByRole('button', { name: `Move Waiting ${suffix} up` }).click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
  const statuses = (await (await page.request.get(`${BASE}/api/v1/statuses`)).json()).statuses as {
    name: string;
  }[];
  expect(statuses.map((s) => s.name)).toContain(`Waiting ${suffix}`);

  // Any card to any column: straight to the rightmost, then back to the new one. The card's
  // Move menu offers every column (dragging the same moves is the board-drag test's).
  await page.goto(`${BASE}/#/boards/${boardId}`);
  const board = page.getByRole('region', { name: 'Board', exact: true });
  const cell = (column: string) => board.getByRole('list', { name: column, exact: true });
  await expect(cell('New').getByRole('link')).toHaveCount(1);
  const moveTo = async (label: string) => {
    await board.getByRole('button', { name: `Move ${ticketKey}` }).click();
    await board.getByRole('button', { name: label }).click();
  };
  const ticketNow = async () =>
    (await (await page.request.get(`${BASE}/api/v1/tickets/${ticketKey}`)).json()).ticket;
  // Closed is the rightmost column: the new one went to its left.
  await moveTo('Forward to Closed');
  await expect(cell('Closed').getByRole('link')).toHaveCount(1);
  await expect.poll(async () => (await ticketNow()).closeReason?.name ?? null).toBe('Completed');
  await moveTo(`Back to Waiting ${suffix}`);
  await expect(cell(`Waiting ${suffix}`).getByRole('link')).toHaveCount(1);
  await expect
    .poll(ticketNow)
    .toMatchObject({ status: { name: `Waiting ${suffix}` }, closeReason: null });
});
