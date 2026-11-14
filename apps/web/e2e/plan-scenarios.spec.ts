import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, type TestInfo, test } from '@playwright/test';
import { uniqueRun } from './unique';

/**
 * Scenarios and draft changes end to end (T-089e; PLN-002, PLN-003; ADR-122 stage 6): a plan over
 * two tracks, SA (Login page, Search box) and SB (Billing), with a program board by a Team field.
 * On a desktop the plan's owner makes the scenario Faster, drafts Login page a day later on the
 * Timeline and Search box a week later on the board, and Billing on the Timeline; the tickets stay
 * as they were. SB's due day is then locked by a field rule, so applying Login page and Billing
 * changes the first and refuses the second for the lock, in words, and Search box stays pending.
 * A second scenario, Slower, is compared with Faster by the plan's end and made main. On a phone
 * the same drafts go through the Timeline's side panel and the board's Move dialog, the change
 * list's actions sit in a bar at the bottom, the same refusal reads in words and the comparison is
 * in cards. No serious axe issue and no sideways page scroll. It
 * uses the attachments database (preview 4174), whose administrator (Ada Attach) the API server
 * made.
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
/** This week's Monday, as the page's own day reckons it (UTC here, as the browsers run). */
const thisMonday = () => {
  const today = new Date().toISOString().slice(0, 10);
  return plus(today, -((new Date().getUTCDay() + 6) % 7));
};

interface Fixture {
  run: string;
  plan: number;
  board: number;
  trackB: number;
  monday: string;
  keys: { login: string; search: string; billing: string };
  owner: { email: string };
}

/** The plan, its tracks, board and owner, made as the site's administrator. */
async function fixture(api: APIRequestContext, testInfo: TestInfo): Promise<Fixture> {
  await ok(api.post(`${BASE}/api/v1/session`, { data: ADMIN }));
  // Two letters and this run's eight: a track key of ten, never one an earlier run used (T-244).
  const run = uniqueRun(testInfo);
  const email = `planner-${run}@scenario.test`.toLowerCase();
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
  const track = async (key: string) => {
    const id = (
      await ok<{ track: { id: number } }>(
        api.post(`${BASE}/api/v1/tracks`, { data: { key, name: `Plan ${key}`, mode: 'shared' } }),
      )
    ).track.id;
    const res = await api.put(`${BASE}/api/v1/tracks/${id}/roles/${members}/users/${owner}`);
    expect(res.status(), await res.text()).toBeLessThan(300);
    return id;
  };
  const keyA = `SA${run}`;
  const keyB = `SB${run}`;
  const trackA = await track(keyA);
  const trackB = await track(keyB);
  const red = (
    await ok<{ team: { id: number } }>(
      api.post(`${BASE}/api/v1/teams`, { data: { name: `Red ${run}` } }),
    )
  ).team.id;
  const field = (
    await ok<{ field: { id: number } }>(
      api.post(`${BASE}/api/v1/fields`, { data: { name: `Team ${run}`, type: 'team' } }),
    )
  ).field.id;
  const monday = thisMonday();
  const ticket = async (key: string, summary: string, start: string, due: string) =>
    (
      await ok<{ ticket: { key: string } }>(
        api.post(`${BASE}/api/v1/tickets`, {
          data: {
            track: key,
            summary,
            startDate: start,
            dueDate: due,
            fields: { [String(field)]: red },
          },
        }),
      )
    ).ticket.key;
  const login = await ticket(keyA, 'Login page', monday, plus(monday, 2));
  const search = await ticket(keyA, 'Search box', monday, plus(monday, 3));
  const billing = await ticket(keyB, 'Billing', monday, plus(monday, 4));
  // The owner makes the plan, so they may draft and apply; the administrator only sets it up.
  await api.delete(`${BASE}/api/v1/session`);
  await ok(api.post(`${BASE}/api/v1/session`, { data: { email, password: PASSWORD } }));
  const plan = (
    await ok<{ plan: { id: number } }>(
      api.post(`${BASE}/api/v1/plans`, {
        data: {
          name: `Scenarios ${run}`,
          sources: [
            { kind: 'track', trackId: trackA },
            { kind: 'track', trackId: trackB },
          ],
        },
      }),
    )
  ).plan.id;
  const planned = await api.patch(`${BASE}/api/v1/plans/${plan}`, {
    data: { teams: [red], period: { kind: 'weeks', weeks: 1, anchor: monday } },
  });
  expect(planned.status(), await planned.text()).toBe(200);
  const board = (
    await ok<{ board: { id: number } }>(
      api.post(`${BASE}/api/v1/plans/${plan}/program-boards`, {
        data: { name: `Increment ${run}`, teamFieldId: field, from: monday, periods: 4 },
      }),
    )
  ).board.id;
  return { run, plan, board, trackB, monday, keys: { login, search, billing }, owner: { email } };
}

/** SB's due days may be set only by a group nobody is in: a field lock (WF-007). */
async function lockBillingsDueDay(api: APIRequestContext, f: Fixture) {
  await api.delete(`${BASE}/api/v1/session`);
  await ok(api.post(`${BASE}/api/v1/session`, { data: ADMIN }));
  const group = (
    await ok<{ group: { id: number } }>(
      api.post(`${BASE}/api/v1/groups`, { data: { name: `Planners ${f.run}` } }),
    )
  ).group.id;
  const rules = (
    await ok<{ fieldRuleSet: { id: number } }>(
      api.post(`${BASE}/api/v1/field-rule-sets`, {
        data: {
          name: `Due locked ${f.run}`,
          rules: [{ field: 'dueDate', editableBy: [{ groupId: group }] }],
        },
      }),
    )
  ).fieldRuleSet.id;
  const res = await api.patch(`${BASE}/api/v1/tracks/${f.trackB}`, {
    data: { fieldRuleSetId: rules },
  });
  expect(res.status(), await res.text()).toBe(200);
}

async function signIn(page: Page, f: Fixture) {
  await page.request.delete(`${BASE}/api/v1/session`);
  await ok(
    page.request.post(`${BASE}/api/v1/session`, {
      data: { email: f.owner.email, password: PASSWORD },
    }),
  );
}

const dueOf = async (api: APIRequestContext, key: string) =>
  (
    await ok<{ ticket: { dueDate: string | null } }>(
      api.get(`${BASE}/api/v1/tickets/${encodeURIComponent(key)}`),
    )
  ).ticket.dueDate;

/** Makes a scenario from the Scenario select, and waits until the page reads it. */
async function newScenario(page: Page, name: string) {
  await page.getByRole('combobox', { name: 'Scenario' }).selectOption({ label: 'New scenario…' });
  const dialog = page.getByRole('dialog', { name: 'New scenario' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Make scenario' }).click();
  await expect(page).toHaveURL(/scenario=\d+/);
  await expect(page.getByText(new RegExp(`^Drafting in ${name}: `))).toBeVisible();
  return Number(/scenario=(\d+)/.exec(page.url())?.[1]);
}

const drafted = (page: Page, key: string, name: string) =>
  expect(
    page.getByText(new RegExp(`^Draft: ${key} .* in ${name}\\. Nothing changed yet\\.$`)),
  ).toBeVisible();

test('[PLN-002] [PLN-003] drafts on the Timeline and a board, applies two of three with a refusal, compares and makes a scenario main', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the desktop’s drags, keys and tables');
  test.setTimeout(180_000);
  const f = await fixture(page.request, testInfo);
  await signIn(page, f);
  await page.goto(`${BASE}/#/plans/${f.plan}/timeline`);
  await expect(page.getByText('Changes you make here change tickets now.')).toBeVisible();
  const faster = await newScenario(page, 'Faster');

  // Alt and an arrow move Login page a day: a draft; the ticket keeps its day.
  const loginBar = page.getByRole('button', { name: new RegExp(`^${f.keys.login}: `) });
  await loginBar.focus();
  await page.keyboard.press('Alt+ArrowRight');
  await drafted(page, f.keys.login, 'Faster');
  await expect(
    page.getByRole('button', { name: new RegExp(`^${f.keys.login}, draft: `) }),
  ).toBeVisible();
  expect(await dueOf(page.request, f.keys.login)).toBe(plus(f.monday, 2));
  const billingBar = page.getByRole('button', { name: new RegExp(`^${f.keys.billing}: `) });
  await billingBar.focus();
  await page.keyboard.press('Alt+ArrowRight');
  await drafted(page, f.keys.billing, 'Faster');
  expect(await seriousAxeViolations(page)).toEqual([]);

  // On the board, Search box moves a week later: a draft too.
  await page.goto(`${BASE}/#/plans/${f.plan}/boards/${f.board}?scenario=${faster}`);
  await page.getByRole('button', { name: `Move ${f.keys.search}…` }).click();
  const move = page.getByRole('dialog', { name: `Move ${f.keys.search}` });
  await move.getByRole('combobox', { name: 'Period' }).selectOption({ index: 2 });
  await move.getByRole('button', { name: 'Draft the move' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft:' })).toContainText(
    `Draft: ${f.keys.search} to`,
  );
  await expect(page.locator(`li[data-card="${f.keys.search}"]`)).toContainText('Draft');
  expect(await dueOf(page.request, f.keys.search)).toBe(plus(f.monday, 3));

  // Billing's due day is locked; apply Login page and Billing.
  await lockBillingsDueDay(page.request, f);
  await signIn(page, f);
  await page.goto(`${BASE}/#/plans/${f.plan}/changes?scenario=${faster}`);
  await expect(
    page.getByRole('heading', { name: 'Changes in Faster, the main scenario' }),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: `Select ${f.keys.login}` }).check();
  await page.getByRole('checkbox', { name: `Select ${f.keys.billing}` }).check();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Apply 2 changes' }).click();
  await page
    .getByRole('group', { name: 'Change 2 tickets as you, with your permissions?' })
    .getByRole('button', { name: 'Apply 2 changes' })
    .click();
  const result = page.getByRole('heading', { name: '1 applied, 1 refused' });
  await expect(result).toBeFocused();
  await expect(page.getByText(new RegExp(`^${f.keys.billing}: it is locked\\.`))).toBeVisible();
  expect(await dueOf(page.request, f.keys.login)).toBe(plus(f.monday, 3));
  expect(await dueOf(page.request, f.keys.billing)).toBe(plus(f.monday, 4));
  // Search box stays pending; Billing stays, refused and chosen.
  await expect(page.getByRole('link', { name: new RegExp(`^${f.keys.search} `) })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: `Select ${f.keys.billing}` })).toBeChecked();
  expect(await noSidewaysScroll(page)).toBe(true);

  // A second scenario, Slower, with Billing far later; compared with Faster, then made main.
  await page.goto(`${BASE}/#/plans/${f.plan}/scenarios`);
  await page.getByRole('button', { name: 'New scenario' }).click();
  const dialog = page.getByRole('dialog', { name: 'New scenario' });
  await dialog.getByLabel('Name').fill('Slower');
  await dialog.getByRole('button', { name: 'Make scenario' }).click();
  await expect(page.getByText('Slower is made.')).toBeVisible();
  const list = await ok<{ scenarios: { id: number; name: string }[] }>(
    page.request.get(`${BASE}/api/v1/plans/${f.plan}/scenarios`),
  );
  const slower = list.scenarios.find((s) => s.name === 'Slower')?.id as number;
  const billingId = (
    await ok<{ ticket: { id: number } }>(
      page.request.get(`${BASE}/api/v1/tickets/${f.keys.billing}`),
    )
  ).ticket.id;
  const put = await page.request.put(`${BASE}/api/v1/plans/${f.plan}/scenarios/${slower}/drafts`, {
    data: { changes: [{ ticketId: billingId, dueDate: plus(f.monday, 30) }] },
  });
  expect(put.status(), await put.text()).toBe(200);
  await page.goto(`${BASE}/#/plans/${f.plan}/scenarios?a=${faster}&b=${slower}`);
  // Only the hash changed: read the plan's scenarios afresh, with Slower's draft.
  await page.reload();
  const ends = page.getByRole('row', { name: /^The plan ends/ });
  await expect(ends).toContainText('days later in Slower');
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Make Slower main' }).click();
  await page
    .getByRole('group', {
      name: 'Slower’s 1 change becomes the plan’s drafts to apply. Faster keeps its 2 changes as a scenario.',
    })
    .getByRole('button', { name: 'Make Slower main' })
    .click();
  await expect(
    page.getByText('Slower is now main: its drafts are the ones to apply.'),
  ).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
});

test('[PLN-002] [PLN-003] on a phone drafts go through the side panel and Move, a refusal reads in words, and scenarios compare in cards', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'the phone’s layout');
  test.setTimeout(180_000);
  const f = await fixture(page.request, testInfo);
  await signIn(page, f);
  await page.goto(`${BASE}/#/plans/${f.plan}/timeline`);
  const faster = await newScenario(page, 'Faster');
  expect(await noSidewaysScroll(page)).toBe(true);

  // The side panel: Login page due a day later and Billing two, saved as drafts.
  const draftDue = async (key: string, due: string) => {
    await page.getByRole('button', { name: new RegExp(`^${key}: `) }).click();
    const panel = page.getByRole('complementary', { name: `Days of ${key}` });
    await panel.getByLabel('Due date').fill(due);
    await panel.getByRole('button', { name: 'Save draft' }).click();
    await drafted(page, key, 'Faster');
  };
  await draftDue(f.keys.login, plus(f.monday, 3));
  await draftDue(f.keys.billing, plus(f.monday, 6));
  expect(await dueOf(page.request, f.keys.login)).toBe(plus(f.monday, 2));
  expect(await dueOf(page.request, f.keys.billing)).toBe(plus(f.monday, 4));

  // The board's Move dialog: Search box a week later.
  await page.goto(`${BASE}/#/plans/${f.plan}/boards/${f.board}?scenario=${faster}`);
  await page.getByRole('button', { name: `Move ${f.keys.search}…` }).click();
  const move = page.getByRole('dialog', { name: `Move ${f.keys.search}` });
  await move.getByRole('combobox', { name: 'Period' }).selectOption({ index: 2 });
  await move.getByRole('button', { name: 'Draft the move' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft:' })).toContainText(
    `Draft: ${f.keys.search} to`,
  );
  expect(await noSidewaysScroll(page)).toBe(true);

  // The change list: cards, and the actions in a bar at the bottom. Billing's due day is locked.
  await lockBillingsDueDay(page.request, f);
  await signIn(page, f);
  await page.goto(`${BASE}/#/plans/${f.plan}/changes?scenario=${faster}`);
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.getByRole('checkbox', { name: `Select ${f.keys.login}` }).check();
  await page.getByRole('checkbox', { name: `Select ${f.keys.billing}` }).check();
  const bar = page.getByRole('group', { name: 'Chosen changes' });
  await bar.getByRole('button', { name: 'Apply 2 changes' }).click();
  await bar.getByRole('button', { name: 'Apply 2 changes' }).click();
  await expect(page.getByRole('heading', { name: '1 applied, 1 refused' })).toBeFocused();
  await expect(page.getByText(new RegExp(`^${f.keys.billing}: it is locked\\.`))).toBeVisible();
  expect(await dueOf(page.request, f.keys.login)).toBe(plus(f.monday, 3));
  expect(await dueOf(page.request, f.keys.billing)).toBe(plus(f.monday, 4));
  // Search box stays pending; Billing stays, refused and chosen.
  await expect(page.getByRole('link', { name: new RegExp(`^${f.keys.search} `) })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: `Select ${f.keys.billing}` })).toBeChecked();
  expect(await noSidewaysScroll(page)).toBe(true);
  expect(await seriousAxeViolations(page)).toEqual([]);

  // Slower, with Billing far later, compared with Faster in cards, then made main.
  await page.goto(`${BASE}/#/plans/${f.plan}/scenarios`);
  await page.getByRole('button', { name: 'New scenario' }).click();
  const dialog = page.getByRole('dialog', { name: 'New scenario' });
  await dialog.getByLabel('Name').fill('Slower');
  await dialog.getByRole('button', { name: 'Make scenario' }).click();
  await expect(page.getByText('Slower is made.')).toBeVisible();
  const list = await ok<{ scenarios: { id: number; name: string }[] }>(
    page.request.get(`${BASE}/api/v1/plans/${f.plan}/scenarios`),
  );
  const slower = list.scenarios.find((s) => s.name === 'Slower')?.id as number;
  const billingId = (
    await ok<{ ticket: { id: number } }>(
      page.request.get(`${BASE}/api/v1/tickets/${f.keys.billing}`),
    )
  ).ticket.id;
  const put = await page.request.put(`${BASE}/api/v1/plans/${f.plan}/scenarios/${slower}/drafts`, {
    data: { changes: [{ ticketId: billingId, dueDate: plus(f.monday, 30) }] },
  });
  expect(put.status(), await put.text()).toBe(200);
  await page.goto(`${BASE}/#/plans/${f.plan}/scenarios?a=${faster}&b=${slower}`);
  await page.reload();
  await expect(page.getByRole('table')).toHaveCount(0);
  const ends = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: /^The plan ends/ }) });
  await expect(ends).toContainText('days later in Slower');
  expect(await noSidewaysScroll(page)).toBe(true);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Make Slower main' }).click();
  await page
    .getByRole('group', {
      name: 'Slower’s 1 change becomes the plan’s drafts to apply. Faster keeps its 2 changes as a scenario.',
    })
    .getByRole('button', { name: 'Make Slower main' })
    .click();
  await expect(
    page.getByText('Slower is now main: its drafts are the ones to apply.'),
  ).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
});
