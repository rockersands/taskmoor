import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * A board end to end (M1-043; AGL-001 to AGL-005; ADR-116): a track's own board, made when it is
 * first opened, a board filter switched on and off, a card moved to the next column with the
 * keyboard (the transition runs on the server) and up within its column, with no serious axe
 * issue and no sideways page scroll, on a phone either. It uses the attachments database
 * (preview 4174), whose administrator (Ada Attach) the API server made.
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

test("[AGL-001] [AGL-002] [AGL-003] [AGL-005] a track's board, keyboard moves and settings", async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  // A track of this run's own, so its board shows only these three tickets.
  const track = `B${testInfo.project.name.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-7)}`;
  const trackMade = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key: track, name: `Team ${track}`, mode: 'shared' },
  });
  expect(trackMade.status(), await trackMade.text()).toBe(201);
  const keys: string[] = [];
  for (const summary of ['Refund totals', 'Coupon stacking', 'Receipt layout']) {
    const res = await page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track, summary, assigneeId: null },
    });
    expect(res.status(), await res.text()).toBe(201);
    keys.push((await res.json()).ticket.key as string);
  }
  const [first, second, third] = keys as [string, string, string];

  // Made when the track's board is first opened.
  await page.goto(`${BASE}/#/tracks/${track}/board`);
  const board = page.getByRole('region', { name: 'Board', exact: true });
  await expect(board.getByRole('heading', { level: 1 })).toBeVisible();
  const cell = (column: string) => board.getByRole('list', { name: column, exact: true });
  const card = (key: string) => board.getByRole('link', { name: new RegExp(`^${key} `) });
  await expect(cell('New').getByRole('link')).toHaveCount(3);
  await expect(cell('New').getByRole('link').first()).toHaveAccessibleName(
    new RegExp(`^${first} `),
  );
  expect(await seriousAxeViolations(page)).toEqual([]);

  // "Me": none is Ada's; the count stays whole.
  await board.getByRole('button', { name: 'Me', exact: true }).click();
  await expect(cell('New').getByRole('link')).toHaveCount(0);
  await expect(board.getByText('3 hidden by board filters')).toBeVisible();
  await board.getByRole('button', { name: 'Me', exact: true }).click();
  await expect(cell('New').getByRole('link')).toHaveCount(3);

  // Alt+Right: the second card starts (New to Active) and keeps the focus.
  await card(second).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(cell('Active').getByRole('link')).toHaveCount(1);
  await expect(cell('Active').getByRole('link')).toHaveAccessibleName(new RegExp(`^${second} `));
  await expect(card(second)).toBeFocused();
  const ticket = await page.request.get(`${BASE}/api/v1/tickets/${second}`);
  expect((await ticket.json()).ticket.status.name).toBe('Active');

  // Alt+Up: the third card goes above the first in New (the global rank).
  await card(third).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(cell('New').getByRole('link').first()).toHaveAccessibleName(
    new RegExp(`^${third} `),
  );

  // Settings: at most no ticket in Active, so its one card breaks the limit (AGL-003).
  await board.getByRole('link', { name: 'Board settings' }).click();
  const settings = page.getByRole('region', { name: 'Board settings', exact: true });
  await settings.getByRole('spinbutton', { name: 'Maximum in Active' }).fill('0');
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(settings.getByRole('status')).toHaveText('Saved.');
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The Board tab leads back (D7).
  await page
    .getByRole('navigation', { name: `Sections of ${track}` })
    .getByRole('link', { name: 'Board' })
    .click();
  await expect(board.getByText('Over the maximum')).toBeVisible();

  // Nothing scrolls sideways but the columns; no serious axe issue at the end either.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await seriousAxeViolations(page)).toEqual([]);
});
