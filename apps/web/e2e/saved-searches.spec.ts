import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * Saved searches (M1-063; QRY-011, QRY-012): a query saved as a new saved search, opened again
 * from its address after a reload with its results, shared with everyone signed in, starred
 * and subscribed to by email. No serious axe issue, no sideways page scroll. It uses the
 * attachments database (preview 4174) and its ATT track. The subscription email itself is
 * sent by the server's mailer, covered with a fake transport in `saved-searches.test.ts`.
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

test('[QRY-011] [QRY-012] saves, reopens, shares and subscribes to a saved search', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  const word = `wombat${testInfo.project.name}${Date.now()}`;
  const made = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: 'ATT', summary: `Saved ${word}` },
  });
  expect(made.status()).toBe(201);
  const ticket = (await made.json()).ticket as { key: string };

  await page.goto(`${BASE}/#/search?q=${encodeURIComponent(`text ~ "${word}"`)}`);
  const results = page.getByRole('region', { name: 'Results' });
  await expect(results.getByRole('link', { name: ticket.key, exact: true })).toBeVisible();

  // Save as new.
  const saved = page.getByRole('region', { name: 'Saved searches' });
  await saved.getByRole('button', { name: 'Save as new' }).click();
  const name = `Search ${word}`;
  await saved.getByRole('textbox', { name: 'Name' }).fill(name);
  await saved.getByRole('button', { name: 'Save search' }).click();
  await expect(page.getByRole('status').filter({ hasText: `${name} is saved.` })).toBeVisible();
  await expect(page.getByRole('heading', { name: `Saved search: ${name}` })).toBeVisible();
  await expect(page).toHaveURL(/#\/search\?savedSearch=\d+$/);

  // Reopened from its address after a reload: the saved query runs again.
  await page.reload();
  const opened = page.getByRole('region', { name: `Saved search: ${name}` });
  await expect(opened).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Results' })
      .getByRole('link', { name: ticket.key, exact: true }),
  ).toBeVisible();

  // Shared with everyone signed in.
  await opened.getByRole('button', { name: 'Share', exact: true }).click();
  await opened.getByRole('radio', { name: 'Everyone signed in' }).check();
  await opened.getByRole('button', { name: 'Save sharing' }).click();
  await expect(
    opened.getByRole('status').filter({ hasText: `Everyone signed in sees ${name} now.` }),
  ).toBeVisible();

  // Subscribed: weekly on Monday at 07:00.
  await opened.getByRole('button', { name: 'Subscribe', exact: true }).click();
  await opened.getByRole('combobox', { name: 'How often' }).selectOption('weekly');
  await opened.getByRole('combobox', { name: 'On', exact: true }).selectOption({ label: 'Monday' });
  await opened.getByRole('combobox', { name: 'At', exact: true }).selectOption({ label: '07:00' });
  await opened.getByRole('button', { name: 'Subscribe by email' }).click();
  await expect(
    opened.getByRole('status').filter({ hasText: `You are subscribed to ${name}.` }),
  ).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);

  const id = Number(new URL(page.url()).hash.split('=')[1]);
  const subs = await page.request.get(`${BASE}/api/v1/saved-searches/${id}/subscriptions`);
  expect(subs.status()).toBe(200);
  expect((await subs.json()).subscriptions).toMatchObject([
    { schedule: 'weekly', weekday: 1, hour: 7 },
  ]);
  const read = await page.request.get(`${BASE}/api/v1/saved-searches/${id}`);
  expect((await read.json()).savedSearch.shares).toEqual([{ scope: 'any_user' }]);

  // No sideways page scroll, also on a phone.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
