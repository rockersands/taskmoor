import { expect, test } from '@playwright/test';

/**
 * Dragging cards end to end (M1-046; AGL-002, AGL-009: "drag e2e triggers checks"): a card
 * dragged to the next column runs its transition on the server; one dragged to Closed meets the
 * Close transition's check (a close reason is required), stays where it was and says so; a card
 * dragged above another takes its place. Mouse dragging only: on a phone the same moves are the
 * Move menu's. It uses the attachments database (preview 4174), whose administrator (Ada
 * Attach) the API server made with the ATT track.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

test('[AGL-002] [AGL-009] dragging a card runs its transition and its checks', async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, 'mouse dragging; phones move cards with the Move menu');
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const word = `drg${testInfo.project.name}${Date.now().toString(36)}`;
  const keys: string[] = [];
  for (const summary of ['Drag me', 'Stay here', 'Second one']) {
    const res = await page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: 'ATT', summary: `${summary} ${word}` },
    });
    expect(res.status(), await res.text()).toBe(201);
    keys.push((await res.json()).ticket.key as string);
  }
  const [first, second, third] = keys as [string, string, string];
  const made = await page.request.post(`${BASE}/api/v1/boards`, {
    data: { name: `Drag ${word}`, kind: 'kanban', source: { query: `summary ~ ${word}` } },
  });
  expect(made.status(), await made.text()).toBe(201);
  const boardId = (await made.json()).board.id as number;

  await page.goto(`${BASE}/#/boards/${boardId}`);
  const board = page.getByRole('region', { name: `Drag ${word}` });
  const cell = (column: string) => board.getByRole('list', { name: column, exact: true });
  const card = (key: string) => board.locator('li.board-card', { hasText: key });
  await expect(cell('New').getByRole('link')).toHaveCount(3);

  // New to Active: the Start transition runs on the server.
  await card(first).dragTo(cell('Active'));
  await expect(cell('Active').getByRole('link')).toHaveCount(1);
  const started = await page.request.get(`${BASE}/api/v1/tickets/${first}`);
  expect((await started.json()).ticket.status.name).toBe('Active');

  // Active to Closed: Close needs a close reason, so the move is refused and the card stays.
  await card(first).dragTo(cell('Closed'));
  await expect(board.getByRole('alert')).toContainText(`${first} could not be moved`);
  await expect(cell('Active').getByRole('link')).toHaveCount(1);
  const kept = await page.request.get(`${BASE}/api/v1/tickets/${first}`);
  expect((await kept.json()).ticket.status.name).toBe('Active');

  // Within New: the third card dropped on the top half of the second goes above it.
  const target = card(second);
  const box = await target.boundingBox();
  if (!box) throw new Error('no box for the target card');
  await card(third).dragTo(target, { targetPosition: { x: box.width / 2, y: 2 } });
  await expect(cell('New').getByRole('link').first()).toContainText(third);
});
