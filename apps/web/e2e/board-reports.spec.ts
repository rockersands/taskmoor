import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * Board flow reports end to end (M1-061; RPT-001): on a board made through the API, one card
 * starts from the board, then its reports show cumulative flow with that move today, a control
 * chart with nothing finished yet, and time in status with every ticket, over the period and
 * board filters picked; no serious axe issue and no sideways page scroll, on a phone either.
 * It uses the attachments database (preview 4174), whose administrator (Ada Attach) the API
 * server made.
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

/** A report of a track's Statistics: its link on a wide screen, the one Report picker on a phone (D5). */
async function openReport(page: Page, name: string): Promise<void> {
  const picker = page.getByRole('combobox', { name: 'Report' });
  if (await picker.isVisible()) await picker.selectOption({ label: name });
  else await page.getByRole('navigation', { name: 'Reports' }).getByRole('link', { name }).click();
}

test('[RPT-001] a board’s cumulative flow, control chart and time in status', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const word = `flw${testInfo.project.name}${Date.now().toString(36)}`;
  const key = `F${testInfo.project.name.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-7)}`;
  const track = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Flow ${word}`, mode: 'shared' },
  });
  expect(track.status(), await track.text()).toBe(201);
  const trackId = (await track.json()).track.id as number;
  const keys: string[] = [];
  for (const summary of ['Refund totals', 'Coupon stacking', 'Receipt layout']) {
    const res = await page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: key, summary: `${summary} ${word}` },
    });
    expect(res.status(), await res.text()).toBe(201);
    keys.push((await res.json()).ticket.key as string);
  }
  const made = await page.request.post(`${BASE}/api/v1/boards`, {
    data: {
      name: `Flow ${word}`,
      kind: 'kanban',
      trackId,
      boardFilters: [{ name: 'Assigned to me', query: 'assignee = currentUser()' }],
    },
  });
  expect(made.status(), await made.text()).toBe(201);
  const boardId = (await made.json()).board.id as number;

  // One card starts from the board (New to Active), as people move them.
  await page.goto(`${BASE}/#/boards/${boardId}`);
  const board = page.getByRole('region', { name: 'Board', exact: true });
  const cell = (column: string) => board.getByRole('list', { name: column, exact: true });
  await expect(cell('New').getByRole('link')).toHaveCount(3);
  await board.getByRole('link', { name: new RegExp(`^${keys[1]} `) }).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(cell('Active').getByRole('link')).toHaveCount(1);

  // The track's Statistics tab holds the board's reports (ADR-116); no pill repeats it (D7).
  await page
    .getByRole('navigation', { name: `Sections of ${key}` })
    .getByRole('link', { name: 'Statistics' })
    .click();
  const reports = page.getByRole('region', { name: 'Statistics', exact: true });
  const flow = reports.getByRole('figure', { name: 'Cumulative flow' });
  await expect(flow.getByRole('img')).toHaveAttribute(
    'aria-label',
    /: 3 tickets on the board on the last day, 0 of them in /,
  );
  await flow.getByText('Show the numbers').click();
  const header = await flow.getByRole('row').first().locator('th').allTextContents();
  const today = await flow.getByRole('row').last().locator('th, td').allTextContents();
  expect(today[header.indexOf('New')]).toBe('2');
  expect(today[header.indexOf('Active')]).toBe('1');
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Nothing finished yet; the period and a board filter change what the chart reads.
  await openReport(page, 'Control chart');
  await expect(
    reports.getByText('No ticket moved past the chosen columns in this period.'),
  ).toBeVisible();
  await reports.getByRole('combobox', { name: 'Period' }).selectOption({ label: 'Last 14 days' });
  await reports.getByRole('checkbox', { name: 'Assigned to me' }).check();
  await expect(reports.getByRole('checkbox', { name: 'Assigned to me' })).toBeChecked();
  await expect(
    reports.getByText('No ticket moved past the chosen columns in this period.'),
  ).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);

  // The choices stay from report to report: none of the tickets is Ada's.
  await openReport(page, 'Time in status');
  await expect(
    reports.getByText('No ticket of this board was in a status in this period.'),
  ).toBeVisible();
  await reports.getByRole('checkbox', { name: 'Assigned to me' }).uncheck();
  const times = reports.getByRole('figure', { name: 'Average time in status' });
  await expect(times).toBeVisible();
  await expect(reports.getByRole('rowheader', { name: 'Active' }).last()).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
