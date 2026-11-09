import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { finger } from './touch';

/**
 * Dragging a card really moves its ticket (M1-046; AGL-002, ADR-049): with a mouse on a desktop,
 * and with a finger on a phone by the card's grip, the columns scrolling along at the screen's
 * edge (T-162b; ADR-114, section 12). On the workflow a site starts with, any card goes to any
 * column, left or right, with no dialog.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

async function drag(page: Page, card: string, column: string) {
  const from = page.getByRole('link', { name: new RegExp(card) });
  const to = page.getByRole('list', { name: column, exact: true });
  await from.dragTo(to);
}

/**
 * A track of its own with one ticket, for one test. Its key names the worker as well as the
 * moment, so runs started in the same millisecond (with --repeat-each, say) never share one.
 */
async function oneTicket(page: Page, prefix: string, testInfo: TestInfo) {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const word = `${prefix}${Date.now()}`;
  const key = `D${testInfo.parallelIndex}${Date.now().toString(36).toUpperCase().slice(-7)}`;
  const track = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Drag ${key}`, mode: 'shared' },
  });
  expect(track.status(), await track.text()).toBe(201);
  const made = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: key, summary: `${word} one`, assigneeId: null },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const { ticket } = (await made.json()) as { ticket: { key: string } };
  const status = async () =>
    (await (await page.request.get(`${BASE}/api/v1/tickets/${ticket.key}`)).json()).ticket.status
      .name as string;
  return { key, word, ticket, status };
}

test('[AGL-002] a mouse drag moves a card to any column with nothing asked', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'dragging with a mouse is a desktop path');
  const { key, word, status } = await oneTicket(page, 'drag', testInfo);

  await page.goto(`${BASE}/#/tracks/${key}/board`);
  await expect(page.getByRole('link', { name: new RegExp(word) })).toBeVisible();

  // New to Active: one transition, no fields.
  await drag(page, word, 'Active');
  await expect(
    page.getByRole('list', { name: 'Active', exact: true }).getByRole('link', {
      name: new RegExp(word),
    }),
  ).toBeVisible();
  expect(await status()).toBe('Active');

  // Active to Closed: one drag, nothing asked (the user's decision, ADR-116).
  await drag(page, word, 'Closed');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('list', { name: 'Closed', exact: true }).getByRole('link', {
      name: new RegExp(word),
    }),
  ).toBeVisible();
  expect(await status()).toBe('Closed');
  await expect(page.getByRole('alert')).toHaveCount(0);

  // And back to the leftmost column.
  await drag(page, word, 'New');
  await expect(
    page.getByRole('list', { name: 'New', exact: true }).getByRole('link', {
      name: new RegExp(word),
    }),
  ).toBeVisible();
  expect(await status()).toBe('New');
});

test('[AGL-002] [NFR-007] a finger drags a card by its grip to a column off the screen', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'a finger on a phone');
  test.setTimeout(60_000);
  const { key, word, ticket, status } = await oneTicket(page, 'touch', testInfo);

  await page.goto(`${BASE}/#/tracks/${key}/board`);
  const link = page.getByRole('link', { name: new RegExp(word) });
  await expect(link).toBeVisible();
  const columns = page.getByRole('region', { name: 'Columns' });
  const active = page.getByRole('list', { name: 'Active', exact: true });
  const scrolled = () => columns.evaluate((el) => el.scrollLeft);
  // On a phone one column fills the screen: Active starts off it, to the right.
  const region = (await columns.boundingBox()) as NonNullable<
    Awaited<ReturnType<typeof columns.boundingBox>>
  >;
  expect((await active.boundingBox())?.x ?? 0).toBeGreaterThan(region.x + region.width / 2);

  // A finger on the card itself is the browser's: it scrolls, and the card stays where it is.
  // That scroll goes on after the finger lifts, gliding and then snapping to a column. The
  // columns scroll back only once it has ended: sooner, the snap would carry them off again,
  // as it did under load (T-013a).
  const browserScroll = await columns.evaluateHandle((el) => {
    const scroll = { ended: false };
    el.addEventListener(
      'scrollend',
      () => {
        scroll.ended = true;
      },
      { once: true },
    );
    return scroll;
  });
  const card = (await link.boundingBox()) as NonNullable<typeof region>;
  const swipe = await finger(page);
  await swipe.down({ x: card.x + card.width / 2, y: card.y + card.height / 2 });
  await swipe.moveTo({ x: card.x + card.width / 2 - 120, y: card.y + card.height / 2 });
  await swipe.up();
  await expect(page.locator('.board-card.is-dragging')).toHaveCount(0);
  expect(await status()).toBe('New');
  await expect.poll(() => browserScroll.evaluate((scroll) => scroll.ended)).toBe(true);
  await columns.evaluate((el) => el.scrollTo({ left: 0 }));
  await expect.poll(scrolled).toBe(0);

  // By its grip it drags. Held near the right edge, the columns scroll along until Active is
  // under the finger; there it is let go.
  const grip = page.getByRole('button', { name: `Move ${ticket.key}` });
  const g = (await grip.boundingBox()) as NonNullable<typeof region>;
  const hand = await finger(page);
  await hand.down({ x: g.x + g.width / 2, y: g.y + g.height / 2 });
  // Inside the edge zone, but near its inner side: a slow, steady scroll.
  const edge = { x: region.x + region.width - 50, y: g.y + g.height / 2 };
  await hand.moveTo(edge);
  await expect(
    page.getByText(`Moving ${ticket.key}: drop it on a place in a column.`, { exact: false }),
  ).toBeAttached();
  await expect
    .poll(
      async () => ((await active.boundingBox())?.x ?? Number.POSITIVE_INFINITY) < edge.x - 120,
      {
        intervals: [50],
        timeout: 15_000,
      },
    )
    .toBe(true);
  const target = (await active.boundingBox()) as NonNullable<typeof region>;
  await hand.moveTo({ x: target.x + 40, y: target.y + Math.min(target.height / 2, 60) }, 4);
  await expect(active).toHaveClass(/is-drop-target/);
  await hand.up();

  await expect(active.getByRole('link', { name: new RegExp(word) })).toBeVisible();
  expect(await status()).toBe('Active');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // A tap on the grip is its own: the Move menu, with the same moves as a drag.
  // Chromium's simulated touch makes no click of the first tap after an earlier gesture, so the
  // tap is tried again until the menu is open.
  const menuGrip = page.getByRole('button', { name: `Move ${ticket.key}` });
  await expect(async () => {
    if ((await menuGrip.getAttribute('aria-expanded')) !== 'true') await menuGrip.tap();
    await expect(menuGrip).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
  }).toPass();
  await page.getByRole('button', { name: 'Back to New' }).tap();
  await expect(
    page.getByRole('list', { name: 'New', exact: true }).getByRole('link', {
      name: new RegExp(word),
    }),
  ).toBeVisible();
  expect(await status()).toBe('New');
});
