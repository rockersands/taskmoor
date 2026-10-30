import { expect, type Page, test } from '@playwright/test';

/**
 * Right-to-left layout (M1-116; NFR-006): the app in the bidi pseudo-locale `ar-XB`, where
 * every text runs right to left and the page is `dir="rtl"`. The layout mirrors: navigation on
 * the inline start (the right), controls flowing from the right, drawings (timeline, charts,
 * workflow diagram) kept left to right. No page scrolls sideways. A screenshot of each page is
 * attached to the report for a person to look at. It uses the attachments database (preview
 * 4174) and its administrator (Ada Attach).
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('[NFR-006] the app mirrors right to left without sideways scrolling', async ({
  page,
  isMobile,
}, testInfo) => {
  test.setTimeout(120_000);
  expect((await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN })).status()).toBe(200);
  const key = `R${testInfo.project.name.slice(0, 1).toUpperCase()}${testInfo.workerIndex.toString(36).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const post = async (url: string, data: unknown) => {
    const res = await page.request.post(`${BASE}${url}`, { data });
    expect(res.status(), `${url}: ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  const track = (await post('/api/v1/tracks', { key, name: `Mirror ${key}`, mode: 'shared' }))
    .track;
  await post('/api/v1/tickets', {
    track: key,
    summary: 'A ticket read right to left',
    startDate: '2030-01-03',
    dueDate: '2030-01-10',
  });
  const board = (
    await post('/api/v1/boards', {
      name: `Mirror ${key}`,
      kind: 'kanban',
      trackId: track.id,
      source: { query: `track = ${key}` },
    })
  ).board;

  const pages: [string, string][] = [
    ['home', '#/home'],
    ['ticket', `#/tickets/${key}-1`],
    ['board', `#/boards/${board.id}`],
    ['search', `#/search?q=${encodeURIComponent(`track = ${key}`)}`],
    ['timeline', `#/tracks/${key}/timeline`],
    ['settings', '#/settings'],
  ];
  for (const [name, hash] of pages) {
    await page.goto(`${BASE}/?locale=ar-XB${hash}`);
    const heading = page.getByRole('heading', { level: 1 }).first();
    await expect(heading).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar-XB');
    expect(await noSidewaysScroll(page), `${name} scrolls sideways`).toBe(true);
    await testInfo.attach(`rtl-${name}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  }

  // The frame mirrors: the top bar starts at the right, and so does the navigation.
  await page.goto(`${BASE}/?locale=ar-XB#/home`);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  const width = page.viewportSize()?.width ?? 0;
  const menu = await page.getByRole('banner').getByRole('button').first().boundingBox();
  expect(menu && menu.x > width / 2, 'the first top-bar control sits at the right').toBe(true);
  if (isMobile) {
    await page.getByRole('button', { name: /navigation/ }).click();
    const drawer = await page.getByRole('dialog').boundingBox();
    expect(drawer && Math.round(drawer.x + drawer.width) >= width - 1).toBe(true);
  } else {
    const sidebar = await page.getByRole('complementary').boundingBox();
    const main = await page.getByRole('main').boundingBox();
    expect(sidebar && main && sidebar.x > main.x, 'the navigation sits at the right').toBe(true);
  }
});
