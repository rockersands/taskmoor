import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import { uniqueRun } from './unique';

/**
 * Multi-track dependencies end to end (T-089; PLN-006; ADR-122): a plan over two tracks, where
 * Design blocks Build (which starts the day before Design ends: late) and Servers in the other
 * track (on time), and Servers is also blocked by a ticket of a third track outside the plan. The
 * Timeline puts a badge on each blocked bar, red and saying "late" for Build; the list below says
 * the same in words and counts the outside blocker without naming it; moving Build a week later
 * clears it. No serious axe issue and no sideways page scroll, on a phone too. It uses the
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
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test('[PLN-006] a plan’s dependencies: badges, late in words, the list and a blocker outside', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const stamp = uniqueRun(testInfo);
  const keys = [`DA${stamp}`, `DB${stamp}`, `DC${stamp}`];
  const ids: number[] = [];
  for (const key of keys) {
    const track = await page.request.post(`${BASE}/api/v1/tracks`, {
      data: { key, name: `Team ${key}`, mode: 'shared' },
    });
    expect(track.status(), await track.text()).toBe(201);
    ids.push((await track.json()).track.id as number);
  }
  const make = async (track: string, data: Record<string, unknown>) => {
    const res = await page.request.post(`${BASE}/api/v1/tickets`, { data: { track, ...data } });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()).ticket.key as string;
  };
  const design = await make(keys[0] as string, {
    summary: 'Design the shop',
    startDate: '2026-11-02',
    dueDate: '2026-11-10',
  });
  const build = await make(keys[0] as string, {
    summary: 'Build the shop',
    startDate: '2026-11-09',
    dueDate: '2026-11-20',
  });
  const servers = await make(keys[1] as string, {
    summary: 'Scale the servers',
    startDate: '2026-11-12',
    dueDate: '2026-11-18',
  });
  const outside = await make(keys[2] as string, { summary: 'Order the hardware' });
  const types = await (await page.request.get(`${BASE}/api/v1/link-types`)).json();
  const blocks = (types.linkTypes as { id: number; outward: string }[]).find(
    (y) => y.outward === 'blocks',
  )?.id;
  for (const [blocker, blocked] of [
    [design, build],
    [design, servers],
    [outside, servers],
  ] as const) {
    const res = await page.request.post(`${BASE}/api/v1/tickets/${blocker}/links`, {
      data: { linkTypeId: blocks, ticket: blocked },
    });
    expect(res.status(), await res.text()).toBe(201);
  }
  const made = await page.request.post(`${BASE}/api/v1/plans`, {
    data: {
      name: `Deps ${stamp}`,
      sources: ids.slice(0, 2).map((trackId) => ({ kind: 'track', trackId })),
    },
  });
  expect(made.status(), await made.text()).toBe(201);
  const planId = (await made.json()).plan.id as number;

  await page.goto(`${BASE}/#/plans/${planId}/timeline`);

  // Build's badge is red and says "late"; the bar says the same to a screen reader.
  const buildBar = page.getByRole('button', { name: `${build}: Nov 9, 2026 to Nov 20, 2026` });
  await expect(buildBar).toHaveAccessibleDescription(/Blocked by 1 ticket, 1 late$/);
  const lateBadge = page.locator('.timeline-badge.is-late');
  await expect(lateBadge).toHaveCount(1);
  await expect(lateBadge).toHaveText(/1 · late/);
  await expect(
    page.getByRole('button', { name: `${servers}: Nov 12, 2026 to Nov 18, 2026` }),
  ).toHaveAccessibleDescription(/Blocked by 2 tickets$/);
  await expect(page.locator('.timeline-link.is-late')).toHaveCount(1);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // The list: reached at once from beside the zoom, the same in words.
  await page.getByRole('button', { name: 'List of dependencies' }).click();
  const list = page.getByRole('region', { name: 'Dependencies' });
  await expect(list.getByRole('heading', { name: 'Dependencies' })).toBeFocused();
  await expect(list).toContainText('2 tickets have blockers; 1 dependency is late.');
  await expect(list).toContainText(
    `${design} Design the shop Late: it ends Nov 10, 2026, but ${build} starts Nov 9, 2026.`,
  );
  await expect(list).toContainText(
    `${design} Design the shop On time: it ends Nov 10, 2026, before ${servers} starts Nov 12, 2026.`,
  );
  await expect(list.getByText('1 ticket outside this plan')).toBeVisible();
  // The blocker outside the plan is counted, never named.
  await expect(page.getByText(outside)).toHaveCount(0);
  await expect(page.getByText('Order the hardware')).toHaveCount(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // Build moved a week later starts after Design ends: nothing is late any more.
  await buildBar.focus();
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect(page.getByRole('status').filter({ hasText: build })).toHaveText(
    `${build} now runs from Nov 16, 2026 to Nov 27, 2026.`,
  );
  await expect(list).toContainText('2 tickets have blockers; none is late.');
  await expect(page.locator('.timeline-badge.is-late')).toHaveCount(0);
  await expect(page.locator('.timeline-link.is-late')).toHaveCount(0);
});
