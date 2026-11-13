import { expect, test } from '@playwright/test';

/**
 * Bulk changes end to end (M1-021, CORE-024): a bulk edit asked through the API runs as a
 * background job, and its page shows the progress, the counts and the ticket not changed with
 * its reason. It uses the attachments database (preview 4174), where the API server made an
 * administrator and the ATT track and runs the bulk jobs.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

test('[CORE-024] follows a bulk edit to the end and lists the ticket it could not change', async ({
  page,
}, testInfo) => {
  const request = page.request;
  const signIn = await request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  const keys: string[] = [];
  for (const n of [1, 2, 3]) {
    const res = await request.post(`${BASE}/api/v1/tickets`, {
      data: { track: 'ATT', summary: `Bulk ${testInfo.project.name} ${n}` },
    });
    expect(res.status()).toBe(201);
    keys.push((await res.json()).ticket.key);
  }
  const label = `bulk-${testInfo.project.name}`;
  const created = await request.post(`${BASE}/api/v1/bulk-operations`, {
    data: { action: 'edit', tickets: [...keys, 'ATT-999999'], edit: { labels: [label] } },
  });
  expect(created.status()).toBe(202);
  const id = (await created.json()).bulkOperation.id as number;

  await page.goto(`${BASE}/#/bulk/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bulk edit of 4 tickets');
  // One ticket failed: a warning, never a green "Done." (PL-23, D14).
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    'The bulk edit finished with problems: 3 tickets were changed, and 1 ticket was not. Each one is listed below with the reason.',
  );
  await expect(page.getByRole('progressbar', { name: '4 of 4 tickets finished' })).toBeVisible();
  const counts = page.locator('.bulk-counts');
  await expect(counts.getByRole('definition').nth(0)).toHaveText('3');
  await expect(counts.getByRole('definition').nth(1)).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Cancel the rest' })).toHaveCount(0);

  const failures = page.getByRole('region', { name: 'Tickets that were not changed' });
  await expect(failures.getByRole('listitem')).toHaveCount(1);
  await expect(failures.getByText('ATT-999999')).toBeVisible();
  await expect(failures.getByText('Not found, or you may not see it.')).toBeVisible();

  // Every ticket asked for got the label, through the ticket's own edit.
  for (const key of keys) {
    const ticket = await request.get(`${BASE}/api/v1/tickets/${key}`);
    expect((await ticket.json()).ticket.labels).toContain(label);
  }
  // Nothing on the page scrolls sideways, on a phone either.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
