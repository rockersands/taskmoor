import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/**
 * Teams and capacity in a Multi-track plan end to end (T-089b; PLN-005, PLN-009; ADR-122): a
 * plan over two tracks plans with a team of one person, in two-week periods from this week's
 * Monday, in points. The person has 8 points due in the plan this period and 13 in a third track outside
 * it. Their capacity is set from the Capacity view's dialog (10 points every period); the view
 * then says they are over capacity, in words, counts the work outside the plan without naming
 * it, and links their count to the search that finds exactly those tickets. No serious axe issue
 * and no sideways page scroll, on a phone too, where each row is a card. It uses the attachments
 * database (preview 4174), whose administrator (Ada Attach) the API server made.
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

async function ok<T>(answer: ReturnType<APIRequestContext['post']>): Promise<T> {
  const res = await answer;
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as T;
}

/** A calendar day `days` after today, in UTC as the page counts them. */
const dayFromToday = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
/**
 * This week's Monday. Periods from it hold the next three days, and the whole week of each,
 * whatever day today is: work elsewhere counts by whole weeks, Monday to Sunday.
 */
const thisMonday = () => dayFromToday(-((new Date().getUTCDay() + 6) % 7));

test('[PLN-005] [PLN-009] a plan’s capacity: a team’s person over capacity in words, work elsewhere only counted', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const api = page.request;
  expect((await api.post(`${BASE}/api/v1/session`, { data: ADMIN })).status()).toBe(200);
  const run = `${testInfo.project.name.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-5)}`;
  const name = `Cap ${run}`;
  const person = (
    await ok<{ user: { id: number } }>(
      api.post(`${BASE}/api/v1/users`, {
        data: { email: `cap-${run}@capacity.test`.toLowerCase(), name },
      }),
    )
  ).user.id;
  const roles = (await (await api.get(`${BASE}/api/v1/roles`)).json()).roles as {
    id: number;
    name: string;
  }[];
  const members = roles.find((r) => r.name === 'Members')?.id;
  const keys = [`CA${run}`, `CB${run}`, `CC${run}`];
  const tracks: number[] = [];
  for (const key of keys) {
    const id = (
      await ok<{ track: { id: number } }>(
        api.post(`${BASE}/api/v1/tracks`, { data: { key, name: `Track ${key}`, mode: 'shared' } }),
      )
    ).track.id;
    tracks.push(id);
    const joined = await api.put(`${BASE}/api/v1/tracks/${id}/roles/${members}/users/${person}`);
    expect(joined.status(), await joined.text()).toBeLessThan(300);
  }
  const team = (
    await ok<{ team: { id: number } }>(
      api.post(`${BASE}/api/v1/teams`, { data: { name: `Crew ${run}` } }),
    )
  ).team.id;
  expect((await api.put(`${BASE}/api/v1/teams/${team}/members/${person}`)).status()).toBe(204);
  const planId = (
    await ok<{ plan: { id: number } }>(
      api.post(`${BASE}/api/v1/plans`, {
        data: {
          name: `Capacity ${run}`,
          sources: tracks.slice(0, 2).map((trackId) => ({ kind: 'track', trackId })),
        },
      }),
    )
  ).plan.id;
  const set = await api.patch(`${BASE}/api/v1/plans/${planId}`, {
    data: {
      teams: [team],
      capacityUnit: 'points',
      period: { kind: 'weeks', weeks: 2, anchor: thisMonday() },
    },
  });
  expect(set.status(), await set.text()).toBe(200);
  const points = (await (await api.get(`${BASE}/api/v1/plans/${planId}/capacity?periods=1`)).json())
    .pointsField?.id as number;
  expect(points).toBeGreaterThan(0);
  const make = async (track: string, data: Record<string, unknown>) =>
    (
      await ok<{ ticket: { key: string } }>(
        api.post(`${BASE}/api/v1/tickets`, { data: { track, ...data } }),
      )
    ).ticket.key;
  await make(keys[0] as string, {
    summary: 'Build the shop page',
    assigneeId: person,
    dueDate: dayFromToday(1),
    fields: { [points]: 5 },
  });
  await make(keys[1] as string, {
    summary: 'Run the invoices',
    assigneeId: person,
    dueDate: dayFromToday(3),
    fields: { [points]: 3 },
  });
  const outside = await make(keys[2] as string, {
    summary: 'Order the hardware',
    assigneeId: person,
    dueDate: dayFromToday(2),
    fields: { [points]: 13 },
  });

  await page.goto(`${BASE}/#/plans/${planId}/capacity`);
  const mobile = testInfo.project.name === 'mobile';
  const view = mobile
    ? page.getByRole('list', { name: 'Capacity by period' })
    : page.getByRole('region', { name: 'Capacity by period' });
  await expect(view).toBeVisible();
  if (mobile) {
    await expect(view.getByRole('heading', { name, level: 3 })).toBeVisible();
  }
  await expect(view.getByText('No capacity set').first()).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // The person's capacity, from the dialog: 10 points every period.
  await page.getByRole('button', { name: `Set capacity of ${name}` }).click();
  const dialog = page.getByRole('dialog', { name: `Capacity of ${name}` });
  await expect(dialog.getByLabel('Capacity for every period')).toBeFocused();
  await page.keyboard.type('10');
  expect(await seriousAxeViolations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Save capacity' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`Capacity of ${name} saved.`)).toBeVisible();

  // 8 points here and 13 elsewhere against 10: over, in words, for the person and the team,
  // whose capacity is its member's.
  await expect(view.getByText('21 of 10 points')).toHaveCount(2);
  await expect(view.getByText('Over capacity by 11 points')).toHaveCount(2);
  await expect(view.getByText('+13 points in 1 ticket elsewhere')).toHaveCount(2);
  await expect(view.getByText('Its members’ capacity').first()).toBeVisible();
  // The work outside the plan is counted, never named.
  await expect(page.getByText(outside)).toHaveCount(0);
  await expect(page.getByText('Order the hardware')).toHaveCount(0);

  // The person's count is the count of the search it links to.
  const link = view.getByRole('link', {
    name: new RegExp(`^2 tickets for ${name}, .*: open the search$`),
  });
  await expect(link).toHaveCount(1);
  const href = (await link.getAttribute('href')) ?? '';
  const q = new URLSearchParams(href.split('?')[1]).get('q');
  const found = await ok<{ total: { count: number } }>(
    api.post(`${BASE}/api/v1/search`, { data: { q, count: true, limit: 1 } }),
  );
  expect(found.total.count).toBe(2);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
});
