import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * Searching (M1-041; QRY-001): basic choices become a query, the query goes to the advanced mode
 * and back unchanged, suggestions come at the caret, a wrong query is shown where it is wrong,
 * and the results link their tickets. No serious axe issue. It uses the attachments database
 * (preview 4174) and its ATT track.
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

test('[QRY-001] basic to advanced and back, with suggestions, errors and results', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  const word = `zebra${testInfo.project.name}${Date.now()}`;
  const made = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: 'ATT', summary: `Find the ${word} ticket` },
  });
  expect(made.status()).toBe(201);
  const ticket = (await made.json()).ticket as { key: string };

  // Basic: the track and a word.
  await page.goto(`${BASE}/#/search`);
  await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
  const basic = page.getByRole('form', { name: 'Basic' });
  await basic.getByRole('checkbox', { name: /^ATT / }).check();
  await basic.getByLabel('Words').fill(word);
  await basic.getByRole('button', { name: 'Search' }).click();
  const results = page.getByRole('region', { name: 'Results' });
  await expect(results.getByRole('link', { name: ticket.key, exact: true })).toBeVisible();
  await expect(results.getByText('1 ticket', { exact: true })).toBeVisible();

  // To the advanced mode: the same search as a query, and back to the same choices.
  await page.getByRole('button', { name: 'Advanced' }).click();
  const query = page.getByRole('textbox', { name: 'Query' });
  await expect(query).toHaveValue(`track = ATT AND text ~ "${word}" ORDER BY updated DESC`);
  await page.getByRole('button', { name: 'Basic' }).click();
  await expect(basic.getByRole('checkbox', { name: /^ATT / })).toBeChecked();
  await expect(basic.getByLabel('Words')).toHaveValue(word);
  expect(await seriousAxeViolations(page)).toEqual([]);

  // Typed with suggestions, from the keyboard.
  await page.getByRole('button', { name: 'Advanced' }).click();
  await query.fill('');
  await query.pressSequentially('tra');
  await expect(page.getByRole('option', { name: 'track', exact: true })).toBeVisible();
  await query.press('Tab');
  await query.pressSequentially('= ');
  await expect(page.getByRole('option', { name: 'ATT', exact: true })).toBeVisible();
  await expect(query).toHaveValue('track = ');
  expect(await seriousAxeViolations(page)).toEqual([]);

  // A wrong field is shown where it is.
  await query.fill('nosuchfield = 1');
  await expect(page.getByRole('alert')).toContainText('nosuchfield');
  await expect(query).toHaveAttribute('aria-invalid', 'true');

  // The address carries the query: a reload runs it again.
  await query.fill(`text ~ "${word}"`);
  await query.press('Enter');
  await expect(results.getByRole('link', { name: ticket.key, exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Results' })
      .getByRole('link', { name: ticket.key, exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
