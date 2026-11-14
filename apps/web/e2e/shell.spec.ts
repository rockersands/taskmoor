import { expect, test } from '@playwright/test';

/**
 * The app frame: sidebar, drawer and touch targets. A signed-out visitor sees a reduced frame
 * with only the product name and sign-in (D8), so each test signs in first. It uses the
 * attachments database (preview 4174) and its administrator (Ada Attach).
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

test.beforeEach(async ({ page }) => {
  expect((await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN })).status()).toBe(200);
});

test('the page never scrolls sideways', async ({ page }) => {
  await page.goto(`${BASE}/`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout only');

  test('the sidebar is always visible and collapses to an icon rail', async ({ page }) => {
    await page.goto(`${BASE}/`);
    const sidebar = page.locator('#shell-sidebar');
    await expect(sidebar.getByRole('navigation', { name: 'Main' })).toBeVisible();
    expect((await sidebar.boundingBox())?.width).toBeGreaterThan(200);

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeLessThan(80);
    await expect(sidebar.getByRole('link', { name: 'Tracks', exact: true })).toBeVisible();
  });

  test('navigation changes the page', async ({ page }) => {
    await page.goto(`${BASE}/`);
    // The sidebar's link: Home's "All tracks" (T-194) shows once a person has more tracks than
    // its panel lists, as the shared e2e database does after a few specs.
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Tracks', exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tracks');
    await expect(page).toHaveURL(/#\/tracks$/);
  });
});

test.describe('mobile', () => {
  test.skip(({ isMobile }) => !isMobile, 'compact layout only');

  test('navigation lives in a drawer opened from the menu button', async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.getByRole('navigation')).toHaveCount(0);

    await page.getByRole('button', { name: 'Open navigation' }).tap();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();

    await drawer.getByRole('link', { name: 'Tracks', exact: true }).tap();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tracks');
  });

  test('touch targets are at least 44px tall', async ({ page }) => {
    await page.goto(`${BASE}/`);
    const menu = page.getByRole('button', { name: 'Open navigation' });
    expect((await menu.boundingBox())?.height).toBeGreaterThanOrEqual(44);

    await menu.tap();
    for (const link of await page.getByRole('dialog').getByRole('link').all()) {
      expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
  });
});
