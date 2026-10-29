import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * Sprints end to end (M1-044; AGL-008, AGL-010, AGL-011): on a Scrum board made through the
 * API, a sprint is created in the backlog, two tickets are moved into it with the menu, it is
 * started, the board shows its tickets only, its report opens, and it is completed with the
 * unfinished tickets sent back to the backlog; no serious axe issue and no sideways page
 * scroll, on a phone either. It uses the attachments database (preview 4174), whose
 * administrator (Ada Attach) the API server made with the ATT track.
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

test('[AGL-010] [AGL-008] a sprint planned, started, reported and completed from the backlog', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const word = `spr${testInfo.project.name}${Date.now().toString(36)}`;
  const keys: string[] = [];
  for (const summary of ['Card payments', 'Order total', 'Gift cards']) {
    const res = await page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: 'ATT', summary: `${summary} ${word}`, originalEstimate: '2h' },
    });
    expect(res.status(), await res.text()).toBe(201);
    keys.push((await res.json()).ticket.key as string);
  }
  const [first, second, third] = keys as [string, string, string];
  const made = await page.request.post(`${BASE}/api/v1/boards`, {
    data: { name: `Sprint ${word}`, kind: 'scrum', source: { query: `summary ~ ${word}` } },
  });
  expect(made.status(), await made.text()).toBe(201);
  const boardId = (await made.json()).board.id as number;

  await page.goto(`${BASE}/#/boards/${boardId}/backlog`);
  const backlog = page.getByRole('region', { name: 'Backlog and sprints' });
  const section = (name: string) => backlog.getByRole('region', { name, exact: true });
  await expect(section('Backlog').getByRole('link', { name: first })).toBeVisible();
  await backlog.getByRole('button', { name: 'Create sprint' }).click();
  const sprintName = `Sprint ${word} Sprint 1`;
  await expect(section(sprintName)).toBeVisible();

  // Two tickets into the sprint with the move menu (the keyboard works the same select).
  for (const key of [first, second]) {
    await section('Backlog')
      .getByRole('combobox', { name: `Move ${key} to` })
      .selectOption({ label: sprintName });
    await expect(section(sprintName).getByRole('link', { name: key })).toBeVisible();
  }
  await expect(section(sprintName).getByText('2 tickets, estimate 4h, 4h remaining')).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await section(sprintName).getByRole('button', { name: 'Start sprint' }).click();
  await expect(section(sprintName).getByText('Active', { exact: true })).toBeVisible();

  // The board shows the active sprint's tickets only.
  await backlog.getByRole('link', { name: 'Back to the board' }).click();
  const board = page.getByRole('region', { name: `Sprint ${word}` });
  await expect(board.getByRole('link', { name: new RegExp(`^${first} `) })).toBeVisible();
  await expect(board.getByRole('link', { name: new RegExp(`^${third} `) })).toHaveCount(0);
  await board.getByRole('link', { name: 'Backlog' }).click();

  // The report, then completion to the backlog.
  await section(sprintName).getByRole('link', { name: 'Sprint report' }).click();
  const report = page.getByRole('region', { name: `Sprint report: ${sprintName}` });
  await expect(report.getByRole('region', { name: 'Tickets not completed' })).toContainText(first);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await report.getByRole('link', { name: 'Back to the backlog' }).click();
  await section(sprintName).getByRole('button', { name: 'Complete sprint' }).click();
  await expect(section(sprintName)).toHaveCount(0);
  await expect(section('Backlog').getByRole('link', { name: second })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await seriousAxeViolations(page)).toEqual([]);
});
