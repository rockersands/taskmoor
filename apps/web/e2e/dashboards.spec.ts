import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * Dashboards end to end (M1-064; RPT-004, RPT-005): a dashboard made on the dashboards page gets
 * a search-results widget set up in place, shows its ticket once saved, is shared with everyone
 * signed in and opens as a wallboard without the navigation; no serious axe issue and no
 * sideways page scroll, on a phone either. It uses the attachments database (preview 4174),
 * whose administrator (Ada Attach) the API server made with the ATT track.
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

test('[RPT-004] [RPT-005] a dashboard made, set up, shared and shown as a wallboard', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const word = `dsh${testInfo.project.name}${Date.now().toString(36)}`;
  const made = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: 'ATT', summary: `Dashboard ticket ${word}` },
  });
  expect(made.status(), await made.text()).toBe(201);
  const key = (await made.json()).ticket.key as string;

  await page.goto(`${BASE}/#/dashboards`);
  await page.getByLabel('New dashboard').fill(`Dash ${word}`);
  await page.getByRole('button', { name: 'Create dashboard' }).click();
  const dashboard = page.getByRole('region', { name: `Dash ${word}` });
  await expect(dashboard.getByText('This dashboard has no widgets yet.')).toBeVisible();

  // A search-results widget, set up in place, shows its ticket once saved.
  await dashboard.getByRole('button', { name: 'Edit dashboard' }).click();
  await dashboard
    .getByRole('combobox', { name: 'Widget to add' })
    .selectOption({ label: 'Search results' });
  await dashboard.getByRole('button', { name: 'Add widget' }).click();
  const settings = dashboard.getByRole('form', { name: 'Settings of Search results' });
  await settings.getByLabel('Query').fill(`summary ~ ${word}`);
  await settings.getByRole('button', { name: 'Apply' }).click();
  await dashboard.getByRole('button', { name: 'Save dashboard' }).click();
  await expect(dashboard.getByRole('status')).toHaveText('Saved.');
  const widget = dashboard.getByRole('article', { name: 'Search results' });
  await expect(widget.getByRole('link', { name: key })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await dashboard
    .getByRole('combobox', { name: 'Who sees it' })
    .selectOption({ label: 'Everyone signed in' });
  await expect(dashboard.getByRole('status')).toHaveText('Everyone signed in sees it now.');

  // The wallboard: the dashboard alone, without the navigation.
  await dashboard.getByRole('link', { name: 'Wallboard' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Dash ${word}` })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('link', { name: key })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.getByRole('link', { name: 'Leave the wallboard' }).click();
  await expect(page.getByRole('button', { name: 'Edit dashboard' })).toBeVisible();
});
