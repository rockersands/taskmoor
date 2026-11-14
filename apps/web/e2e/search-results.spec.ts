import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import { cellText, records } from '@taskmoor/server/testing';

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
  if (testInfo.project.name === 'mobile') {
    // A phone shows stacked rows (D1): key, summary, then status, assignee and priority; the
    // edits in place are the wide table's.
    const rows = results.getByRole('list', { name: 'Tickets' });
    await expect(rows.getByRole('listitem')).toHaveCount(1);
    await expect(rows.getByText(`Inline ${word}`, { exact: true })).toBeVisible();
    await expect(results.getByRole('table')).toHaveCount(0);
    expect(await seriousAxeViolations(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    return;
  }
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
  // Columns is the shared pop-over (T-216): Escape closes it and gives the page back.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

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
  const bytes = readFileSync((await download.path()) as string);
  // The UTF-8 byte-order mark first, once (T-252); then the header.
  expect([...bytes.subarray(0, 4)]).toEqual([0xef, 0xbb, 0xbf, 'k'.charCodeAt(0)]);
  const csv = bytes.toString('utf8').slice(1);
  const lines = csv.trim().split('\r\n');
  expect(lines[0]).toBe('key,summary,ticketType,status,assignee,priority,labels,updatedAt');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain(`${ticket.key},Edited ${word},`);
  expect(lines[1]).toContain(',"alpha; beta",');
  // The CSV importer reads the file back as written, the mark taken off.
  const back = [...records(bytes, ',')].map((r) => r.fields.map(cellText));
  expect(back[0]).toEqual(lines[0]?.split(','));
  expect(back[1]?.[0]).toBe(ticket.key);
  expect(back[1]).toContain('alpha; beta');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
