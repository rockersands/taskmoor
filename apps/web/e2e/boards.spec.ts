import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * A board end to end (M1-043; AGL-001 to AGL-005): made from a query on the boards page,
 * opened, a board filter switched on and off, a card moved to the next column with the
 * keyboard (the transition runs on the server) and up within its column, with no serious axe
 * issue and no sideways page scroll, on a phone either. It uses the attachments database
 * (preview 4174), whose administrator (Ada Attach) the API server made with the ATT track.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
async function seriousAxeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE });
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

test('[AGL-001] [AGL-002] [AGL-003] [AGL-005] a board from a query, keyboard moves and settings', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  // Three tickets only this run's board shows: a word in their summaries.
  const word = `brd${testInfo.project.name}${Date.now().toString(36)}`;
  const keys: string[] = [];
  for (const summary of ['Refund totals', 'Coupon stacking', 'Receipt layout']) {
    const res = await page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: 'ATT', summary: `${summary} ${word}`, assigneeId: null },
    });
    expect(res.status(), await res.text()).toBe(201);
    keys.push((await res.json()).ticket.key as string);
  }
  const [first, second, third] = keys as [string, string, string];

  // Made on the boards page; it opens on its own page.
  await page.goto(`${BASE}/#/boards`);
  await expect(page.getByRole('heading', { name: 'Boards', level: 1 })).toBeVisible();
  await page.getByLabel('Name').fill(`Team ${word}`);
  await page.getByLabel('Tickets (a query)').fill(`track = ATT AND summary ~ ${word}`);
  await page.getByRole('button', { name: 'Create board' }).click();
  const board = page.getByRole('region', { name: `Team ${word}` });
  await expect(board.getByRole('heading', { level: 1 })).toBeVisible();
  const cell = (column: string) => board.getByRole('list', { name: column, exact: true });
  await expect(cell('New').getByRole('link')).toHaveCount(3);
  await expect(cell('New').getByRole('link').first()).toContainText(first);
  expect(await seriousAxeViolations(page)).toEqual([]);

  // "Only my tickets": none is Ada's; the count stays whole.
  await board.getByRole('button', { name: 'Only my tickets' }).click();
  await expect(cell('New').getByRole('link')).toHaveCount(0);
  await expect(board.getByText('3 hidden by board filters')).toBeVisible();
  await board.getByRole('button', { name: 'Only my tickets' }).click();
  await expect(cell('New').getByRole('link')).toHaveCount(3);

  // Alt+Right: the second card starts (New to Active) and keeps the focus.
  const moving = board.getByRole('link', { name: new RegExp(`^${second} `) });
  await moving.focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(cell('Active').getByRole('link')).toHaveCount(1);
  await expect(cell('Active').getByRole('link')).toContainText(second);
  await expect(board.getByRole('link', { name: new RegExp(`^${second} `) })).toBeFocused();
  const ticket = await page.request.get(`${BASE}/api/v1/tickets/${second}`);
  expect((await ticket.json()).ticket.status.name).toBe('Active');

  // Alt+Up: the third card goes above the first in New (the global rank).
  await board.getByRole('link', { name: new RegExp(`^${third} `) }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(cell('New').getByRole('link').first()).toContainText(third);

  // Settings: at most no ticket in Active, so its one card breaks the limit (AGL-003).
  await board.getByRole('link', { name: 'Board settings' }).click();
  const settings = page.getByRole('region', { name: `Settings of Team ${word}` });
  await expect(settings.getByRole('combobox', { name: 'Column for In Review' })).toHaveValue(/.+/);
  await settings.getByRole('spinbutton', { name: 'Maximum in Active' }).fill('0');
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(settings.getByRole('status')).toHaveText('Saved.');
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await settings.getByRole('link', { name: 'Back to the board' }).click();
  await expect(board.getByText('Over the maximum')).toBeVisible();

  // Nothing scrolls sideways but the columns; no serious axe issue at the end either.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await seriousAxeViolations(page)).toEqual([]);
});
