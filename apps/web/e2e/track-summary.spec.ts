import { expect, test } from '@playwright/test';

/**
 * A track's summary end to end (M1-064: "summary counts equal query counts"): the ATT track's
 * open count on its summary page is the search API's count of the same query, and the number
 * opens that search. It uses the attachments database (preview 4174), whose administrator (Ada
 * Attach) the API server made with the ATT track.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

test('[RPT-006] a track’s summary counts what its searches find', async ({ page }) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  await page.goto(`${BASE}/#/tracks/ATT`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('(ATT)');
  const open = page.getByRole('term').filter({ hasText: /^Open$/ });
  await expect(open).toBeVisible();
  const shown = await page.locator('dl.report-stats div').first().locator('dd a').textContent();
  const search = await page.request.get(
    `${BASE}/api/v1/search?q=${encodeURIComponent('track = ATT AND closeReason IS EMPTY')}&count=true&limit=1`,
  );
  const total = (await search.json()).total.count as number;
  expect(Number((shown ?? '').replace(/[^\d]/g, ''))).toBe(total);
  await page.locator('dl.report-stats div').first().locator('dd a').click();
  await expect(page).toHaveURL(/#\/search\?q=/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
