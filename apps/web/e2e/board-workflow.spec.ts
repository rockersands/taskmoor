import { expect, test } from '@playwright/test';

/**
 * Board-managed workflows end to end (M1-126; WF-010): on a local-mode track's board, the
 * settings turn the columns into the track's statuses, an added column becomes a status, a
 * card dragged straight to the rightmost column is closed as Completed, and dragged back it is
 * open again. It uses the attachments database (preview 4174) and its administrator.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

test('[WF-010] columns become statuses, and the rightmost column closes a card as Completed', async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, 'mouse dragging; phones move cards with the Move menu');
  test.setTimeout(90_000);
  expect((await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN })).status()).toBe(200);
  const suffix = `${testInfo.workerIndex}${Date.now().toString(36)}`.toUpperCase().slice(-6);
  const key = `BW${suffix}`;
  const track = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Board workflow ${suffix}`, mode: 'local' },
  });
  expect(track.status(), await track.text()).toBe(201);
  const trackId = (await track.json()).track.id as number;
  const made = await page.request.post(`${BASE}/api/v1/boards`, {
    data: { name: `Team ${suffix}`, kind: 'kanban', trackId, source: { query: `track = ${key}` } },
  });
  expect(made.status(), await made.text()).toBe(201);
  const boardId = (await made.json()).board.id as number;
  const ticket = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: key, summary: 'Goes straight to the end' },
  });
  const ticketKey = (await ticket.json()).ticket.key as string;

  // The settings make the columns the statuses, and a new column a status of its own.
  await page.goto(`${BASE}/#/boards/${boardId}/settings`);
  await page
    .getByRole('checkbox', { name: 'This board’s columns are its track’s statuses' })
    .check();
  await expect(page.getByRole('status')).toHaveText('Saved.');
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

  // Any card to any column: straight to the rightmost, then back to the new one.
  await page.goto(`${BASE}/#/boards/${boardId}`);
  const board = page.getByRole('region', { name: `Team ${suffix}` });
  const columns = board.locator('ul.board-cell');
  const card = board.locator('li.board-card', { hasText: ticketKey });
  await expect(card).toBeVisible();
  await card.dragTo(columns.last());
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`${BASE}/api/v1/tickets/${ticketKey}`)).json()).ticket
          .closeReason?.name ?? null,
    )
    .toBe('Completed');
  await card.dragTo(board.getByRole('list', { name: `Waiting ${suffix}`, exact: true }));
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`${BASE}/api/v1/tickets/${ticketKey}`)).json()).ticket,
    )
    .toMatchObject({ status: { name: `Waiting ${suffix}` }, closeReason: null });
});
