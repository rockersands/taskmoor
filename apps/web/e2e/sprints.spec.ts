import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * Sprints end to end (M1-044; AGL-008, AGL-010, AGL-011): on a Scrum board made through the
 * API, a sprint is created in the backlog, two tickets are moved into it with the menu, it is
 * started, the board shows its tickets only, its report opens, and it is completed with the
 * unfinished tickets sent back to the backlog; no serious axe issue and no sideways page
 * scroll, on a phone either. Then a sprint is completed from its board (T-106): the pop-up
 * counts its done and open tickets, Escape cancels, and the open ones go to a planned sprint.
 * It uses the attachments database (preview 4174), whose administrator (Ada Attach) the API
 * server made.
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

test('[AGL-010] [AGL-008] a sprint planned, started, reported and completed from the backlog', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const word = `spr${testInfo.project.name}${Date.now().toString(36)}`;
  const key = `S${testInfo.project.name.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-7)}`;
  const track = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Sprint ${word}`, mode: 'shared' },
  });
  expect(track.status(), await track.text()).toBe(201);
  const trackId = (await track.json()).track.id as number;
  const keys: string[] = [];
  for (const summary of ['Card payments', 'Order total', 'Gift cards']) {
    const res = await page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: key, summary: `${summary} ${word}`, originalEstimate: '2h' },
    });
    expect(res.status(), await res.text()).toBe(201);
    keys.push((await res.json()).ticket.key as string);
  }
  const [first, second, third] = keys as [string, string, string];
  const made = await page.request.post(`${BASE}/api/v1/boards`, {
    // Estimated in time here; a new board otherwise estimates with Points (AGL-007).
    data: {
      name: `Sprint ${word}`,
      kind: 'scrum',
      trackId,
      sprintSettings: {
        estimation: { statistic: 'originalEstimate' },
        timeTracking: 'remainingEstimate',
        parallelSprints: false,
      },
    },
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

test('[AGL-010] a sprint completed from its board, after a pop-up that counts its tickets', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const word = `end${testInfo.project.name}${Date.now().toString(36)}`;
  const key = `E${testInfo.project.name.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-7)}`;
  const track = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Finish ${word}`, mode: 'shared' },
  });
  expect(track.status(), await track.text()).toBe(201);
  const trackId = (await track.json()).track.id as number;
  const keys: string[] = [];
  for (const summary of ['Card payments', 'Order total', 'Gift cards']) {
    const res = await page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: key, summary: `${summary} ${word}` },
    });
    expect(res.status(), await res.text()).toBe(201);
    keys.push((await res.json()).ticket.key as string);
  }
  const [first, second, third] = keys as [string, string, string];
  const made = await page.request.post(`${BASE}/api/v1/boards`, {
    data: { name: `Finish ${word}`, kind: 'scrum', trackId },
  });
  expect(made.status(), await made.text()).toBe(201);
  const boardId = (await made.json()).board.id as number;

  // An active sprint with the three tickets, one of them closed, and a planned sprint after it.
  const sprintIds: number[] = [];
  const sprintNames: string[] = [];
  for (let i = 0; i < 2; i++) {
    const res = await page.request.post(`${BASE}/api/v1/boards/${boardId}/sprints`, { data: {} });
    expect(res.status(), await res.text()).toBe(201);
    const { sprint } = await res.json();
    sprintIds.push(sprint.id as number);
    sprintNames.push(sprint.name as string);
  }
  const [running] = sprintIds as [number, number];
  const [runningName, nextName] = sprintNames as [string, string];
  const added = await page.request.post(`${BASE}/api/v1/sprints/${running}/tickets`, {
    data: { tickets: keys },
  });
  expect(added.status(), await added.text()).toBeLessThan(300);
  const started = await page.request.post(`${BASE}/api/v1/sprints/${running}/start`, {
    data: { endAt: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString() },
  });
  expect(started.status(), await started.text()).toBe(200);
  const transitions = await (
    await page.request.get(`${BASE}/api/v1/tickets/${first}/transitions`)
  ).json();
  const close = (transitions.transitions as { id: number; to: { stage: string } }[]).find(
    (x) => x.to.stage === 'closed',
  );
  const reasons = await (await page.request.get(`${BASE}/api/v1/close-reasons`)).json();
  const closed = await page.request.post(`${BASE}/api/v1/tickets/${first}/transitions`, {
    data: { transitionId: close?.id, fields: { 'close-reason': reasons.closeReasons[0].id } },
  });
  expect(closed.status(), await closed.text()).toBe(200);

  await page.goto(`${BASE}/#/boards/${boardId}`);
  const board = page.getByRole('region', { name: `Finish ${word}` });
  await expect(board.getByRole('link', { name: new RegExp(`^${second} `) })).toBeVisible();
  // The page header's button; the pop-up, over the board, has a Complete sprint of its own.
  const button = board.locator('header').getByRole('button', { name: 'Complete sprint' });
  await button.click();
  const dialog = page.getByRole('dialog', { name: `Complete ${runningName}?` });
  await expect(dialog.getByText('1 ticket is done and 2 are open.')).toBeVisible();
  const where = dialog.getByRole('combobox', { name: 'Open tickets go to' });
  await expect(where).toHaveValue('backlog');
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (testInfo.project.name === 'mobile') {
    // A finger's targets (pointer: coarse): the board's button, the choice and both buttons.
    for (const target of [
      button,
      where,
      dialog.getByRole('button', { name: 'Complete sprint' }),
      dialog.getByRole('button', { name: 'Cancel' }),
    ]) {
      expect((await target.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
  }

  // Escape cancels and gives focus back; the keyboard opens it again and completes.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await where.selectOption({ label: nextName });
  await dialog.getByRole('button', { name: 'Complete sprint' }).click();
  await expect(dialog).toHaveCount(0);

  // The board shows the next state at once: no sprint running, focus on the way to the backlog.
  await expect(board.getByText('No sprint is running')).toBeVisible();
  await expect(button).toHaveCount(0);
  await expect(board.getByRole('link', { name: 'Backlog', exact: true })).toBeFocused();
  expect(await seriousAxeViolations(page)).toEqual([]);

  // The open tickets went to the planned sprint; the closed one stayed with the completed sprint.
  const sprints = await (await page.request.get(`${BASE}/api/v1/boards/${boardId}/sprints`)).json();
  expect(
    (sprints.sprints as { id: number; state: string }[]).find((s) => s.id === running)?.state,
  ).toBe('closed');
  await board.getByRole('link', { name: 'Backlog', exact: true }).click();
  const backlog = page.getByRole('region', { name: 'Backlog and sprints' });
  const planned = backlog.getByRole('region', { name: nextName, exact: true });
  await expect(planned.getByRole('link', { name: second })).toBeVisible();
  await expect(planned.getByRole('link', { name: third })).toBeVisible();
  await expect(backlog.getByRole('link', { name: first })).toHaveCount(0);
});
