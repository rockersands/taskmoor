import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/**
 * A track's Outcomes section end to end (AGL-024), on tracks of this run's own: outcomes with their
 * progress, status and dates, one opened over the list in the ticket pop-up, a Kanban track listing
 * them too, and an empty track explaining what an outcome is. No serious axe issue and no sideways
 * scroll, on a desktop and a phone. It uses the attachments database (preview 4174), whose
 * administrator (Ada Attach) the API server made.
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

/** A track of this run's own, so the desktop and phone runs never see each other's outcomes. */
async function newTrack(request: APIRequestContext, prefix: string, projectName: string) {
  const key = `${prefix}${projectName.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const made = await request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Outcomes ${key}`, mode: 'shared' },
  });
  expect(made.status(), await made.text()).toBe(201);
  return { key, id: (await made.json()).track.id as number };
}

/** The track's type at a level: 0 standard, 1 outcome. */
async function typeAt(request: APIRequestContext, key: string, rank: number) {
  const res = await request.get(`${BASE}/api/v1/tracks/${key}/ticket-types`);
  expect(res.status()).toBe(200);
  const types = (await res.json()).ticketTypes as { id: number; level: { rank: number } }[];
  return types.find((t) => t.level.rank === rank)?.id as number;
}

async function makeTicket(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post(`${BASE}/api/v1/tickets`, { data });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).ticket as { id: number; key: string };
}

async function close(request: APIRequestContext, id: number) {
  const offered = (await (await request.get(`${BASE}/api/v1/tickets/${id}/transitions`)).json())
    .transitions as { id: number; to: { stage: string } }[];
  const res = await request.post(`${BASE}/api/v1/tickets/${id}/transitions`, {
    data: { transitionId: offered.find((o) => o.to.stage === 'closed')?.id },
  });
  expect(res.status(), await res.text()).toBe(200);
}

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test.beforeEach(async ({ page }) => {
  const res = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(res.status()).toBe(200);
});

test('[AGL-024] lists outcomes with their progress and opens one over the list', async ({
  page,
}, testInfo) => {
  const { key } = await newTrack(page.request, 'O', testInfo.project.name);
  const outcomeType = await typeAt(page.request, key, 1);
  const standard = await typeAt(page.request, key, 0);
  const goal = await makeTicket(page.request, {
    track: key,
    summary: 'Launch the beta',
    ticketTypeId: outcomeType,
    startDate: '2026-11-02',
    dueDate: '2026-12-18',
  });
  const quiet = await makeTicket(page.request, {
    track: key,
    summary: 'Faster search',
    ticketTypeId: outcomeType,
  });
  const parts = [];
  for (const summary of ['Part A', 'Part B', 'Part C']) {
    parts.push(
      await makeTicket(page.request, {
        track: key,
        summary,
        ticketTypeId: standard,
        parent: goal.key,
      }),
    );
  }
  await close(page.request, parts[0]?.id as number);

  await page.goto(`${BASE}/#/tracks/${key}/outcomes`);
  const tabs = page.getByRole('navigation', { name: `Sections of ${key}` });
  await expect(tabs.getByRole('link', { name: 'Outcomes' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { level: 1, name: 'Outcomes' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Outcomes' });
  const rows = list.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  const first = rows.nth(0);
  await expect(first.getByRole('link')).toHaveText(`${goal.key} Launch the beta`);
  await expect(first.getByRole('progressbar', { name: '1 of 3 closed (33%)' })).toBeVisible();
  await expect(first.getByText('1 of 3', { exact: true })).toBeVisible();
  await expect(first.getByText('Starts Nov 2, 2026 · Due Dec 18, 2026')).toBeVisible();
  await expect(first.getByText('New', { exact: true })).toBeVisible();
  await expect(rows.nth(1).getByRole('link')).toHaveText(`${quiet.key} Faster search`);
  await expect(rows.nth(1).getByText('No tickets under it yet')).toBeVisible();
  await noSidewaysScroll(page);
  expect(await seriousAxeViolations(page)).toEqual([]);

  // The ticket opens over the list, and closing it leaves the list as it was.
  await first.getByRole('link').click();
  const dialog = page.getByRole('dialog', { name: `${goal.key} Launch the beta` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('1 of 3 closed (33%)')).toBeVisible();
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(rows).toHaveCount(2);
});

test('[AGL-024] a Kanban track lists its outcomes too, and an empty one explains them', async ({
  page,
}, testInfo) => {
  const { key, id } = await newTrack(page.request, 'K', testInfo.project.name);
  const board = await page.request.post(`${BASE}/api/v1/boards`, {
    data: { name: `Flow ${key}`, kind: 'kanban', trackId: id, source: { query: `track = ${key}` } },
  });
  expect(board.status(), await board.text()).toBe(201);

  await page.goto(`${BASE}/#/tracks/${key}/outcomes`);
  const tabs = page.getByRole('navigation', { name: `Sections of ${key}` });
  await expect(tabs.getByRole('link', { name: 'Outcomes' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Board' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Backlog' })).toHaveCount(0);
  await expect(page.getByText('No outcomes yet')).toBeVisible();
  await expect(page.getByText(/create a ticket of the type Outcome/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create a ticket' })).toBeVisible();
  await noSidewaysScroll(page);
  expect(await seriousAxeViolations(page)).toEqual([]);

  const goal = await makeTicket(page.request, {
    track: key,
    summary: 'Steady flow',
    ticketTypeId: await typeAt(page.request, key, 1),
  });
  await page.reload();
  await expect(
    page
      .getByRole('list', { name: 'Outcomes' })
      .getByRole('link', { name: `${goal.key} Steady flow` }),
  ).toBeVisible();
});
