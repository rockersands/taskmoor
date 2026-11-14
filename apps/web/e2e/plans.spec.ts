import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * Multi-track end to end (T-088; PLN-001, PLN-012; ADR-122): two tracks of their own, an outcome
 * with a dated feature in one and a dated ticket in the other, and a plan over both. The sidebar
 * lists Multi-track; the plan's Summary counts both tracks and links each number to its search;
 * its Timeline rolls the outcome up, and a bar dragged a week later (on a phone, its side panel)
 * moves the ticket's dates through the ticket's own route; a track filter in the address narrows
 * the view. No serious axe issue and no sideways page scroll, on a phone too. It uses the
 * attachments database (preview 4174), whose administrator (Ada Attach) the API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

/**
 * The browser keeps a person's clock in Mexico City (UTC−6) at 8 pm, when UTC is already the next
 * day, and the day is fixed, so where today falls (the range drawn, where it first scrolls) does
 * not depend on when the test runs: the bars of 2–12 November are in view around the 6th.
 */
test.use({ timezoneId: 'America/Mexico_City' });
const EVENING = new Date('2026-11-06T20:00:00-06:00');

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
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test('[PLN-012] a plan over two tracks: its numbers, its timeline and a ticket rescheduled', async ({
  page,
  isMobile,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const stamp = `${testInfo.project.name.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-5)}`;
  const keys = [`MA${stamp}`, `MB${stamp}`];
  const ids: number[] = [];
  for (const key of keys) {
    const track = await page.request.post(`${BASE}/api/v1/tracks`, {
      data: { key, name: `Team ${key}`, mode: 'shared' },
    });
    expect(track.status(), await track.text()).toBe(201);
    ids.push((await track.json()).track.id as number);
  }
  const types = await (
    await page.request.get(`${BASE}/api/v1/tracks/${ids[0]}/ticket-types`)
  ).json();
  const typeId = (name: string) =>
    (types.ticketTypes as { id: number; name: string }[]).find((y) => y.name === name)?.id;
  const make = async (track: string, data: Record<string, unknown>) => {
    const res = await page.request.post(`${BASE}/api/v1/tickets`, { data: { track, ...data } });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()).ticket.key as string;
  };
  const goal = await make(keys[0] as string, {
    summary: 'Spring launch',
    ticketTypeId: typeId('Outcome'),
  });
  const site = await make(keys[0] as string, {
    summary: 'Build the shop page',
    ticketTypeId: typeId('Feature'),
    parent: goal,
    startDate: '2026-11-02',
    dueDate: '2026-11-10',
  });
  const servers = await make(keys[1] as string, {
    summary: 'Scale the servers',
    startDate: '2026-11-05',
    dueDate: '2026-11-12',
  });
  const made = await page.request.post(`${BASE}/api/v1/plans`, {
    data: {
      name: `Launch ${stamp}`,
      sources: ids.map((trackId) => ({ kind: 'track', trackId })),
    },
  });
  expect(made.status(), await made.text()).toBe(201);
  const planId = (await made.json()).plan.id as number;

  // Multi-track is in the sidebar, under "Plan and track".
  await page.clock.setFixedTime(EVENING);
  await page.goto(`${BASE}/#/home`);
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Multi-track' }).click();
  await page.getByRole('link', { name: `Launch ${stamp}` }).click();

  // The Summary: both tracks counted, each number a search.
  await expect(page.getByRole('heading', { level: 1, name: `Launch ${stamp}` })).toBeVisible();
  const total = page.getByRole('link', { name: '3 tickets in this plan' });
  await expect(total).toBeVisible();
  const href = (await total.getAttribute('href')) ?? '';
  expect(decodeURIComponent(href.replace(/\+/g, ' '))).toContain(
    `track IN ("${keys[0]}", "${keys[1]}")`,
  );
  await expect(page.getByRole('link', { name: `${keys[1]} 1, open the search` })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // The Timeline: the outcome rolled up from its feature, the other track's ticket beside it.
  await page.getByRole('link', { name: 'Timeline', exact: true }).click();
  await expect(
    page.getByRole('img', {
      name: `${goal}: Nov 2, 2026 to Nov 10, 2026, rolled up from its children`,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: `${servers}: Nov 5, 2026 to Nov 12, 2026` }),
  ).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  const bar = page.getByRole('button', { name: `${site}: Nov 2, 2026 to Nov 10, 2026` });
  if (isMobile) {
    await bar.click();
    const panel = page.getByRole('complementary', { name: `Days of ${site}` });
    await panel.getByLabel('Start date').fill('2026-11-09');
    await panel.getByLabel('Due date').fill('2026-11-17');
    await panel.getByRole('button', { name: 'Save dates' }).click();
  } else {
    // A week at 28px a day, from the middle of the bar.
    const box = await bar.boundingBox();
    if (!box) throw new Error('the bar has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 7; step++) {
      await page.mouse.move(box.x + box.width / 2 + step * 28, box.y + box.height / 2);
    }
    await page.mouse.up();
  }
  await expect(page.getByRole('status').filter({ hasText: site })).toHaveText(
    `${site} now runs from Nov 9, 2026 to Nov 17, 2026.`,
  );
  const saved = await (await page.request.get(`${BASE}/api/v1/tickets/${site}`)).json();
  expect([saved.ticket.startDate, saved.ticket.dueDate]).toEqual(['2026-11-09', '2026-11-17']);
  await expect(
    page.getByRole('img', {
      name: `${goal}: Nov 9, 2026 to Nov 17, 2026, rolled up from its children`,
    }),
  ).toBeVisible();

  // One track, by the filter: the address holds it, and a fresh visit opens the same view. On a
  // phone the filters wait behind one button (D33).
  if (isMobile) await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.getByRole('combobox', { name: 'Track', exact: true }).selectOption(keys[1] as string);
  await expect(page).toHaveURL(new RegExp(`track=${keys[1]}`));
  await expect(page.getByRole('link', { name: site })).toHaveCount(0);
  await page.goto(`${BASE}/#/plans/${planId}/timeline?track=${keys[1]}`);
  await expect(
    page.getByRole('button', { name: `${servers}: Nov 5, 2026 to Nov 12, 2026` }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: goal })).toHaveCount(0);
  expect(await noSidewaysScroll(page)).toBe(true);
});
