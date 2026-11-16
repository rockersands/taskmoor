import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import { uniqueKey, uniqueStamp } from './unique';

/**
 * The Priorities page (T-320; CORE-014): a site administrator adds a priority, moves it up and
 * renames it; deletes it once a ticket has it, choosing the priority the ticket gets instead;
 * adds a priority set and deletes it; adds a close reason, moves it and deletes it. On a phone the
 * page fits the width with finger-sized buttons. No serious axe issue. They use the attachments
 * database (preview 4174), whose site administrator the API server made.
 *
 * The site's lists are shared by every test of the run, so the changing journey runs once, on the
 * desktop: what it adds sits at the end of a list, is moved up once and is gone again by the end,
 * never touching the first priority or close reason that other tests choose.
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

async function signIn(page: Page) {
  const res = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(res.status()).toBe(200);
}

const fitsWidth = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/** The names of a card's rows, in order. */
const rowNames = (page: Page, card: string) =>
  page
    .getByRole('region', { name: card })
    .getByRole('listitem')
    .locator('.people-name')
    .allTextContents();

test('[CORE-014] the administrator keeps priorities, a priority set and close reasons', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one journey: the lists are shared by the run');
  await signIn(page);
  const stamp = uniqueStamp(testInfo);
  const name = `Escalated ${stamp}`;
  await page.goto(`${BASE}/#/admin/priorities`);
  await expect(page.getByRole('heading', { level: 1, name: 'Priorities' })).toBeVisible();
  const priorities = page.getByRole('region', { name: 'Priorities, most urgent first' });

  // A new priority goes to the end of the list; moved up, it sits above the last one.
  await priorities.getByRole('button', { name: 'New priority' }).click();
  const add = priorities.getByRole('form', { name: 'Add a priority' });
  await add.getByLabel('Name').fill(name);
  await add.getByRole('button', { name: 'Add a priority' }).click();
  await expect(priorities.getByText(`${name} was added.`)).toBeVisible();
  const before = await rowNames(page, 'Priorities, most urgent first');
  expect(before.at(-1)).toBe(name);
  await priorities.getByRole('button', { name: `Move priority ${name} up` }).click();
  await expect(priorities.getByText(`${name} moved up.`)).toBeVisible();
  const after = await rowNames(page, 'Priorities, most urgent first');
  expect(after.at(-2)).toBe(name);
  expect(after.at(-1)).toBe(before.at(-2));

  // Renamed, with a description.
  const renamed = `Escalation ${stamp}`;
  await priorities.getByRole('button', { name: `Change priority ${name}` }).click();
  const change = priorities.getByRole('form', { name: `Change priority ${name}` });
  await change.getByLabel('Name').fill(renamed);
  await change.getByLabel('Description (optional)').fill('Raised by a customer.');
  await change.getByRole('button', { name: 'Save' }).click();
  await expect(priorities.getByText(`${renamed} was saved.`)).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);

  // A ticket has it: deleting it asks which priority the ticket gets instead.
  const key = uniqueKey('PR', testInfo);
  const track = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Priorities ${stamp}`, mode: 'shared' },
  });
  expect(track.status(), await track.text()).toBe(201);
  const listed = await (await page.request.get(`${BASE}/api/v1/priorities`)).json();
  const mine = (listed.priorities as { id: number; name: string }[]).find(
    (p) => p.name === renamed,
  );
  const made = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: key, summary: 'Card payments fail', priorityId: mine?.id },
  });
  expect(made.status(), await made.text()).toBe(201);
  const ticketKey = (await made.json()).ticket.key as string;
  await priorities.getByRole('button', { name: `Delete priority ${renamed}` }).click();
  await priorities
    .getByRole('group', { name: new RegExp(`^Delete ${renamed}\\?`) })
    .getByRole('button', { name: `Delete priority ${renamed}` })
    .click();
  const replace = priorities.getByRole('form', { name: `What takes the place of ${renamed}` });
  await expect(replace.getByText(`1 ticket has ${renamed}.`, { exact: false })).toBeVisible();
  await replace.getByLabel('Instead, give them').selectOption({ label: 'Low' });
  expect(await seriousAxeViolations(page)).toEqual([]);
  await replace.getByRole('button', { name: `Delete priority ${renamed}` }).click();
  await expect(
    priorities.getByText(`${renamed} was deleted; its tickets have Low now.`),
  ).toBeVisible();
  const ticket = await (await page.request.get(`${BASE}/api/v1/tickets/${ticketKey}`)).json();
  expect(ticket.ticket.priority.name).toBe('Low');

  // A priority set: two priorities, Low for new tickets; no track uses it, so it goes at once.
  const sets = page.getByRole('region', { name: 'Priority sets' });
  const set = `Set ${stamp}`;
  await sets.getByRole('button', { name: 'New priority set' }).click();
  const addSet = sets.getByRole('form', { name: 'Add a priority set' });
  await addSet.getByLabel('Set name').fill(set);
  await addSet.getByLabel('Urgent').check();
  await addSet.getByLabel('Low', { exact: true }).check();
  await addSet.getByLabel('New tickets get').selectOption({ label: 'Low' });
  await addSet.getByRole('button', { name: 'Add a priority set' }).click();
  await expect(sets.getByText(`${set} was added.`)).toBeVisible();
  await expect(
    sets.getByText('Offers Urgent and Low. New tickets get Low. No track uses it.'),
  ).toBeVisible();
  await sets.getByRole('button', { name: `Manage priority set ${set}` }).click();
  await sets.getByRole('button', { name: `Delete priority set ${set}` }).click();
  await sets
    .getByRole('group', { name: `Delete ${set}? No track uses it. This cannot be undone.` })
    .getByRole('button', { name: `Delete priority set ${set}` })
    .click();
  await expect(sets.getByText(`${set} was deleted.`)).toBeVisible();

  // A close reason, moved up once and deleted.
  const reasons = page.getByRole('region', { name: 'Close reasons' });
  const reason = `Withdrawn ${stamp}`;
  await reasons.getByRole('button', { name: 'New close reason' }).click();
  const addReason = reasons.getByRole('form', { name: 'Add a close reason' });
  await addReason.getByLabel('Name').fill(reason);
  await addReason.getByRole('button', { name: 'Add a close reason' }).click();
  await expect(reasons.getByText(`${reason} was added.`)).toBeVisible();
  await reasons.getByRole('button', { name: `Move close reason ${reason} up` }).click();
  await expect(reasons.getByText(`${reason} moved up.`)).toBeVisible();
  expect((await rowNames(page, 'Close reasons')).at(-2)).toBe(reason);
  await reasons.getByRole('button', { name: `Delete close reason ${reason}` }).click();
  await reasons
    .getByRole('group', { name: new RegExp(`^Delete ${reason}\\?`) })
    .getByRole('button', { name: `Delete close reason ${reason}` })
    .click();
  await expect(reasons.getByText(`${reason} was deleted.`)).toBeVisible();
  expect(await rowNames(page, 'Close reasons')).not.toContain(reason);
  expect(await fitsWidth(page)).toBe(true);
});

test('[CORE-014] the Priorities page fits the screen, with finger-sized buttons on a phone', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto(`${BASE}/#/admin/priorities`);
  const priorities = page.getByRole('region', { name: 'Priorities, most urgent first' });
  const up = priorities.getByRole('button', { name: 'Move priority High up' });
  await expect(up).toBeVisible();
  // Opened and left without a change: nothing here is saved.
  await page.getByRole('button', { name: 'Manage priority set Default priority set' }).click();
  await expect(
    page.getByRole('form', { name: 'Change priority set Default priority set' }),
  ).toBeVisible();
  await expect(page.getByText(/^Tracks that choose no set use this one\./)).toBeVisible();
  await priorities.getByRole('button', { name: 'New priority' }).click();
  await expect(priorities.getByRole('form', { name: 'Add a priority' })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  if (testInfo.project.name === 'mobile') {
    for (const target of [
      up,
      priorities.getByRole('button', { name: 'Change priority High' }),
      priorities.getByRole('button', { name: 'Delete priority High' }),
    ]) {
      expect((await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  }
  expect(await seriousAxeViolations(page)).toEqual([]);
});
