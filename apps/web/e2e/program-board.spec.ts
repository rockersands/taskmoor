import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  type APIRequestContext,
  type Browser,
  expect,
  type Page,
  type TestInfo,
  test,
} from '@playwright/test';
import { expectWithinBudget } from './budget';

/**
 * Program boards end to end (T-089d; PLN-008; ADR-122 stage 5): a plan over one track plans with
 * two teams, Red and Blue, by a Team field, in one-week periods from this week's Monday. Ori and
 * Vera, members of the track, open the same board in two browsers. On a desktop Ori drags a card
 * to Blue a week later and Vera sees it there within a second, through the local copy and the
 * realtime socket (ADR-013); Vera moves it back with its Move button and Ori sees that. Then Vera
 * opens Move on a card, Ori moves the same card meanwhile, and Vera's move is refused and said in
 * words. On a phone a card moves through its Move dialog, one team at a time. No serious axe issue
 * and no sideways page scroll. It uses the attachments database (preview 4174), whose
 * administrator (Ada Attach) the API server made.
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
 * The Monday of UTC's week. The page's own today is the person's (ADR-010 T-280), which can be a
 * day off; nothing here turns on it, since every day the test checks is counted from this one.
 */
const thisMonday = () => {
  const today = new Date().toISOString().slice(0, 10);
  return plus(today, -((new Date().getUTCDay() + 6) % 7));
};

interface Fixture {
  plan: number;
  board: number;
  red: number;
  blue: number;
  names: { red: string; blue: string };
  keys: { login: string; search: string };
  ori: { email: string };
  vera: { email: string };
}

/** The plan, its board and its people, made as the site's administrator. */
async function fixture(api: APIRequestContext, testInfo: TestInfo): Promise<Fixture> {
  await ok(api.post(`${BASE}/api/v1/session`, { data: ADMIN }));
  const run = `${testInfo.project.name.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-5)}`;
  const person = async (who: string) => {
    const email = `${who}-${run}@board.test`.toLowerCase();
    const id = (
      await ok<{ user: { id: number } }>(
        api.post(`${BASE}/api/v1/users`, {
          data: { email, name: `${who} ${run}`, password: PASSWORD },
        }),
      )
    ).user.id;
    return { id, email };
  };
  const ori = await person('Ori');
  const vera = await person('Vera');
  const roles = (await (await api.get(`${BASE}/api/v1/roles`)).json()).roles as {
    id: number;
    name: string;
  }[];
  const members = roles.find((r) => r.name === 'Members')?.id;
  const key = `PG${run}`;
  const track = (
    await ok<{ track: { id: number } }>(
      api.post(`${BASE}/api/v1/tracks`, { data: { key, name: `Board ${key}`, mode: 'shared' } }),
    )
  ).track.id;
  for (const who of [ori, vera]) {
    const res = await api.put(`${BASE}/api/v1/tracks/${track}/roles/${members}/users/${who.id}`);
    expect(res.status(), await res.text()).toBeLessThan(300);
  }
  const team = async (name: string) =>
    (await ok<{ team: { id: number } }>(api.post(`${BASE}/api/v1/teams`, { data: { name } }))).team
      .id;
  const red = await team(`Red ${run}`);
  const blue = await team(`Blue ${run}`);
  const field = (
    await ok<{ field: { id: number } }>(
      api.post(`${BASE}/api/v1/fields`, { data: { name: `Team ${run}`, type: 'team' } }),
    )
  ).field.id;
  const monday = thisMonday();
  const ticket = async (summary: string, teamId: number, due: string) =>
    (
      await ok<{ ticket: { key: string } }>(
        api.post(`${BASE}/api/v1/tickets`, {
          data: { track: key, summary, dueDate: due, fields: { [String(field)]: teamId } },
        }),
      )
    ).ticket.key;
  const login = await ticket('Login page', red, plus(monday, 2));
  const search = await ticket('Search box', red, plus(monday, 3));
  const plan = (
    await ok<{ plan: { id: number } }>(
      api.post(`${BASE}/api/v1/plans`, {
        data: {
          name: `Program ${run}`,
          sources: [{ kind: 'track', trackId: track }],
          shares: [{ scope: 'any_user' }],
        },
      }),
    )
  ).plan.id;
  const planned = await api.patch(`${BASE}/api/v1/plans/${plan}`, {
    data: { teams: [red, blue], period: { kind: 'weeks', weeks: 1, anchor: monday } },
  });
  expect(planned.status(), await planned.text()).toBe(200);
  const board = (
    await ok<{ board: { id: number } }>(
      api.post(`${BASE}/api/v1/plans/${plan}/program-boards`, {
        data: { name: `Increment ${run}`, teamFieldId: field, from: monday, periods: 4 },
      }),
    )
  ).board.id;
  return {
    plan,
    board,
    red,
    blue,
    names: { red: `Red ${run}`, blue: `Blue ${run}` },
    keys: { login, search },
    ori,
    vera,
  };
}

/** Signs `page` in as `email` and opens the board, with its local copy running. */
async function open(page: Page, email: string, f: Fixture) {
  await page.request.delete(`${BASE}/api/v1/session`);
  await ok(page.request.post(`${BASE}/api/v1/session`, { data: { email, password: PASSWORD } }));
  await page.goto(`${BASE}/#/plans/${f.plan}/boards/${f.board}`);
  // Moves made elsewhere arrive through the local copy; it is running once it has a position.
  await expect(page.locator('html[data-sync-position]')).toHaveCount(1, { timeout: 30_000 });
}

/** A browser of its own, signed in as `email`, on the board. */
async function openAs(browser: Browser, email: string, f: Fixture) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await open(page, email, f);
  return { context, page };
}

const cell = (page: Page, team: number, column: number) =>
  page.locator(`td[data-cell="${team}:${column}"]`);
const card = (page: Page, key: string) => page.locator(`li[data-card="${key}"]`);

test('[PLN-008] two people on one program board see each other’s moves within a second', async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the table and its drags are a desktop’s');
  test.setTimeout(180_000);
  const f = await fixture(page.request, testInfo);
  const ori = await openAs(browser, f.ori.email, f);
  const vera = await openAs(browser, f.vera.email, f);
  try {
    const a = ori.page;
    const b = vera.page;
    await expect(card(a, f.keys.login)).toBeVisible();
    await expect(cell(b, f.red, 1).locator(`[data-card="${f.keys.login}"]`)).toBeVisible();
    expect(await seriousAxeViolations(a)).toEqual([]);
    expect(await noSidewaysScroll(a)).toBe(true);

    // Ori drags Login to Blue, a week later; Vera sees it there within a second.
    await card(a, f.keys.login).dragTo(cell(a, f.blue, 2));
    const dropped = Date.now();
    // Waited for as it lands, not by the assertion's polling steps, so the time is the page's.
    await cell(b, f.blue, 2)
      .locator(`[data-card="${f.keys.login}"]`)
      .waitFor({ state: 'visible', timeout: 10_000 });
    const seen = Date.now() - dropped;
    expectWithinBudget(testInfo, seen, 1000, 'program board: a move seen in another browser (ms)');
    // The scenario bar has a status line of its own, so the board's is found by its words.
    await expect(
      a.getByRole('status').filter({ hasText: `${f.keys.login} moved to` }),
    ).toBeVisible();
    await expect(cell(b, f.red, 1).locator(`[data-card="${f.keys.login}"]`)).toHaveCount(0);

    // Vera moves it back with its Move button; Ori sees that too.
    await b.getByRole('button', { name: `Move ${f.keys.login}…` }).click();
    const dialog = b.getByRole('dialog', { name: `Move ${f.keys.login}` });
    await dialog.getByRole('combobox', { name: 'Team' }).selectOption({ label: f.names.red });
    await dialog.getByRole('combobox', { name: 'Period' }).selectOption({ index: 1 });
    await dialog.getByRole('button', { name: 'Move' }).click();
    await expect(cell(a, f.red, 1).locator(`[data-card="${f.keys.login}"]`)).toBeVisible({
      timeout: 10_000,
    });

    // Vera opens Move on Search; Ori moves Search meanwhile. Vera's move is refused, in words,
    // and her board shows Search where Ori put it.
    await b.getByRole('button', { name: `Move ${f.keys.search}…` }).click();
    const stale = b.getByRole('dialog', { name: `Move ${f.keys.search}` });
    await card(a, f.keys.search).dragTo(cell(a, f.red, 3));
    await expect(cell(b, f.red, 3).locator(`[data-card="${f.keys.search}"]`)).toBeVisible({
      timeout: 10_000,
    });
    await stale.getByRole('combobox', { name: 'Team' }).selectOption({ label: f.names.blue });
    await stale.getByRole('button', { name: 'Move' }).click();
    await expect(
      b.getByRole('status').filter({ hasText: `${f.keys.search} changed while you moved it` }),
    ).toBeVisible();
    await expect(cell(b, f.red, 3).locator(`[data-card="${f.keys.search}"]`)).toBeVisible();
    // The ticket kept Ori's move: the server's board, read afresh, has Search in Red's third week.
    // Vera's stale move asked for Blue in the week her dialog showed; applied, it would be there.
    const fresh = await ok<{
      rows: { team: { id: number } | null; cells: { cards: number[] }[] }[];
      cards: { id: number; key: string }[];
    }>(b.request.get(`${BASE}/api/v1/plans/${f.plan}/program-boards/${f.board}`));
    const searchId = fresh.cards.find((c) => c.key === f.keys.search)?.id;
    expect(searchId).toBeDefined();
    const where = fresh.rows.flatMap((row) =>
      row.cells.flatMap((c, i) =>
        c.cards.includes(searchId as number) ? [`${row.team?.id ?? 'none'}:${i + 1}`] : [],
      ),
    );
    expect(where).toEqual([`${f.red}:3`]);
  } finally {
    await ori.context.close();
    await vera.context.close();
  }
});

test('[PLN-008] on a phone a card moves through its Move dialog, one team at a time', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'the phone’s layout');
  test.setTimeout(120_000);
  const f = await fixture(page.request, testInfo);
  await open(page, f.ori.email, f);
  {
    const a = page;
    const picker = a.getByRole('combobox', { name: 'Team' });
    await expect(picker).toBeVisible();
    await expect(a.getByRole('table')).toHaveCount(0);
    await expect(card(a, f.keys.login)).toBeVisible();
    expect(await noSidewaysScroll(a)).toBe(true);
    expect(await seriousAxeViolations(a)).toEqual([]);
    await a.getByRole('button', { name: `Move ${f.keys.login}…` }).click();
    const dialog = a.getByRole('dialog', { name: `Move ${f.keys.login}` });
    await dialog.getByRole('combobox', { name: 'Team' }).selectOption({ label: f.names.blue });
    await dialog.getByRole('button', { name: 'Move' }).click();
    await expect(
      a.getByRole('status').filter({ hasText: `${f.keys.login} moved to` }),
    ).toBeVisible();
    // Blue's work now holds it.
    await picker.selectOption({ label: f.names.blue });
    await expect(card(a, f.keys.login)).toBeVisible();
    expect(await noSidewaysScroll(a)).toBe(true);
  }
});
