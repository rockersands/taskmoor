import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * List and calendar views end to end (M1-049; AGL-016, AGL-017), on tracks of their own:
 * fifty rows of a track's list edited in place one after another (five on a phone), the list
 * grouped by priority with its count, a format rule naming and colouring the rows it finds,
 * and on the calendar a ticket dragged to another day (on a phone, its days changed in its
 * pop-up) with its due day saved. No serious axe issue and no sideways page scroll. It uses the
 * attachments database (preview 4174), whose administrator (Ada Attach) the API server made.
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

async function track(page: Page, key: string, name: string) {
  const res = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name, mode: 'shared' },
  });
  expect(res.status(), await res.text()).toBe(201);
}

test('[AGL-016] fifty rows edited in place, grouped, and coloured by a rule', async ({
  page,
  isMobile,
}, testInfo) => {
  test.setTimeout(180_000);
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const key = `V${testInfo.project.name.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-6)}`;
  await track(page, key, `List ${key}`);
  const keys: string[] = [];
  for (let n = 1; n <= 50; n++) {
    const res = await page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: key, summary: `Row ${n}` },
    });
    expect(res.status(), await res.text()).toBe(201);
    keys.push((await res.json()).ticket.key as string);
  }

  await page.goto(`${BASE}/#/tracks/${key}`);
  await page.getByRole('link', { name: 'List', exact: true }).click();
  const list = page.getByRole('region', { name: `List of List ${key}` });
  await expect(list.getByRole('link', { name: keys[0] as string, exact: true })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);

  // Each row's summary edited in place, without leaving the list.
  for (const ticket of isMobile ? keys.slice(0, 5) : keys) {
    await list.getByRole('button', { name: `Edit Summary of ${ticket}`, exact: true }).click();
    const input = list.getByRole('textbox', { name: `Edit Summary of ${ticket}`, exact: true });
    await input.fill(`Edited ${ticket}`);
    await input.press('Enter');
    await expect(list.getByText(`Edited ${ticket}`, { exact: true })).toBeVisible();
  }
  const last = isMobile ? (keys[4] as string) : (keys[49] as string);
  const saved = await (await page.request.get(`${BASE}/api/v1/tickets/${last}`)).json();
  expect(saved.ticket.summary).toBe(`Edited ${last}`);

  // Grouped by priority: every ticket has the default one.
  await list.getByRole('combobox', { name: 'Group by' }).selectOption({ label: 'Priority' });
  await expect(list.getByRole('heading', { name: /\(50 tickets\)$/ })).toBeVisible();

  // A rule for new tickets colours their rows and names itself beside the key.
  await list.getByText(/^Format rules/).click();
  const form = list.getByRole('form', { name: 'Add rule' });
  await form.getByRole('textbox', { name: 'Name' }).fill('Untouched');
  await form.getByRole('textbox', { name: 'Condition' }).fill('stage = new');
  await form.getByRole('button', { name: 'Add rule' }).click();
  const row = list
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: keys[0] as string, exact: true }) });
  await expect(row).toHaveAttribute('data-tone', 'red');
  await expect(row.getByText('Untouched')).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('[AGL-017] a ticket dragged to another day on the calendar is due there', async ({
  page,
  isMobile,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const key = `C${testInfo.project.name.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-6)}`;
  await track(page, key, `Calendar ${key}`);
  // The 10th of this month, moved to the 17th.
  const now = new Date();
  const day = (n: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), n)).toISOString().slice(0, 10);
  const label = (n: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), n)).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const made = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: key, summary: 'Launch party', dueDate: day(10) },
  });
  expect(made.status(), await made.text()).toBe(201);
  const ticket = (await made.json()).ticket.key as string;

  await page.goto(`${BASE}/#/tracks/${key}`);
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  const calendar = page.getByRole('region', { name: `Calendar of Calendar ${key}` });
  const chip = calendar.getByRole('link', { name: `${ticket} Launch party, due this day` });
  await expect(chip).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  if (isMobile) {
    await chip.click();
    const popup = page.getByRole('dialog', { name: new RegExp(`^${ticket} `) });
    await popup.getByLabel('Due date').fill(day(17));
    await expect(popup.getByText('Saved.')).toBeVisible();
    await popup.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(popup).toBeHidden();
  } else {
    await chip.dragTo(calendar.getByRole('listitem', { name: new RegExp(`^${label(17)}, `) }));
    await expect(calendar.getByRole('status')).toHaveText(`${ticket} is now due on ${label(17)}.`);
  }
  const saved = await (await page.request.get(`${BASE}/api/v1/tickets/${ticket}`)).json();
  expect(saved.ticket.dueDate).toBe(day(17));
  await expect(
    calendar
      .getByRole('listitem', { name: new RegExp(`^${label(17)}, `) })
      .getByRole('link', { name: `${ticket} Launch party, due this day` }),
  ).toBeVisible();
});
