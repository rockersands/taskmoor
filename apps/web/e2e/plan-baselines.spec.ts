import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, type TestInfo, test } from '@playwright/test';
import { uniqueRun } from './unique';

/**
 * Baselines, the critical path and evening out load end to end (T-089a; PLN-011; ADR-122 stage
 * 9): a plan over one track, BL, in one-week periods from this week's Monday, in points, with one
 * team, Crew, whose capacity is 10 points every period. Its four tickets are assigned to the plan's
 * owner, a member of Crew: Design the release (next week, 5 points) blocks Build the release (the
 * week after, 5 points), which blocks Ship the release (the third week, its first four days, 3
 * points), each starting the day after its blocker ends; Write the notes (6 points, the first
 * three days of the second week) has no dependency. So the second week holds 11 points, one over.
 *
 * On the Timeline the owner turns on Critical path: the chain's three bars say "On the critical
 * path", Write the notes says "8 days of slack", and the list says the chain in words. They
 * capture a baseline, Kick-off, from Live, then in a new scenario, Later, move Ship the release's
 * due day a week later (Alt, Shift and an arrow on a desktop, the side panel on a phone). The
 * Baselines tab compared with Later says Ship the release ends 7 days later and so does the plan.
 * Auto-schedule… with Even out load into Later moves Write the notes to the third week, keeps the
 * owner's draft on Ship the release where it is, and leaves no period over capacity; no ticket
 * changes. No serious axe issue and no sideways page scroll. It uses the attachments database
 * (preview 4174), whose administrator (Ada Attach) the API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
// Made for this run: no password is written in the repository.
const PASSWORD = `${randomBytes(18).toString('hex')}-Bq4`;

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
/** Today as the page reckons it: the browser's own day, in this machine's time zone. */
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
  /** The Monday of the week `n` weeks from this one. */
  week: (n: number) => string;
  keys: { design: string; build: string; ship: string; notes: string };
  owner: { email: string };
}

async function signInAs(api: APIRequestContext, email: string) {
  await api.delete(`${BASE}/api/v1/session`);
  await ok(api.post(`${BASE}/api/v1/session`, { data: { email, password: PASSWORD } }));
}

/** The plan, its track, team, capacity, tickets and their dependencies; its owner. */
async function fixture(api: APIRequestContext, testInfo: TestInfo): Promise<Fixture> {
  await ok(api.post(`${BASE}/api/v1/session`, { data: ADMIN }));
  // Two letters and this run's eight: a track key of ten, never one an earlier run used (T-244).
  const run = uniqueRun(testInfo);
  const email = `planner-${run}@baselines.test`.toLowerCase();
  const owner = (
    await ok<{ user: { id: number } }>(
      api.post(`${BASE}/api/v1/users`, {
        data: { email, name: `Planner ${run}`, password: PASSWORD },
      }),
    )
  ).user.id;
  const roles = (await (await api.get(`${BASE}/api/v1/roles`)).json()).roles as {
    id: number;
    name: string;
  }[];
  const members = roles.find((r) => r.name === 'Members')?.id;
  const key = `BL${run}`;
  const track = (
    await ok<{ track: { id: number } }>(
      api.post(`${BASE}/api/v1/tracks`, { data: { key, name: `Plan ${key}`, mode: 'shared' } }),
    )
  ).track.id;
  const member = await api.put(`${BASE}/api/v1/tracks/${track}/roles/${members}/users/${owner}`);
  expect(member.status(), await member.text()).toBeLessThan(300);
  const team = `Crew ${run}`;
  const crew = (
    await ok<{ team: { id: number } }>(api.post(`${BASE}/api/v1/teams`, { data: { name: team } }))
  ).team.id;
  expect((await api.put(`${BASE}/api/v1/teams/${crew}/members/${owner}`)).status()).toBe(204);

  // The owner makes the plan, so they may capture baselines and run the auto-scheduler.
  await signInAs(api, email);
  const today = localToday();
  const monday = plus(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const week = (n: number) => plus(monday, 7 * n);
  const plan = (
    await ok<{ plan: { id: number } }>(
      api.post(`${BASE}/api/v1/plans`, {
        data: { name: `Baselines ${run}`, sources: [{ kind: 'track', trackId: track }] },
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
  const ticket = async (summary: string, estimate: number, startDate: string, dueDate: string) =>
    (
      await ok<{ ticket: { key: string } }>(
        api.post(`${BASE}/api/v1/tickets`, {
          data: {
            track: key,
            summary,
            assigneeId: owner,
            startDate,
            dueDate,
            fields: { [points]: estimate },
          },
        }),
      )
    ).ticket.key;
  // In rank order: Write the notes, made last, is ranked lowest.
  const design = await ticket('Design the release', 5, week(1), plus(week(1), 6));
  const build = await ticket('Build the release', 5, week(2), plus(week(2), 6));
  const ship = await ticket('Ship the release', 3, week(3), plus(week(3), 3));
  const notes = await ticket('Write the notes', 6, week(2), plus(week(2), 2));
  const types = await (await api.get(`${BASE}/api/v1/link-types`)).json();
  const blocks = (types.linkTypes as { id: number; outward: string }[]).find(
    (y) => y.outward === 'blocks',
  )?.id;
  for (const [blocker, blocked] of [
    [design, build],
    [build, ship],
  ] as const) {
    const res = await api.post(`${BASE}/api/v1/tickets/${blocker}/links`, {
      data: { linkTypeId: blocks, ticket: blocked },
    });
    expect(res.status(), await res.text()).toBe(201);
  }
  return {
    run,
    plan,
    team,
    today,
    week,
    keys: { design, build, ship, notes },
    owner: { email },
  };
}

const daysOf = async (api: APIRequestContext, key: string) => {
  const { ticket } = await ok<{ ticket: { startDate: string | null; dueDate: string | null } }>(
    api.get(`${BASE}/api/v1/tickets/${encodeURIComponent(key)}`),
  );
  return { start: ticket.startDate, due: ticket.dueDate };
};

/** A ticket's bar on the Timeline, live (`KEY: …`) or drafted (`KEY, draft…: …`). */
const barOf = (page: Page, key: string, draft = '') =>
  page.getByRole('button', { name: new RegExp(`^${key}${draft}: `) });

test('[PLN-011] captures a baseline and compares it after a ticket moves later, shows the critical path in words, and evens out load into a scenario', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const mobile = testInfo.project.name === 'mobile';
  const f = await fixture(page.request, testInfo);
  await signInAs(page.request, f.owner.email);
  const { design, build, ship, notes } = f.keys;

  // The critical path on the Timeline, live: the chain marked on its bars, the rest with slack.
  await page.goto(`${BASE}/#/plans/${f.plan}/timeline`);
  await expect(page.getByText('Changes you make here change tickets now.')).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Critical path', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/[?&]critical=1/);
  for (const key of [design, build, ship]) {
    await expect(barOf(page, key)).toHaveAccessibleDescription(/On the critical path/);
  }
  await expect(barOf(page, notes)).toHaveAccessibleDescription(/8 days of slack/);
  await expect(page.locator('.timeline-bar.is-critical')).toHaveCount(3);

  // The path in words, reached from beside the zoom: one chain, from its first ticket to the end.
  await page.getByRole('button', { name: 'Critical path in words' }).click();
  const path = page.getByRole('region', { name: 'Critical path' });
  await expect(path.getByRole('heading', { name: 'Critical path' })).toBeFocused();
  await expect(path).toContainText('3 tickets are on the critical path. The plan ends ');
  await expect(path).toContainText(
    'It covers the tickets this plan shows you, whatever the filters',
  );
  await expect(path.getByText('Chain 1', { exact: true })).toBeVisible();
  await expect(path.getByText('Chain 2', { exact: true })).toHaveCount(0);
  const steps = path.locator('.critical-steps > li');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText(new RegExp(`^${design} Design the release starts `));
  await expect(steps.nth(1)).toContainText(new RegExp(`^${build} Build the release then starts `));
  await expect(steps.nth(2)).toContainText(new RegExp(`^${ship} Ship the release then starts `));
  await expect(steps.nth(2)).toContainText('the plan’s end.');
  await expect(path.getByText(notes)).toHaveCount(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // A baseline, Kick-off, captured from Live: every ticket of the plan.
  await page.goto(`${BASE}/#/plans/${f.plan}/baselines`);
  await expect(page.getByRole('heading', { name: 'Baselines', level: 2 })).toBeVisible();
  await expect(page.getByText('No baselines yet')).toBeVisible();
  await page.getByRole('button', { name: 'Capture baseline…' }).click();
  const capture = page.getByRole('dialog', { name: 'Capture baseline' });
  await expect(capture.getByText(/What the Timeline shows now: Live$/)).toBeVisible();
  await expect(capture.getByLabel('Name')).toHaveValue(/^Baseline /);
  await capture.getByLabel('Name').fill('Kick-off');
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await capture.getByRole('button', { name: 'Capture' }).click();
  await expect(capture).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Kick-off' })).toHaveText(
    'Kick-off is captured: 4 tickets.',
  );
  const item = page.getByRole('listitem').filter({
    has: page.getByRole('heading', { name: 'Kick-off', level: 3 }),
  });
  await expect(item).toContainText('From Live · 4 tickets');

  // Compared with the days now, live: nothing moved yet.
  await item.getByRole('link', { name: 'Compare with Kick-off' }).click();
  await expect(page).toHaveURL(new RegExp(`#/plans/${f.plan}/baselines\\?(.*&)?baseline=\\d+`));
  const baseline = Number(/baseline=(\d+)/.exec(page.url())?.[1]);
  const compared = page.getByRole('region', { name: 'Compared with Kick-off' });
  await expect(compared.getByRole('heading', { name: 'Compared with Kick-off' })).toBeFocused();
  await expect(
    compared.getByText(
      /^No ticket ends later than in Kick-off; 0 earlier; 4 the same\. The plan ends the same day /,
    ),
  ).toBeVisible();
  await expect(compared.getByText('No tickets here')).toBeVisible();

  // In a new scenario, Later, Ship the release's due day moves a week later: a draft.
  await page.goto(`${BASE}/#/plans/${f.plan}/timeline`);
  await page.getByRole('combobox', { name: 'Scenario' }).selectOption({ label: 'New scenario…' });
  const made = page.getByRole('dialog', { name: 'New scenario' });
  await made.getByLabel('Name').fill('Later');
  await made.getByRole('button', { name: 'Make scenario' }).click();
  await expect(page).toHaveURL(/scenario=\d+/);
  await expect(page.getByText(/^Drafting in Later: /)).toBeVisible();
  const scenario = Number(/scenario=(\d+)/.exec(page.url())?.[1]);
  if (mobile) {
    await barOf(page, ship).click();
    const side = page.getByRole('complementary', { name: `Days of ${ship}` });
    await side.getByLabel('Due date').fill(plus(f.week(4), 3));
    await side.getByRole('button', { name: 'Save draft' }).click();
  } else {
    await barOf(page, ship).focus();
    await page.keyboard.press('Alt+Shift+ArrowRight');
  }
  await expect(
    page.getByText(new RegExp(`^Draft: ${ship} .* in Later\\. Nothing changed yet\\.$`)),
  ).toBeVisible();
  await expect(barOf(page, ship, ', draft')).toBeVisible();
  expect((await daysOf(page.request, ship)).due).toBe(plus(f.week(3), 3));

  // Kick-off compared with Later: Ship the release ends 7 days later, and so does the plan.
  await page.goto(`${BASE}/#/plans/${f.plan}/baselines?scenario=${scenario}&baseline=${baseline}`);
  await page.reload();
  await expect(compared.getByText('The days now: Later, drafts not applied.')).toBeVisible();
  await expect(
    compared.getByText(
      /^1 ticket ends later than in Kick-off, by 7 days; 0 earlier; 3 the same\. The plan ends 7 days later \(/,
    ),
  ).toBeVisible();
  const later = compared.getByRole('button', { name: 'Later (1)' });
  await expect(later).toHaveAttribute('aria-pressed', 'true');
  const slipped = compared.getByRole('list', { name: 'Tickets: Later (1)' });
  await expect(slipped.getByRole('listitem')).toHaveCount(1);
  const row = slipped.getByRole('listitem').filter({ hasText: ship });
  await expect(row.getByRole('link', { name: `${ship} Ship the release` })).toBeVisible();
  await expect(row).toContainText(/7 days later: due .+, was .+$/);
  // All lists every ticket the baseline and the plan share.
  await compared.getByRole('button', { name: 'All', exact: true }).click();
  await expect(
    compared.getByRole('list', { name: 'Tickets: All' }).getByRole('listitem'),
  ).toHaveCount(4);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // Even out load into Later: the second week is one point over for Crew.
  await page.goto(`${BASE}/#/plans/${f.plan}/timeline?scenario=${scenario}`);
  await expect(page.getByText(/^Drafting in Later: /)).toBeVisible();
  await page.getByRole('button', { name: 'Auto-schedule…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Auto-schedule' });
  await expect(
    dialog.getByText('1 period of a team or person is over capacity now.'),
  ).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Place work in rank order' })).toBeChecked();
  await dialog.getByRole('radio', { name: 'Even out load' }).check();
  await expect(dialog.getByRole('radio', { name: 'Even out load' })).toBeChecked();
  await dialog.getByRole('radio', { name: 'This scenario: Later' }).check();
  await expect(
    dialog.getByRole('group', { name: 'Kept tickets never move (fixed dates)' }),
  ).toBeVisible();
  await expect(dialog.getByText(/^A run that evens out load and one in rank order /)).toBeVisible();
  // The run is held to the fixture's day, so a test that crosses midnight plans the same weeks.
  await dialog.getByLabel('Schedule from').fill(f.today);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await dialog.getByRole('button', { name: 'Run' }).click();

  // The result on Later's Changes tab: Write the notes moved later, the owner's draft kept.
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(
    new RegExp(`#/plans/${f.plan}/changes\\?(.*&)?scenario=${scenario}`),
  );
  const panel = page.getByRole('region', { name: 'Even out load' });
  await expect(panel.getByRole('heading', { name: 'Even out load' })).toBeFocused();
  await expect(
    panel.getByText('1 ticket moved later, 1 kept, 0 not moved, 0 earlier proposals removed.'),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Moved (1)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const moved = panel.getByRole('list', { name: 'Tickets Moved (1)' });
  await expect(moved.getByRole('listitem')).toHaveCount(1);
  await expect(moved.getByRole('listitem').filter({ hasText: notes })).toContainText(
    new RegExp(`Moved 5 days later, from .+ to .+: Crew ${f.run} was 1 point over\\.`),
  );
  await panel.getByRole('button', { name: 'Kept (1)' }).click();
  const kept = panel.getByRole('list', { name: 'Tickets Kept (1)' });
  await expect(kept.getByRole('listitem').filter({ hasText: ship })).toContainText(
    'Kept: a person drafted its days in this scenario.',
  );
  await expect(
    panel.getByText('Every team and person is within capacity in the run’s periods now.'),
  ).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // On Later's Timeline: Write the notes proposed by the auto-scheduler, Ship the release still
  // the owner's draft. No ticket changed.
  await page.goto(`${BASE}/#/plans/${f.plan}/timeline?scenario=${scenario}`);
  await expect(barOf(page, notes, ', draft, auto-scheduled')).toBeVisible();
  await expect(barOf(page, ship, ', draft')).toBeVisible();
  await expect(page.getByText('Draft, auto-scheduled', { exact: true })).toHaveCount(1);
  expect(await daysOf(page.request, notes)).toEqual({
    start: f.week(2),
    due: plus(f.week(2), 2),
  });
  expect(await daysOf(page.request, ship)).toEqual({
    start: f.week(3),
    due: plus(f.week(3), 3),
  });
  expect(await noSidewaysScroll(page)).toBe(true);
});
