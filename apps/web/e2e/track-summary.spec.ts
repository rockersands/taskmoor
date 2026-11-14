import { expect, test } from '@playwright/test';

/**
 * A track's summary end to end (M1-064: "summary counts equal query counts"): on a track of its
 * own (other specs add tickets to ATT while this one runs), the summary's open count is the
 * search API's count of the same query, and the number opens that search. It uses the
 * attachments database (preview 4174) and its administrator (Ada Attach).
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

test('[RPT-006] a track’s summary counts what its searches find', async ({ page }, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const key = `S${testInfo.project.name.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-7)}`;
  const track = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Summary ${key}`, mode: 'shared' },
  });
  expect(track.status(), await track.text()).toBe(201);
  for (const summary of ['One', 'Two', 'Three']) {
    const res = await page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: key, summary },
    });
    expect(res.status(), await res.text()).toBe(201);
  }
  await page.goto(`${BASE}/#/tracks/${key}`);
  // Titled by its section, with the track named above it (the page review's track titles).
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Summary');
  await expect(page.locator('.page-eyebrow')).toHaveText(`Summary ${key}`);
  const openNumber = page.locator('dl.report-stats div').first().locator('dd a');
  await expect(openNumber).toHaveText('3');
  const search = await page.request.get(
    `${BASE}/api/v1/search?q=${encodeURIComponent(`track = ${key} AND closeReason IS EMPTY`)}&count=true&limit=1`,
  );
  expect((await search.json()).total.count).toBe(3);
  await openNumber.click();
  await expect(page).toHaveURL(/#\/search\?q=/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Filtered for oneself (T-075a): the numbers narrow, the filter stays in the address through a
  // reload, and clearing it brings the whole track back.
  await page.goto(`${BASE}/#/tracks/${key}`);
  await expect(openNumber).toHaveText('3');
  const form = page.getByRole('form', { name: 'Filter this summary for yourself' });
  await form.getByRole('textbox', { name: 'Only tickets that match' }).fill('summary ~ "Two"');
  await form.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(openNumber).toHaveText('1');
  await expect(page).toHaveURL(/#\/tracks\/[A-Z0-9]+\?filter=summary/);
  await expect(
    form.getByText('Showing only the tickets that match summary ~ "Two".'),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(openNumber).toHaveText('1');
  await form.getByRole('button', { name: 'Clear the filter' }).click();
  await expect(openNumber).toHaveText('3');
});
