import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import { finger } from './touch';

/**
 * List and calendar views end to end (M1-049; AGL-016, AGL-017), on tracks of their own:
 * fifty rows of a track's list edited in place one after another (five on a phone), the list
 * grouped by priority with its count, a format rule naming and colouring the rows it finds,
 * and on the calendar a ticket dragged to another day (on a phone, its days changed in its
 * pop-up) with its due day saved, then a day later by its grip: dragged by a real finger on a
 * phone (T-162b), through the grip's menu on a desktop. No serious axe issue and no sideways
 * page scroll. It uses the attachments database (preview 4174), whose administrator (Ada
 * Attach) the API server made.
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
  // Titled by its section, under the track's name (D26).
  const list = page.getByRole('region', { name: 'List', exact: true });
  await expect(list.getByRole('link', { name: keys[0] as string, exact: true })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  if (isMobile) {
    // A phone shows stacked rows (D1), never a squeezed table; the edits in place are the
    // wide table's.
    await expect(list.getByRole('table')).toHaveCount(0);
    await expect(list.getByRole('list', { name: 'Tickets' }).getByRole('listitem')).toHaveCount(50);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    return;
  }

  // Each row's summary edited in place, without leaving the list.
  for (const ticket of keys) {
    await list.getByRole('button', { name: `Edit Summary of ${ticket}`, exact: true }).click();
    const input = list.getByRole('textbox', { name: `Edit Summary of ${ticket}`, exact: true });
    await input.fill(`Edited ${ticket}`);
    await input.press('Enter');
    await expect(list.getByText(`Edited ${ticket}`, { exact: true })).toBeVisible();
  }
  const last = keys[49] as string;
  const saved = await (await page.request.get(`${BASE}/api/v1/tickets/${last}`)).json();
  expect(saved.ticket.summary).toBe(`Edited ${last}`);

  // Grouped by priority: every ticket has the default one.
  await list.getByRole('combobox', { name: 'Group by' }).selectOption({ label: 'Priority' });
  await expect(list.getByRole('heading', { name: /\(50 tickets\)$/ })).toBeVisible();

  // A rule for new tickets colours their rows and names itself beside the key. Format rules
  // open as the shared pop-over (T-216).
  await list.getByRole('button', { name: /^Format rules/ }).click();
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
  if (isMobile) {
    // A phone lists only the days with something on them (D9): the 18th, where a finger drops
    // the ticket below, holds another.
    const other = await page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: key, summary: 'Thank-you notes', dueDate: day(18) },
    });
    expect(other.status(), await other.text()).toBe(201);
  }

  await page.goto(`${BASE}/#/tracks/${key}`);
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  const calendar = page.getByRole('region', { name: 'Calendar', exact: true });
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

  // A day later by its grip (T-162b): on a phone a finger drags it to the 18th, the next day in
  // the list; on a desktop the grip's menu makes the same move.
  const grip = calendar.getByRole('button', { name: `Move the due day of ${ticket}` });
  const eighteenth = calendar.getByRole('listitem', { name: new RegExp(`^${label(18)}, `) });
  if (isMobile) {
    // In the middle of the screen, clear of the edges where a drag scrolls the page.
    await grip.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const from = await grip.boundingBox();
    const to = await eighteenth.boundingBox();
    if (!from || !to) throw new Error('the grip and the next day are on the page');
    const hand = await finger(page);
    await hand.down({ x: from.x + from.width / 2, y: from.y + from.height / 2 });
    await hand.moveTo({ x: to.x + to.width / 2, y: to.y + to.height / 2 });
    await expect(eighteenth).toHaveClass(/is-drop-target/);
    await hand.up();
  } else {
    await grip.click();
    await page.getByRole('menuitem', { name: 'One day later' }).click();
    // The keyboard stays with the entry on its new day.
    await expect(
      eighteenth.getByRole('button', { name: `Move the due day of ${ticket}` }),
    ).toBeFocused();
  }
  await expect(calendar.getByRole('status')).toHaveText(`${ticket} is now due on ${label(18)}.`);
  await expect(
    eighteenth.getByRole('link', { name: `${ticket} Launch party, due this day` }),
  ).toBeVisible();
  const later = await (await page.request.get(`${BASE}/api/v1/tickets/${ticket}`)).json();
  expect(later.ticket.dueDate).toBe(day(18));
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
