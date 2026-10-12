import { expect, test } from '@playwright/test';

test('the page never scrolls sideways', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout only');

  test('the sidebar is always visible and collapses to an icon rail', async ({ page }) => {
    await page.goto('./');
    const sidebar = page.locator('#shell-sidebar');
    await expect(sidebar.getByRole('navigation', { name: 'Main' })).toBeVisible();
    expect((await sidebar.boundingBox())?.width).toBeGreaterThan(200);

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeLessThan(80);
    await expect(sidebar.getByRole('link', { name: 'Boards', exact: true })).toBeVisible();
  });

  test('navigation changes the page', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('link', { name: 'Dashboards' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboards');
    await expect(page).toHaveURL(/#\/dashboards$/);
  });
});

test.describe('mobile', () => {
  test.skip(({ isMobile }) => !isMobile, 'compact layout only');

  test('navigation lives in a drawer opened from the menu button', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('navigation')).toHaveCount(0);

    await page.getByRole('button', { name: 'Open navigation' }).tap();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();

    await drawer.getByRole('link', { name: 'Boards', exact: true }).tap();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Boards');
  });

  test('touch targets are at least 44px tall', async ({ page }) => {
    await page.goto('./');
    const menu = page.getByRole('button', { name: 'Open navigation' });
    expect((await menu.boundingBox())?.height).toBeGreaterThanOrEqual(44);

    await menu.tap();
    for (const link of await page.getByRole('dialog').getByRole('link').all()) {
      expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
  });
});
