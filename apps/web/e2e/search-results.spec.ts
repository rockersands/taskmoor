import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * Search results (M1-042; QRY-014, QRY-015): columns chosen, moved and kept after a reload, a
 * summary and labels edited in place through the ticket route, a refused edit shown on its
 * cell, and the results downloaded as CSV in the shown columns. No serious axe issue, no
 * sideways page scroll. It uses the attachments database (preview 4174) and its ATT track.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
async function seriousAxeViolations(page: Page): Promise<string[]> {
  // Evaluated, not a script element, which the app's content security policy refuses (M1-107).
  await page.evaluate(readFileSync(AXE, 'utf8'));
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (context: Document) => Promise<{
            violations: { id: string; impact?: string | null; nodes: unknown[] }[];
          }>;
        };
      }
    ).axe;
    const { violations } = await axe.run(document);
    return violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} (${v.nodes.length})`);
  });
}

test('[QRY-014] [QRY-015] columns, edits in place and a CSV export of the results', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  const word = `quokka${testInfo.project.name}${Date.now()}`;
  const made = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: 'ATT', summary: `Inline ${word}` },
  });
  expect(made.status()).toBe(201);
  const ticket = (await made.json()).ticket as { id: number; key: string };

  await page.goto(`${BASE}/#/search?q=${encodeURIComponent(`text ~ "${word}"`)}`);
  const results = page.getByRole('region', { name: 'Results' });
  await expect(results.getByRole('link', { name: ticket.key, exact: true })).toBeVisible();
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: ticket.key }) });
  const table = results.getByRole('table');

  // Columns: add Labels and move it up one, from the keyboard.
  await results.getByRole('button', { name: 'Columns' }).click();
  const panel = results.getByRole('group', { name: 'Columns' });
  await panel.getByLabel('Add a column').selectOption({ label: 'Labels' });
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  await panel.getByRole('button', { name: 'Move Labels up' }).focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: 'Move Labels up' })).toBeFocused();
  await expect(table.getByRole('columnheader')).toHaveText([
    'Key',
    'Summary',
    'Type',
    'Status',
    'Assignee',
    'Priority',
    'Labels',
    'Updated',
  ]);
  expect(await seriousAxeViolations(page)).toEqual([]);

  // The summary, edited in place: saved through the ticket route, the row shows it.
  await row.getByRole('button', { name: `Edit Summary of ${ticket.key}` }).click();
  const summary = row.getByRole('textbox', { name: `Edit Summary of ${ticket.key}` });
  await expect(summary).toBeFocused();
  await summary.fill(`Edited ${word}`);
  await summary.press('Enter');
  await expect(row.getByText(`Edited ${word}`)).toBeVisible();
  const stored = await page.request.get(`${BASE}/api/v1/tickets/${ticket.id}`);
  expect((await stored.json()).ticket.summary).toBe(`Edited ${word}`);

  // A refused edit is shown on its cell; Escape leaves it as it was.
  await row.getByRole('button', { name: `Edit Summary of ${ticket.key}` }).click();
  await summary.fill('');
  await summary.press('Enter');
  await expect(row.getByRole('alert')).toHaveText('This value is not accepted here.');
  await expect(summary).toHaveAttribute('aria-invalid', 'true');
  expect(await seriousAxeViolations(page)).toEqual([]);
  await summary.press('Escape');
  await expect(row.getByText(`Edited ${word}`)).toBeVisible();

  // Labels, edited in place.
  await row.getByRole('button', { name: `Edit Labels of ${ticket.key}` }).click();
  const labels = row.getByRole('textbox', { name: `Edit Labels of ${ticket.key}` });
  await labels.fill('alpha, beta');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByText('alpha, beta')).toBeVisible();

  // The columns are kept: a reload shows them again.
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Results' }).getByRole('columnheader', { name: 'Labels' }),
  ).toBeVisible();

  // The export: the query's tickets as CSV, in the shown columns.
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export CSV' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^tickets-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await download.path()) as string, 'utf8');
  const lines = csv.trim().split('\r\n');
  expect(lines[0]).toBe('key,summary,ticketType,status,assignee,priority,labels,updatedAt');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain(`${ticket.key},Edited ${word},`);
  expect(lines[1]).toContain(',"alpha; beta",');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
