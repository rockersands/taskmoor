import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * The create dialog honours layouts per ticket type (M1-052; CORE-008, CORE-013): a track of
 * its own gets two create layouts, one per ticket type, and a rule that makes Environment
 * required for the first. The dialog, opened with C, shows each type's fields and no others,
 * refuses the first type without its environment and creates it once given. No serious axe
 * issue. It uses the attachments database (preview 4174), whose site administrator the API
 * server made.
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

test('[CORE-008] [CORE-013] the create dialog shows each ticket type its own layout', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  const api = async (method: 'post' | 'patch' | 'get', path: string, data?: unknown) => {
    const res = await page.request[method](`${BASE}/api/v1${path}`, data ? { data } : {});
    expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
    return res.json();
  };

  // A track of its own, so other tests' tracks keep their forms.
  const key = `L${testInfo.project.name[0]?.toUpperCase()}${Date.now() % 10_000_000}`;
  const { track } = await api('post', '/tracks', {
    key,
    name: `Layouts ${testInfo.project.name}`,
    mode: 'shared',
  });
  const { ticketTypes } = await api('get', `/tracks/${key}/ticket-types`);
  const [report, plan] = ticketTypes as { id: number; name: string }[];
  if (!report || !plan) throw new Error('the track needs two ticket types');
  const { fieldRuleSet } = await api('post', '/field-rule-sets', {
    name: `Rules ${key}`,
    rules: [{ ticketTypeId: report.id, field: 'environment', required: true }],
  });
  const tab = (name: string, fields: string[]) => ({
    tabs: [{ name, sections: [{ fields }] }],
    others: 'omit',
  });
  const { layoutSet } = await api('post', '/layout-sets', {
    name: `Layouts ${key}`,
    layouts: [
      {
        ticketTypeId: report.id,
        operation: 'create',
        definition: tab('What happened', ['summary', 'environment']),
      },
      {
        ticketTypeId: plan.id,
        operation: 'create',
        definition: tab('When', ['summary', 'dueDate']),
      },
    ],
  });
  await api('patch', `/tracks/${track.id}`, {
    fieldRuleSetId: fieldRuleSet.id,
    layoutSetId: layoutSet.id,
  });

  await page.goto(`${BASE}/#/home`);
  await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible();
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'Create ticket' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Track').selectOption({ value: key });
  const type = dialog.getByLabel('Ticket type');

  // The first type: its tab, Environment required, no due date.
  await type.selectOption({ label: report.name });
  await expect(dialog.getByRole('region', { name: 'What happened' })).toBeVisible();
  await expect(dialog.getByLabel('Environment (required)')).toBeVisible();
  await expect(dialog.getByLabel('Due date')).toHaveCount(0);
  // The second: its tab, a due date, no environment.
  await type.selectOption({ label: plan.name });
  await expect(dialog.getByRole('region', { name: 'When' })).toBeVisible();
  await expect(dialog.getByLabel('Due date')).toBeVisible();
  await expect(dialog.getByLabel(/^Environment/)).toHaveCount(0);
  expect(await seriousAxeViolations(page)).toEqual([]);

  // Back to the first: refused without its environment, created with it.
  await type.selectOption({ label: report.name });
  await dialog
    .getByLabel('Summary (required)')
    .fill(`Checkout times out on ${testInfo.project.name}`);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Some fields need attention before the ticket can be created.',
  );
  await dialog.getByLabel('Environment (required)').click();
  await page.keyboard.type('Safari 18 on a phone');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const made = dialog.getByText(new RegExp(`^${key}-\\d+ was created\\.$`));
  await expect(made).toBeVisible();
  const ticketKey = ((await made.textContent()) ?? '').split(' ')[0] as string;
  await dialog.getByRole('link', { name: `Open ${ticketKey}` }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(ticketKey);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
