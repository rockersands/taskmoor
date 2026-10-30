import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * Planning on the backlog end to end (M1-047; AGL-008, AGL-009, AGL-010): on a Scrum board of a
 * track of its own, tickets are made inline, two are selected and moved into a new sprint in
 * one operation, one is put under an outcome by a drop on the panel (with the selection's menu
 * on a phone), the sprint is reordered by a drag (Alt and an arrow on a phone), a release is
 * added from the menu and filters the sections, and the sprint is started and completed with
 * its tickets back in the backlog; no serious axe issue and no sideways page scroll. It uses the
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

test('[AGL-008] [AGL-009] [AGL-010] tickets planned into a sprint, an outcome and a release', async ({
  page,
  isMobile,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const stamp = Date.now().toString(36).toUpperCase().slice(-6);
  const key = `P${testInfo.project.name.slice(0, 1).toUpperCase()}${stamp}`;
  const word = `bpl${testInfo.project.name}${stamp.toLowerCase()}`;
  const track = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Planning ${key}`, mode: 'shared' },
  });
  expect(track.status(), await track.text()).toBe(201);
  const trackId = (await track.json()).track.id as number;
  const types = await (
    await page.request.get(`${BASE}/api/v1/tracks/${trackId}/ticket-types`)
  ).json();
  const outcomeType = (types.ticketTypes as { id: number; name: string }[]).find(
    (y) => y.name === 'Outcome',
  );
  expect(outcomeType).toBeDefined();
  const goal = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: key, summary: 'Faster checkout', ticketTypeId: outcomeType?.id },
  });
  expect(goal.status(), await goal.text()).toBe(201);
  const release = await page.request.post(`${BASE}/api/v1/tracks/${trackId}/releases`, {
    data: { name: `Checkout ${stamp}` },
  });
  expect(release.status(), await release.text()).toBe(201);
  const made = await page.request.post(`${BASE}/api/v1/boards`, {
    data: { name: `Plan ${word}`, kind: 'scrum', trackId, source: { query: `summary ~ ${word}` } },
  });
  expect(made.status(), await made.text()).toBe(201);
  const boardId = (await made.json()).board.id as number;

  await page.goto(`${BASE}/#/boards/${boardId}/backlog`);
  const backlog = page.getByRole('region', { name: 'Backlog and sprints' });
  const section = (name: string) => backlog.getByRole('region', { name, exact: true });
  const keysIn = async (name: string) =>
    (await section(name).locator('.sprint-ticket-key').allTextContents()).map((k) => k.trim());
  const status = backlog.getByRole('status');
  const panels = backlog.getByRole('complementary', { name: 'Outcomes and releases' });
  const outcome = panels.getByRole('button', { name: /Faster checkout/ });
  await expect(outcome).toContainText('0 tickets, 0 closed');

  // Inline create: three tickets at the bottom of the backlog (the goal is the track's first).
  const create = section('Backlog').getByRole('textbox', {
    name: 'Summary of a new ticket in Backlog',
  });
  const [first, second, third] = [`${key}-2`, `${key}-3`, `${key}-4`];
  for (const [summary, ticket] of [
    ['Card payments', first],
    ['Order total', second],
    ['Gift cards', third],
  ] as const) {
    await create.fill(`${summary} ${word}`);
    await create.press('Enter');
    await expect(status).toHaveText(`${ticket} created.`);
  }
  await expect.poll(() => keysIn('Backlog')).toEqual([first, second, third]);

  // Two selected, into a new sprint in one operation.
  await backlog.getByRole('button', { name: 'Create sprint' }).click();
  const sprintName = `Plan ${word} Sprint 1`;
  await expect(section(sprintName)).toBeVisible();
  await backlog.getByRole('checkbox', { name: `Select ${first}` }).check();
  await backlog.getByRole('checkbox', { name: `Select ${second}` }).check();
  const selection = backlog.getByRole('group', { name: 'Selected tickets' });
  await expect(selection).toContainText('2 tickets selected');
  await selection
    .getByRole('combobox', { name: 'Move selected to…' })
    .selectOption({ label: sprintName });
  await expect(status).toHaveText(`2 tickets moved to ${sprintName}.`);
  await expect.poll(() => keysIn(sprintName)).toEqual([first, second]);
  await selection.getByRole('button', { name: 'Clear selection' }).click();

  // The third under the outcome: dropped on the panel, or with the menu on a phone.
  if (isMobile) {
    await backlog.getByRole('checkbox', { name: `Select ${third}` }).check();
    await selection
      .getByRole('combobox', { name: 'Put selected under…' })
      .selectOption({ label: `${key}-1 Faster checkout` });
    await expect(status).toHaveText(`1 ticket put under ${key}-1 Faster checkout.`);
    await selection.getByRole('button', { name: 'Clear selection' }).click();
  } else {
    await section('Backlog').locator(`[data-ticket-id]`).filter({ hasText: third }).dragTo(outcome);
    await expect(status).toHaveText(`1 ticket put under ${key}-1 Faster checkout.`);
  }
  await expect(outcome).toContainText('1 ticket, 0 closed');

  // The second above the first: dragged, or Alt and the up arrow on a phone.
  if (isMobile) {
    await section(sprintName).getByRole('link', { name: second }).focus();
    await page.keyboard.press('Alt+ArrowUp');
  } else {
    const rows = section(sprintName).locator('[data-ticket-id]');
    await rows.filter({ hasText: second }).dragTo(rows.filter({ hasText: first }), {
      targetPosition: { x: 40, y: 2 },
    });
  }
  await expect.poll(() => keysIn(sprintName)).toEqual([second, first]);

  // A release for the first, then the sections filtered by it.
  await backlog.getByRole('checkbox', { name: `Select ${first}` }).check();
  await selection
    .getByRole('combobox', { name: 'Add selected to release…' })
    .selectOption({ label: `Checkout ${stamp}` });
  const releaseItem = panels.getByRole('button', { name: new RegExp(`Checkout ${stamp}`) });
  await expect(releaseItem).toContainText('1 ticket');
  await selection.getByRole('button', { name: 'Clear selection' }).click();
  await releaseItem.click();
  await expect.poll(() => keysIn(sprintName)).toEqual([first]);
  await expect.poll(() => keysIn('Backlog')).toEqual([]);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await backlog.getByRole('button', { name: 'Show all tickets' }).click();
  await expect.poll(() => keysIn('Backlog')).toEqual([third]);

  // Started and completed: its unfinished tickets back in the backlog, in rank order.
  await section(sprintName).getByRole('button', { name: 'Start sprint' }).click();
  await expect(section(sprintName).getByText('Active', { exact: true })).toBeVisible();
  await section(sprintName).getByRole('button', { name: 'Complete sprint' }).click();
  await expect(section(sprintName)).toHaveCount(0);
  await expect.poll(() => keysIn('Backlog')).toEqual([second, first, third]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await seriousAxeViolations(page)).toEqual([]);
});
