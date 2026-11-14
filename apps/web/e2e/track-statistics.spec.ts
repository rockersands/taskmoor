import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, type TestInfo, test } from '@playwright/test';
import { uniqueKey, uniqueStamp } from './unique';

/**
 * A track's Summary and Statistics end to end (ADR-116; RPT-002, RPT-006), on a Kanban track of
 * this run's own: the track's administrator puts a report on the Summary and a member reads it
 * without the tools that change it; Statistics lists the time and workload reports and no sprint
 * ones, and its numbers are those the search API finds. No serious axe issue and no sideways
 * scroll, on a desktop and a phone. It uses the attachments database (preview 4174), whose
 * administrator (Ada Attach) the API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
// The member's password, made for this run (none is written in the repository), and free of
// their name and address, which the server refuses in a password.
const PASSWORD = `walnut-${randomBytes(18).toString('base64url')}`;

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

async function ok<T>(answer: ReturnType<APIRequestContext['post']>): Promise<T> {
  const res = await answer;
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as T;
}

async function signInAs(api: APIRequestContext, email: string, password: string) {
  await api.delete(`${BASE}/api/v1/session`);
  await ok(api.post(`${BASE}/api/v1/session`, { data: { email, password } }));
}

/** Opens a page afresh: after a change of who is signed in, a hash change would keep the old one. */
async function visit(page: Page, hash: string) {
  await page.goto('about:blank');
  await page.goto(`${BASE}/${hash}`);
}

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

/** The count of a search, as the search page would say it. */
async function searchCount(api: APIRequestContext, q: string) {
  const res = await api.get(`${BASE}/api/v1/search?q=${encodeURIComponent(q)}&count=true&limit=1`);
  expect(res.status()).toBe(200);
  return (await res.json()).total.count as number;
}

/**
 * A Kanban track of this run's own with four tickets: estimates of 2h and 3h and none, an hour
 * logged on one, one closed. Returns its key and id.
 */
async function newTrack(api: APIRequestContext, testInfo: TestInfo) {
  await signInAs(api, ADMIN.email, ADMIN.password as string);
  const key = uniqueKey('R', testInfo);
  const made = await ok<{ track: { id: number } }>(
    api.post(`${BASE}/api/v1/tracks`, { data: { key, name: `Reports ${key}`, mode: 'shared' } }),
  );
  const ticket = async (summary: string, extra: Record<string, unknown> = {}) =>
    (
      await ok<{ ticket: { id: number } }>(
        api.post(`${BASE}/api/v1/tickets`, { data: { track: key, summary, ...extra } }),
      )
    ).ticket.id;
  const first = await ticket('Plan the launch', {
    originalEstimate: 7200,
    remainingEstimate: 3600,
  });
  await ticket('Write the notes', { originalEstimate: 10_800, remainingEstimate: 10_800 });
  await ticket('Ask for feedback');
  const done = await ticket('Book the room', { originalEstimate: 1800 });
  await ok(
    api.post(`${BASE}/api/v1/tickets/${first}/time-entries`, {
      data: { duration: 3600, remainingEstimate: { mode: 'leave' } },
    }),
  );
  const offered = (await (await api.get(`${BASE}/api/v1/tickets/${done}/transitions`)).json())
    .transitions as { id: number; to: { stage: string } }[];
  await ok(
    api.post(`${BASE}/api/v1/tickets/${done}/transitions`, {
      data: { transitionId: offered.find((o) => o.to.stage === 'closed')?.id },
    }),
  );
  // The track's one board, Kanban as a new track's first board is.
  const board = await (await api.get(`${BASE}/api/v1/tracks/${key}/board`)).json();
  expect(board.board.kind).toBe('kanban');
  return { key, id: made.track.id };
}

/** A report of a track's Statistics: its link on a wide screen, the one Report picker on a phone (D5). */
async function openReport(page: Page, name: string): Promise<void> {
  const picker = page.getByRole('combobox', { name: 'Report' });
  if (await picker.isVisible()) await picker.selectOption({ label: name });
  else await page.getByRole('navigation', { name: 'Reports' }).getByRole('link', { name }).click();
}

test('[RPT-006] the track’s administrator puts a report on the Summary; a member reads it as it is', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const api = page.request;
  const { key, id } = await newTrack(api, testInfo);

  // The administrator customizes: today's numbers stay, and the workload joins them.
  await visit(page, `#/tracks/${key}`);
  // Titled by its section under the track's tab bar (D26).
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Summary');
  await expect(page.getByRole('navigation', { name: `Sections of ${key}` })).toBeVisible();
  await page.getByRole('button', { name: 'Customise' }).click();
  await page.getByRole('combobox', { name: 'Widget to add' }).selectOption({ label: 'Workload' });
  await page.getByRole('button', { name: 'Add widget' }).click();
  const form = page.getByRole('form', { name: /Workload/ });
  await expect(form.getByRole('checkbox', { name: 'Open tickets only' })).toBeChecked();
  await form.getByRole('button', { name: 'Apply' }).click();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await noSidewaysScroll(page);
  await page.getByRole('button', { name: 'Save the summary' }).click();
  await expect(page.getByRole('status')).toBeVisible();
  const workload = page.getByRole('article', { name: 'Workload' });
  // Open tickets: 1h and 3h left, one with no estimate; all unassigned.
  await expect(workload.getByRole('row', { name: /None/ }).first()).toContainText('4h');

  // A member of the track, made through the API, reads the same Summary and cannot change it.
  const stamp = uniqueStamp(testInfo);
  const email = `member.${stamp}@reports.test`.toLowerCase();
  const person = await ok<{ user: { id: number } }>(
    api.post(`${BASE}/api/v1/users`, {
      data: { email, name: `Member ${stamp}`, password: PASSWORD },
    }),
  );
  const roles = (await (await api.get(`${BASE}/api/v1/roles`)).json()).roles as {
    id: number;
    name: string;
  }[];
  const members = roles.find((r) => r.name === 'Members')?.id as number;
  const given = await api.put(
    `${BASE}/api/v1/tracks/${id}/roles/${members}/users/${person.user.id}`,
    {
      data: {},
    },
  );
  expect(given.ok(), await given.text()).toBe(true);
  await signInAs(api, email, PASSWORD);
  await visit(page, `#/tracks/${key}`);
  await expect(page.getByRole('article', { name: 'Workload' })).toBeVisible();
  await expect(
    page.getByRole('article', { name: 'Workload' }).getByRole('row', { name: /None/ }).first(),
  ).toContainText('4h');
  await expect(page.getByRole('button', { name: 'Customise' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Back to the default' })).toHaveCount(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await noSidewaysScroll(page);
});

test('[RPT-002] Statistics of a Kanban track: the time and ticket reports count what search finds', async ({
  page,
  isMobile,
}, testInfo) => {
  test.setTimeout(90_000);
  const api = page.request;
  const { key } = await newTrack(api, testInfo);

  await visit(page, `#/tracks/${key}/statistics/group-by`);
  if (isMobile) {
    // On a phone one Report picker stands for the grouped links (D5).
    const picker = page.getByRole('combobox', { name: 'Report' });
    await expect(picker).toHaveValue('group-by');
    await expect(picker.locator('optgroup[label="Time and workload"]')).toHaveCount(1);
    await expect(picker.locator('optgroup[label="Sprints"]')).toHaveCount(0);
  } else {
    const nav = page.getByRole('navigation', { name: 'Reports' });
    await expect(nav.getByRole('group', { name: 'Time and workload' })).toBeVisible();
    await expect(nav.getByRole('group', { name: 'Sprints' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Grouped tickets' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  }
  // Each status a group: their totals add up to the track, their done counts to the closed stage.
  const groups = page.getByRole('list', { name: 'Grouped tickets' });
  await expect(groups).toBeVisible();
  const shares = await groups.locator('.widget-group-head span').allTextContents();
  const pairs = shares.map((s) => /(\d+) of (\d+) done/.exec(s)?.slice(1).map(Number) ?? [0, 0]);
  expect(pairs.reduce((n, [, total]) => n + (total ?? 0), 0)).toBe(
    await searchCount(api, `track = ${key}`),
  );
  expect(pairs.reduce((n, [closed]) => n + (closed ?? 0), 0)).toBe(
    await searchCount(api, `track = ${key} AND stage = closed`),
  );
  expect(await seriousAxeViolations(page)).toEqual([]);
  await noSidewaysScroll(page);

  // Time tracking: 2h, 3h and half an hour estimated, an hour logged, 4.5h left (the closed
  // ticket keeps its half hour), so the work is on the estimate.
  await openReport(page, 'Time tracking');
  const totals = page.locator('dl.report-stats');
  await expect(totals.getByText('5.5h')).toBeVisible();
  await expect(totals.getByText('1h', { exact: true })).toBeVisible();
  await expect(totals.getByText('4.5h')).toBeVisible();
  await expect(totals.getByText('On the estimate')).toBeVisible();
  await expect(page.getByText('3 of 4 tickets have an original estimate.')).toBeVisible();
  // On a phone each ticket's link is a finger's target, 44px tall (ADR-033).
  if (testInfo.project.name === 'mobile') {
    const link = page.getByRole('region', { name: 'Time tracking' }).getByRole('link').first();
    expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  expect(await seriousAxeViolations(page)).toEqual([]);
  await noSidewaysScroll(page);

  // Workload by person: the open tickets' remaining estimate, as the search finds them.
  await openReport(page, 'Workload by person');
  const table = page.getByRole('region', { name: 'Workload by person' });
  const total = table.getByRole('row', { name: /Total/ });
  await expect(total).toContainText(
    String(await searchCount(api, `track = ${key} AND stage != closed`)),
  );
  await expect(total).toContainText('4h');
  expect(await seriousAxeViolations(page)).toEqual([]);
  await noSidewaysScroll(page);
});
