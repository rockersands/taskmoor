import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * The timeline end to end (M1-048; AGL-015): on a track of its own, an outcome with two dated
 * features; the outcome's bar is rolled up from them; a feature's bar dragged a week later
 * moves its start and due dates (on a phone, its side panel changes them), and the outcome's
 * roll-up follows. No serious axe issue and no sideways page scroll, on a phone too. It uses the
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

test('[AGL-015] a bar dragged a week later moves the ticket’s dates', async ({
  page,
  isMobile,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const key = `L${testInfo.project.name.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const track = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Launch ${key}`, mode: 'shared' },
  });
  expect(track.status(), await track.text()).toBe(201);
  const trackId = (await track.json()).track.id as number;
  const types = await (
    await page.request.get(`${BASE}/api/v1/tracks/${trackId}/ticket-types`)
  ).json();
  const typeId = (name: string) =>
    (types.ticketTypes as { id: number; name: string }[]).find((y) => y.name === name)?.id;
  const make = async (data: Record<string, unknown>) => {
    const res = await page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: key, ...data },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()).ticket.key as string;
  };
  const goal = await make({ summary: 'Launch day', ticketTypeId: typeId('Outcome') });
  const site = await make({
    summary: 'Build the site',
    ticketTypeId: typeId('Feature'),
    parent: goal,
    startDate: '2026-11-02',
    dueDate: '2026-11-10',
  });
  await make({
    summary: 'Press kit',
    ticketTypeId: typeId('Feature'),
    parent: goal,
    startDate: '2026-11-05',
    dueDate: '2026-11-12',
  });

  await page.goto(`${BASE}/#/tracks/${key}`);
  await page.getByRole('link', { name: 'Timeline', exact: true }).click();
  const timeline = page.getByRole('region', { name: 'Timeline', exact: true });
  await expect(
    timeline.getByRole('img', {
      name: `${goal}: Nov 2, 2026 to Nov 12, 2026, rolled up from its children`,
    }),
  ).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const bar = timeline.getByRole('button', { name: `${site}: Nov 2, 2026 to Nov 10, 2026` });
  if (isMobile) {
    await bar.click();
    const panel = timeline.getByRole('complementary', { name: `Days of ${site}` });
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
  await expect(timeline.getByRole('status')).toHaveText(
    `${site} now runs from Nov 9, 2026 to Nov 17, 2026.`,
  );
  const saved = await (await page.request.get(`${BASE}/api/v1/tickets/${site}`)).json();
  expect([saved.ticket.startDate, saved.ticket.dueDate]).toEqual(['2026-11-09', '2026-11-17']);
  await expect(
    timeline.getByRole('img', {
      name: `${goal}: Nov 5, 2026 to Nov 17, 2026, rolled up from its children`,
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
