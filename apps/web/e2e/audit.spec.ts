import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * The audit log end to end (M1-085; IAM-013): a refused sign-in is recorded, the audit page
 * finds it with a filter, and the CSV and JSON Lines downloads hold it. It uses the attachments
 * database (preview 4174) and its administrator (Ada Attach).
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

test('[IAM-013] finds a refused sign-in on the audit page and downloads it', async ({
  page,
  playwright,
}, testInfo) => {
  // A refused sign-in from another client, under an address no other test uses.
  const marker = `audit-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}@nobody.test`;
  const stranger = await playwright.request.newContext({ baseURL: BASE });
  expect(
    (
      await stranger.post('/api/v1/session', { data: { email: marker, password: 'wrong-pass' } })
    ).status(),
  ).toBe(401);
  await stranger.dispose();

  expect((await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN })).status()).toBe(200);
  await page.goto(`${BASE}/#/admin/audit`);
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
  await page.getByLabel('Action').fill('session.sign_in_failed');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  // A table on a wide screen, one block per record on a phone; the action reads as words (D19).
  const name = 'Audit records, newest first';
  const records = page.getByRole('table', { name }).or(page.getByRole('list', { name }));
  await expect(records.getByText('Session sign-in failed').first()).toBeVisible();

  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download as CSV' }).click(),
  ]);
  expect(csv.suggestedFilename()).toMatch(/^audit-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = readFileSync((await csv.path()) as string, 'utf8');
  expect(text.split('\r\n')[0]).toMatch(/^seq,occurred_at,recorded_at,actor_id/);
  expect(text).toContain(marker);

  const [jsonl] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download as JSON Lines' }).click(),
  ]);
  const lines = readFileSync((await jsonl.path()) as string, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { action: string; details: unknown });
  expect(lines.every((l) => l.action === 'session.sign_in_failed')).toBe(true);
  expect(JSON.stringify(lines)).toContain(marker);

  // Checking the chain says it is whole.
  await page.getByRole('button', { name: 'Check the chain' }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText('The chain is intact');
});
