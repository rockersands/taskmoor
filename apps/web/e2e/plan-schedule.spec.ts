import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, type TestInfo, test } from '@playwright/test';
import { uniqueRun } from './unique';

/**
 * The auto-scheduler end to end (T-089f; PLN-004, PLN-002; ADR-122 stage 7): a plan over one
 * track, SK, in one-week periods from this week's Monday, in points, with one team, Crew, whose
 * capacity is 10 points every period. Its four open tickets are all assigned to the plan's owner,
 * a member of Crew, and have no days: Write the brief, Build the page and Ship the page, of 5
 * points each in that rank order, and Size this later, with no estimate. The owner runs
 * Auto-schedule from the scenario bar into a new scenario, Proposal, which becomes main: the
 * result opens on the Changes tab with Size this later not placed for want of an estimate, and
 * the first two placed in this week and the third in the next. On the Timeline the three bars
 * say "Draft, auto-scheduled". The owner moves Write the brief (Alt and an arrow on a desktop, the
 * side panel on a phone), runs again into Proposal and sees it kept as their draft, compares
 * Proposal with Live and applies the three: the tickets' days change. A person the plan is shared
 * with sees no Auto-schedule and is refused a run. No serious axe issue and no sideways page
 * scroll. It uses the attachments database (preview 4174), whose administrator (Ada Attach) the
 * API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
// Made for this run: no password is written in the repository.
const PASSWORD = `${randomBytes(18).toString('hex')}-Zy7`;

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

/** A calendar day `days` after `from`. */
const plus = (from: string, days: number) =>
  new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/**
 * Today as the page reckons it: the browser's own day, in this machine's time zone, which the
 * dialog sends as the run's first day.
 */
const localToday = () => {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
};

interface Fixture {
  run: string;
  plan: number;
  team: string;
  today: string;
  monday: string;
  keys: { brief: string; build: string; ship: string; size: string };
  owner: { email: string };
  viewer: { email: string };
}

async function signInAs(api: APIRequestContext, email: string) {
  await api.delete(`${BASE}/api/v1/session`);
  await ok(api.post(`${BASE}/api/v1/session`, { data: { email, password: PASSWORD } }));
}

/** The plan, its track, team, capacity and tickets; its owner and a person it is shared with. */
async function fixture(api: APIRequestContext, testInfo: TestInfo): Promise<Fixture> {
  await ok(api.post(`${BASE}/api/v1/session`, { data: ADMIN }));
  // Two letters and this run's eight: a track key of ten, never one an earlier run used (T-244).
  const run = uniqueRun(testInfo);
  const user = async (who: string) => {
    const email = `${who}-${run}@schedule.test`.toLowerCase();
    const id = (
      await ok<{ user: { id: number } }>(
        api.post(`${BASE}/api/v1/users`, {
          data: {
            email,
            name: `${who[0]?.toUpperCase()}${who.slice(1)} ${run}`,
            password: PASSWORD,
          },
        }),
      )
    ).user.id;
    return { id, email };
  };
  const owner = await user('planner');
  const viewer = await user('viewer');
  const roles = (await (await api.get(`${BASE}/api/v1/roles`)).json()).roles as {
    id: number;
    name: string;
  }[];
  const members = roles.find((r) => r.name === 'Members')?.id;
  const key = `SK${run}`;
  const track = (
    await ok<{ track: { id: number } }>(
      api.post(`${BASE}/api/v1/tracks`, { data: { key, name: `Plan ${key}`, mode: 'shared' } }),
    )
  ).track.id;
  for (const person of [owner.id, viewer.id]) {
    const res = await api.put(`${BASE}/api/v1/tracks/${track}/roles/${members}/users/${person}`);
    expect(res.status(), await res.text()).toBeLessThan(300);
  }
  const team = `Crew ${run}`;
  const crew = (
    await ok<{ team: { id: number } }>(api.post(`${BASE}/api/v1/teams`, { data: { name: team } }))
  ).team.id;
  expect((await api.put(`${BASE}/api/v1/teams/${crew}/members/${owner.id}`)).status()).toBe(204);

  // The owner makes the plan, so they may run it; the person it is shared with only sees it.
  await signInAs(api, owner.email);
  const today = localToday();
  const monday = plus(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const plan = (
    await ok<{ plan: { id: number } }>(
      api.post(`${BASE}/api/v1/plans`, {
        data: {
          name: `Schedule ${run}`,
          sources: [{ kind: 'track', trackId: track }],
          shares: [{ scope: 'user', userId: viewer.id }],
        },
      }),
    )
  ).plan.id;
  const planned = await api.patch(`${BASE}/api/v1/plans/${plan}`, {
    data: {
      teams: [crew],
      capacityUnit: 'points',
      period: { kind: 'weeks', weeks: 1, anchor: monday },
    },
  });
  expect(planned.status(), await planned.text()).toBe(200);
  const capacity = await api.put(`${BASE}/api/v1/plans/${plan}/capacity`, {
    data: { entries: [{ teamId: crew, period: null, amount: 10 }], unit: 'points' },
  });
  expect(capacity.status(), await capacity.text()).toBeLessThan(300);
  const points = (await (await api.get(`${BASE}/api/v1/plans/${plan}/capacity?periods=1`)).json())
    .pointsField?.id as number;
  expect(points).toBeGreaterThan(0);
  const ticket = async (summary: string, estimate?: number) =>
    (
      await ok<{ ticket: { key: string } }>(
        api.post(`${BASE}/api/v1/tickets`, {
          data: {
            track: key,
            summary,
            assigneeId: owner.id,
            ...(estimate === undefined ? {} : { fields: { [points]: estimate } }),
          },
        }),
      )
    ).ticket.key;
  const brief = await ticket('Write the brief', 5);
  const build = await ticket('Build the page', 5);
  const ship = await ticket('Ship the page', 5);
  const size = await ticket('Size this later');
  return {
    run,
    plan,
    team,
    today,
    monday,
    keys: { brief, build, ship, size },
    owner: { email: owner.email },
    viewer: { email: viewer.email },
  };
}

const daysOf = async (api: APIRequestContext, key: string) => {
  const { ticket } = await ok<{ ticket: { startDate: string | null; dueDate: string | null } }>(
    api.get(`${BASE}/api/v1/tickets/${encodeURIComponent(key)}`),
  );
  return { start: ticket.startDate, due: ticket.dueDate };
};

/** The result panel's list for one filter, after choosing that filter. */
async function shown(page: Page, label: string) {
  const panel = page.getByRole('region', { name: 'Auto-schedule' });
  await panel.getByRole('button', { name: label }).click();
  await expect(panel.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
  return panel.getByRole('list', { name: `Tickets ${label}` });
}

test('[PLN-004] [PLN-002] auto-schedules a plan into a new scenario, says why, plans around a person’s draft and applies; a viewer cannot run it', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const mobile = testInfo.project.name === 'mobile';
  const f = await fixture(page.request, testInfo);
  await signInAs(page.request, f.owner.email);
  await page.goto(`${BASE}/#/plans/${f.plan}/timeline`);
  await expect(page.getByText('Changes you make here change tickets now.')).toBeVisible();

  // The dialog reads readiness first: the team with capacity, the unit, the ticket without a size.
  await page.getByRole('button', { name: 'Auto-schedule…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Auto-schedule' });
  await expect(dialog.getByText(`${f.team} has capacity.`)).toBeVisible();
  await expect(dialog.getByText(/^Capacity is in points, from the field /)).toBeVisible();
  await expect(
    dialog.getByText('The plan shows you 4 open tickets.', { exact: false }),
  ).toBeVisible();
  await expect(dialog.getByText('These will not be placed: 1 without an estimate.')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'A new scenario' })).toBeChecked();
  await expect(
    dialog.getByText('The plan has no scenario yet, so this one becomes its main scenario.'),
  ).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Keep tickets in progress' })).toBeChecked();
  // The first day is the person's today. The run is held to the fixture's day, so a test that
  // crosses midnight still plans the weeks its checks expect.
  await expect(dialog.getByLabel('Schedule from')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await dialog.getByLabel('Schedule from').fill(f.today);
  await expect(dialog.getByRole('combobox', { name: 'Look ahead' })).toHaveValue('6');
  await dialog.getByLabel('Name').fill('Proposal');
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await dialog.getByRole('button', { name: 'Run' }).click();

  // The Changes tab of Proposal, with the result on top: the ticket not placed first, with why.
  await expect(page).toHaveURL(new RegExp(`#/plans/${f.plan}/changes\\?(.*&)?scenario=\\d+`));
  const scenario = Number(/scenario=(\d+)/.exec(page.url())?.[1]);
  await expect(dialog).toHaveCount(0);
  const panel = page.getByRole('region', { name: 'Auto-schedule' });
  await expect(panel.getByRole('heading', { name: 'Auto-schedule' })).toBeFocused();
  await expect(
    panel.getByText('3 placed, 0 kept, 1 not placed, 0 earlier proposals removed.'),
  ).toBeVisible();
  await expect(panel.getByText('Into Proposal, a new scenario.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Not placed (1)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const notPlaced = panel.getByRole('list', { name: 'Tickets Not placed (1)' });
  await expect(notPlaced.getByRole('listitem')).toHaveCount(1);
  await expect(notPlaced.getByRole('link', { name: new RegExp(`^${f.keys.size}`) })).toBeVisible();
  await expect(notPlaced.getByText('Not placed: no estimate.')).toBeVisible();
  const placed = await shown(page, 'Placed (3)');
  for (const key of [f.keys.brief, f.keys.build, f.keys.ship]) {
    const row = placed.getByRole('listitem').filter({ hasText: key });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/Placed (in|from) /);
  }
  // The change list says who proposed each draft, and why.
  await expect(page.getByText('Proposed by the auto-scheduler')).toHaveCount(3);
  await expect(page.getByText(/^Why: Placed /).first()).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  // Nothing changed yet.
  expect(await daysOf(page.request, f.keys.brief)).toEqual({ start: null, due: null });

  // The Timeline in Proposal: three bars drafted by the auto-scheduler, said in words.
  await page.goto(`${BASE}/#/plans/${f.plan}/timeline?scenario=${scenario}`);
  await expect(page.getByText(/^Drafting in Proposal: /)).toBeVisible();
  await expect(page.getByText('Draft, auto-scheduled', { exact: true })).toHaveCount(3);
  const autoBar = (key: string) =>
    page.getByRole('button', { name: new RegExp(`^${key}, draft, auto-scheduled: `) });
  for (const key of [f.keys.brief, f.keys.build, f.keys.ship]) {
    await expect(autoBar(key)).toBeVisible();
  }
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // The owner moves Write the brief: their draft now. Its due day falls in next week.
  let brief: { start: string; due: string };
  if (mobile) {
    await autoBar(f.keys.brief).click();
    const side = page.getByRole('complementary', { name: `Days of ${f.keys.brief}` });
    await side.getByLabel('Due date').fill(plus(f.monday, 7));
    await side.getByRole('button', { name: 'Save draft' }).click();
    brief = { start: f.today, due: plus(f.monday, 7) };
  } else {
    await autoBar(f.keys.brief).focus();
    await page.keyboard.press('Alt+ArrowRight');
    brief = { start: plus(f.today, 1), due: plus(f.monday, 7) };
    await expect(
      page.getByRole('button', { name: new RegExp(`^${f.keys.brief}, draft: `) }),
    ).toBeVisible();
  }
  await expect(page.getByRole('status').filter({ hasText: 'Your draft now' })).toContainText(
    `Draft: ${f.keys.brief} `,
  );

  // Run again into Proposal: Write the brief is kept where the owner put it, and planned around.
  await page.getByRole('button', { name: 'Auto-schedule…' }).click();
  await dialog.getByRole('radio', { name: 'This scenario: Proposal' }).check();
  await dialog.getByLabel('Schedule from').fill(f.today);
  await expect(dialog.getByText(/^Re-running replaces the auto-scheduler’s /)).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await dialog.getByRole('button', { name: 'Run' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(
    new RegExp(`#/plans/${f.plan}/changes\\?(.*&)?scenario=${scenario}`),
  );
  await expect(panel.getByRole('heading', { name: 'Auto-schedule' })).toBeFocused();
  await expect(panel.getByText(/^2 placed, 1 kept, 1 not placed, /)).toBeVisible();
  await expect(panel.getByText('1 draft a person made stays.', { exact: false })).toBeVisible();
  await expect(panel.getByText('Into Proposal.')).toBeVisible();
  const kept = await shown(page, 'Kept (1)');
  await expect(kept.getByRole('listitem').filter({ hasText: f.keys.brief })).toContainText(
    'Kept: a person drafted its days in this scenario.',
  );
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // Proposal is main, so the result compares it with Live.
  await panel.getByRole('link', { name: 'Compare with Live' }).click();
  await expect(page).toHaveURL(new RegExp(`#/plans/${f.plan}/scenarios\\?`));
  await expect(page.getByText('Ends only in Proposal').first()).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);

  // Apply the three: their days change to the run's, and to the owner's for Write the brief.
  await page.goto(`${BASE}/#/plans/${f.plan}/changes?scenario=${scenario}`);
  await expect(
    page.getByRole('heading', { name: 'Changes in Proposal, the main scenario' }),
  ).toBeVisible();
  for (const key of [f.keys.brief, f.keys.build, f.keys.ship]) {
    await page.getByRole('checkbox', { name: `Select ${key}` }).check();
  }
  if (mobile) {
    const bar = page.getByRole('group', { name: 'Chosen changes' });
    await bar.getByRole('button', { name: 'Apply 3 changes' }).click();
    await bar.getByRole('button', { name: 'Apply 3 changes' }).click();
  } else {
    await page.getByRole('button', { name: 'Apply 3 changes' }).click();
    await page
      .getByRole('group', { name: 'Change 3 tickets as you, with your permissions?' })
      .getByRole('button', { name: 'Apply 3 changes' })
      .click();
  }
  await expect(page.getByRole('heading', { name: '3 applied, 0 refused' })).toBeFocused();
  expect(await daysOf(page.request, f.keys.brief)).toEqual(brief);
  // With Write the brief due next week, both others fit this week.
  const thisWeek = { start: f.today, due: plus(f.monday, 6) };
  expect(await daysOf(page.request, f.keys.build)).toEqual(thisWeek);
  expect(await daysOf(page.request, f.keys.ship)).toEqual(thisWeek);
  expect(await daysOf(page.request, f.keys.size)).toEqual({ start: null, due: null });
  expect(await noSidewaysScroll(page)).toBe(true);

  // A person the plan is shared with sees it, but no Auto-schedule, and a run is refused.
  await signInAs(page.request, f.viewer.email);
  await page.goto(`${BASE}/#/plans/${f.plan}/scenarios`);
  await page.reload();
  await expect(page.getByRole('heading', { name: `Schedule ${f.run}`, level: 1 })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Scenario' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Proposal · Main', level: 3 })).toBeVisible();
  await expect(
    page.getByText(
      'Only the plan’s owner and site administrators can make, change or apply scenarios.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Auto-schedule…' })).toHaveCount(0);
  await page.goto(`${BASE}/#/plans/${f.plan}/timeline?scenario=${scenario}`);
  await expect(
    page.getByText('Viewing Proposal. Only the plan’s owner and site administrators can draft.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Auto-schedule…' })).toHaveCount(0);
  const readiness = await ok<{ editable: boolean }>(
    page.request.get(`${BASE}/api/v1/plans/${f.plan}/schedule`),
  );
  expect(readiness.editable).toBe(false);
  const refused = await page.request.post(`${BASE}/api/v1/plans/${f.plan}/schedule`, {
    data: { into: { scenarioId: scenario } },
  });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ error: 'forbidden', permission: 'edit_plan' });
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
});
