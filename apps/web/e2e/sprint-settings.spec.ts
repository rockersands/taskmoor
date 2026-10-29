import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * Sprint settings end to end (M1-044, M1-045; AGL-007, AGL-012): on a Scrum board made through
 * the API, the board settings page turns an auto-rolling cycle on (ten days on Madrid's clock)
 * with ticket count as the statistic, saves it with the rest of the board, and reads it back
 * after a reload and from the API; no serious axe issue and no sideways page scroll, on a
 * phone either. It uses the attachments database (preview 4174), whose administrator (Ada
 * Attach) the API server made with the ATT track.
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

test('[AGL-012] [AGL-007] a cycle turned on in the board settings and read back', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const word = `cyc${testInfo.project.name}${Date.now().toString(36)}`;
  const made = await page.request.post(`${BASE}/api/v1/boards`, {
    data: { name: `Cycle ${word}`, kind: 'scrum', source: { query: `summary ~ ${word}` } },
  });
  expect(made.status(), await made.text()).toBe(201);
  const boardId = (await made.json()).board.id as number;

  await page.goto(`${BASE}/#/boards/${boardId}/settings`);
  const settings = page.getByRole('region', { name: `Settings of Cycle ${word}` });
  const sprints = settings.getByRole('group', { name: 'Sprints' });
  const cycle = sprints.getByRole('checkbox', { name: 'Roll sprints over automatically' });
  await expect(cycle).not.toBeChecked();
  await expect(sprints.getByRole('spinbutton', { name: 'Days in each sprint' })).toHaveCount(0);

  await sprints.getByRole('combobox', { name: 'Estimate with' }).selectOption('ticketCount');
  await cycle.check();
  const length = sprints.getByRole('spinbutton', { name: 'Days in each sprint' });
  await expect(length).toHaveValue('14');
  await length.fill('10');
  await sprints
    .getByRole('combobox', { name: 'Time zone of the cycle' })
    .selectOption('Europe/Madrid');
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(settings.getByRole('status')).toHaveText('Saved.');

  // Read back: the page after a reload, and the board as the API answers it.
  await page.reload();
  await expect(cycle).toBeChecked();
  await expect(length).toHaveValue('10');
  await expect(sprints.getByRole('combobox', { name: 'Time zone of the cycle' })).toHaveValue(
    'Europe/Madrid',
  );
  await expect(sprints.getByRole('combobox', { name: 'Estimate with' })).toHaveValue('ticketCount');
  const read = await page.request.get(`${BASE}/api/v1/boards/${boardId}`);
  expect((await read.json()).board.sprintSettings).toEqual({
    estimation: { statistic: 'ticketCount' },
    timeTracking: 'remainingEstimate',
    parallelSprints: false,
    cycle: { lengthDays: 10, timeZone: 'Europe/Madrid' },
  });

  // Several active sprints at once: refused beside a cycle, the reason next to it.
  await sprints.getByRole('checkbox', { name: 'Allow several active sprints at once' }).check();
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(settings.getByRole('alert')).toContainText('Not saved.');
  await expect(cycle).toHaveAttribute('aria-invalid', 'true');
  await expect(sprints.getByText('Turn off several active sprints to use it.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await seriousAxeViolations(page)).toEqual([]);
});
