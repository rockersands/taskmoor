import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from '@playwright/test';
import { uniqueRun } from './unique';

/**
 * The hierarchy grid end to end (T-089a; PLN-010; ADR-122 stage 10): a plan over one track, GD,
 * shared with a viewer. GD holds two outcomes, Launch the shop (status New) and Polish the shop
 * (moved to Active), and three features with a number field, Size: Build the cart (3) and Write
 * the copy (5) under Launch the shop, Fix the footer (2) under Polish the shop. A second track,
 * GH, which the viewer is not a member of, holds a sentinel feature (8) under Launch the shop.
 *
 * The planner opens the Grid (the unsaved default), makes a structure with Add tickets, Group by
 * Status, Add children, a Size column and a Sum of Size total, and sees the tree: the groups by
 * status, the outcomes under them, their features below, the sentinel marked "Not in this plan",
 * and the totals of the rows below. They edit Build the cart's Size in place and the totals above
 * follow; then they move Write the copy under Polish the shop, by dragging its grip on a desktop
 * and with Move under… from its card's sheet on a phone, after confirming: the ticket's parent
 * changes and the totals follow. The viewer sees the same structure with the sentinel only
 * counted, "+1 not shown", never named, never in a total. No serious axe issue and no sideways
 * page scroll. It uses the attachments database (preview 4174), whose administrator (Ada Attach)
 * the API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
// Made for this run: no password is written in the repository.
const PASSWORD = `${randomBytes(18).toString('hex')}-Gr9`;
const SENTINEL = 'Sentinel hidden child';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
async function seriousAxeViolations(page: Page): Promise<string[]> {
  // Evaluated, not a script element, which the app's content security policy refuses (M1-107).
  await page.evaluate(readFileSync(AXE, 'utf8'));
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (context: Document) => Promise<{
            violations: { id: string; impact?: string | null; nodes: { target: unknown[] }[] }[];
          }>;
        };
      }
    ).axe;
    const { violations } = await axe.run(document);
    return violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map(
        (v) => `${v.id} (${v.nodes.length}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      );
  });
}
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

async function ok<T>(answer: ReturnType<APIRequestContext['post']>): Promise<T> {
  const res = await answer;
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as T;
}

interface Fixture {
  run: string;
  plan: number;
  size: string;
  keys: { launch: string; polish: string; cart: string; copy: string; footer: string };
  hidden: string;
  owner: { email: string };
  viewer: { email: string };
}

async function signInAs(api: APIRequestContext, email: string) {
  await api.delete(`${BASE}/api/v1/session`);
  await ok(api.post(`${BASE}/api/v1/session`, { data: { email, password: PASSWORD } }));
}

/** The two tracks, the Size field, the tickets and their parents; the plan, its owner and viewer. */
async function fixture(api: APIRequestContext, testInfo: TestInfo): Promise<Fixture> {
  await ok(api.post(`${BASE}/api/v1/session`, { data: ADMIN }));
  // Two letters and this run's eight: a track key of ten, never one an earlier run used (T-244).
  const run = uniqueRun(testInfo);
  const user = async (who: string) => {
    const email = `${who}-${run}@grid.test`.toLowerCase();
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
  const track = async (key: string, name: string, people: number[]) => {
    const id = (
      await ok<{ track: { id: number } }>(
        api.post(`${BASE}/api/v1/tracks`, { data: { key, name, mode: 'shared' } }),
      )
    ).track.id;
    for (const person of people) {
      const res = await api.put(`${BASE}/api/v1/tracks/${id}/roles/${members}/users/${person}`);
      expect(res.status(), await res.text()).toBeLessThan(300);
    }
    const types = (await (await api.get(`${BASE}/api/v1/tracks/${id}/ticket-types`)).json())
      .ticketTypes as { id: number; name: string }[];
    const type = (word: string) => types.find((y) => y.name === word)?.id;
    return { id, key, type };
  };
  // The viewer is a member of GD only: GH's ticket is never theirs to see.
  const shop = await track(`GD${run}`, `Shop ${run}`, [owner.id, viewer.id]);
  const hush = await track(`GH${run}`, `Hush ${run}`, [owner.id]);
  const size = `Size ${run}`;
  const field = (
    await ok<{ field: { id: number } }>(
      api.post(`${BASE}/api/v1/fields`, { data: { name: size, type: 'number' } }),
    )
  ).field.id;
  const ticket = async (
    on: typeof shop,
    summary: string,
    type: string,
    extra: Record<string, unknown> = {},
  ) =>
    (
      await ok<{ ticket: { key: string } }>(
        api.post(`${BASE}/api/v1/tickets`, {
          data: { track: on.key, summary, ticketTypeId: on.type(type), ...extra },
        }),
      )
    ).ticket.key;
  const sized = (parent: string, n: number) => ({ parent, fields: { [field]: n } });
  const launch = await ticket(shop, 'Launch the shop', 'Outcome');
  const polish = await ticket(shop, 'Polish the shop', 'Outcome');
  const cart = await ticket(shop, 'Build the cart', 'Feature', sized(launch, 3));
  const copy = await ticket(shop, 'Write the copy', 'Feature', sized(launch, 5));
  const footer = await ticket(shop, 'Fix the footer', 'Feature', sized(polish, 2));
  const hidden = await ticket(hush, SENTINEL, 'Feature', sized(launch, 8));
  // Polish the shop is Active, found by its status's words, so the two outcomes group apart.
  const moves = (
    await (await api.get(`${BASE}/api/v1/tickets/${encodeURIComponent(polish)}/transitions`)).json()
  ).transitions as { id: number; to: { name: string } }[];
  const active = moves.find((x) => x.to.name === 'Active');
  expect(active, JSON.stringify(moves)).toBeDefined();
  const moved = await api.post(`${BASE}/api/v1/tickets/${encodeURIComponent(polish)}/transitions`, {
    data: { transitionId: active?.id },
  });
  expect(moved.status(), await moved.text()).toBe(200);

  // The planner makes the plan over GD, so they edit its structures; the viewer only sees it.
  await signInAs(api, owner.email);
  const plan = (
    await ok<{ plan: { id: number } }>(
      api.post(`${BASE}/api/v1/plans`, {
        data: {
          name: `Grid ${run}`,
          sources: [{ kind: 'track', trackId: shop.id }],
          shares: [{ scope: 'user', userId: viewer.id }],
        },
      }),
    )
  ).plan.id;
  return {
    run,
    plan,
    size,
    keys: { launch, polish, cart, copy, footer },
    hidden,
    owner: { email: owner.email },
    viewer: { email: viewer.email },
  };
}

const parentOf = async (api: APIRequestContext, key: string) => {
  const { ticket } = await ok<{ ticket: { parent: { key: string } | null } }>(
    api.get(`${BASE}/api/v1/tickets/${encodeURIComponent(key)}`),
  );
  return ticket.parent?.key ?? null;
};

/** A desktop grid's row of a ticket, by the key its tree cell links. */
const rowOf = (page: Page, key: string) =>
  page
    .getByRole('treegrid')
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: key, exact: true }) });
/** The grid's last row, which totals the top rows. */
const allRows = (page: Page) =>
  page
    .getByRole('treegrid')
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'All rows' }) });
/** A row's cell under the column whose header starts with `header` (the tree column is first). */
async function cellOf(page: Page, row: Locator, header: string): Promise<Locator> {
  const names = await page.getByRole('treegrid').getByRole('columnheader').allInnerTexts();
  const at = names.findIndex((name) => name.startsWith(header));
  expect(at, names.join(' | ')).toBeGreaterThan(0);
  return row.getByRole('gridcell').nth(at - 1);
}
/** A phone card's name: "Open", the key, then the words it shows. */
const cardName = (key: string) => new RegExp(`^Open ${key}(?!\\d)`);
/** A phone's card of a ticket row. */
const cardOf = (page: Page, key: string) =>
  page
    .locator('.plan-grid-card')
    .filter({ has: page.getByRole('button', { name: cardName(key) }) });
/** A phone's sheet of a ticket row: its value of one column. */
const sheetValue = (sheet: Locator, header: string) =>
  sheet
    .getByRole('row')
    .filter({ has: sheet.page().getByRole('rowheader', { name: header, exact: true }) })
    .getByRole('cell');
/** Opens a ticket's card's sheet on a phone. */
async function openSheet(page: Page, key: string, summary: string) {
  await page.getByRole('button', { name: cardName(key) }).click();
  const sheet = page.getByRole('dialog', { name: `${key} ${summary}` });
  await expect(sheet).toBeVisible();
  return sheet;
}

test('[PLN-010] saves a structure, shows the tree with its totals, edits a cell, moves a row after confirming, and only counts a ticket a viewer may not see', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const mobile = testInfo.project.name === 'mobile';
  const f = await fixture(page.request, testInfo);
  const { launch, polish, cart, copy, footer } = f.keys;
  const sum = `Sum of ${f.size}`;

  // The Grid opens on the unsaved default: the plan's tickets and their children.
  await page.goto(`${BASE}/#/plans/${f.plan}/grid`);
  await expect(page.getByText(/^This is the default structure, not saved/)).toBeVisible();
  if (mobile) await expect(cardOf(page, copy)).toBeVisible();
  else await expect(rowOf(page, copy)).toBeVisible();

  // A structure: Add tickets, Group by Status, Add children, a Size column and Sum of Size.
  await page.getByRole('button', { name: 'New structure…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New structure' });
  await dialog.getByLabel('Name', { exact: true }).fill('Shop by status');
  await dialog
    .getByRole('combobox', { name: 'Group by', exact: true })
    .selectOption({ label: 'Status' });
  await dialog.getByLabel('Add children, down every level').check();
  await dialog
    .getByRole('combobox', { name: 'Kind', exact: true })
    .selectOption({ label: 'Ticket column' });
  await dialog
    .getByRole('combobox', { name: 'Field', exact: true })
    .selectOption({ label: f.size });
  await dialog.getByRole('button', { name: 'Add column' }).click();
  await dialog
    .getByRole('combobox', { name: 'Kind', exact: true })
    .selectOption({ label: 'Total of rows below' });
  await dialog.getByRole('combobox', { name: 'Total', exact: true }).selectOption({ label: 'Sum' });
  await dialog.getByRole('combobox', { name: 'Of', exact: true }).selectOption({ label: f.size });
  await dialog.getByRole('button', { name: 'Add column' }).click();
  const columns = dialog.getByRole('list', { name: 'Columns' }).getByRole('listitem');
  await expect(columns).toHaveCount(4);
  await expect(columns.nth(3)).toContainText(`Adds up ${f.size} of the rows below each row.`);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await dialog.getByRole('button', { name: 'Create structure' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Saved Shop by status.')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Structure', exact: true })).toHaveValue(/^\d+$/);

  if (mobile) {
    // Cards: the groups by status, then each ticket with its marks; the totals in each sheet.
    await expect(page.getByText('Status: Active', { exact: true })).toBeVisible();
    await expect(page.getByText('Status: New', { exact: true })).toBeVisible();
    await expect(cardOf(page, f.hidden)).toContainText('Not in this plan');
    let sheet = await openSheet(page, launch, 'Launch the shop');
    await expect(sheetValue(sheet, sum)).toHaveText(/^16(\D|$)/);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await sheet.getByRole('button', { name: 'Close' }).last().click();
    await expect(sheet).toHaveCount(0);

    // Build the cart's Size, edited in its sheet: 3 to 4.
    sheet = await openSheet(page, cart, 'Build the cart');
    const label = `Edit ${f.size} of ${cart}`;
    await sheet.getByRole('button', { name: label }).click();
    await sheet.getByRole('form', { name: label }).getByLabel(label).fill('4');
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(sheetValue(sheet, f.size)).toHaveText(/^4(\D|$)/);
    await sheet.getByRole('button', { name: 'Close' }).last().click();
    sheet = await openSheet(page, launch, 'Launch the shop');
    await expect(sheetValue(sheet, sum)).toHaveText(/^17(\D|$)/);
    await sheet.getByRole('button', { name: 'Close' }).last().click();

    // Write the copy moved under Polish the shop with Move under… from its sheet, confirmed.
    sheet = await openSheet(page, copy, 'Write the copy');
    await sheet.getByRole('button', { name: 'Move under…' }).click();
    const move = page.getByRole('dialog', { name: `Move ${copy} under…` });
    await move.getByLabel('Find the new parent by key or summary').fill('Polish');
    await move.getByRole('radio', { name: new RegExp(`^${polish}`) }).check();
    await expect(move.getByText(`Move ${copy} under ${polish}?`)).toBeVisible();
    await expect(move.getByText(`Its parent changes from ${launch} to ${polish}.`)).toBeVisible();
    expect(await seriousAxeViolations(page)).toEqual([]);
    expect(await noSidewaysScroll(page)).toBe(true);
    expect(await parentOf(page.request, copy)).toBe(launch);
    await move.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(move).toHaveCount(0);
    await expect(page.getByText(`${copy} moved under ${polish}.`)).toBeVisible();
    expect(await parentOf(page.request, copy)).toBe(polish);
    sheet = await openSheet(page, polish, 'Polish the shop');
    await expect(sheetValue(sheet, sum)).toHaveText(/^7(\D|$)/);
    await sheet.getByRole('button', { name: 'Close' }).last().click();
    sheet = await openSheet(page, launch, 'Launch the shop');
    await expect(sheetValue(sheet, sum)).toHaveText(/^12(\D|$)/);
    await sheet.getByRole('button', { name: 'Close' }).last().click();
  } else {
    // The tree: the groups by status, the outcomes under them, their features below.
    const grid = page.getByRole('treegrid', { name: 'Shop by status' });
    await expect(grid).toBeVisible();
    await expect(grid.getByRole('rowheader', { name: /Status: Active/ })).toBeVisible();
    await expect(grid.getByRole('rowheader', { name: /Status: New/ })).toBeVisible();
    await expect(rowOf(page, launch)).toHaveAttribute('aria-level', '2');
    await expect(rowOf(page, cart)).toHaveAttribute('aria-level', '3');
    await expect(rowOf(page, f.hidden)).toHaveAttribute('aria-level', '3');
    await expect(rowOf(page, f.hidden)).toContainText('Not in this plan');
    await expect(await cellOf(page, rowOf(page, cart), f.size)).toHaveText(/^3(\D|$)/);
    // The totals of the rows below: 3 + 5 + 8 under Launch the shop, 2 under Polish the shop.
    await expect(await cellOf(page, rowOf(page, launch), sum)).toHaveText(/^16(\D|$)/);
    await expect(await cellOf(page, rowOf(page, polish), sum)).toHaveText(/^2(\D|$)/);
    await expect(await cellOf(page, allRows(page), sum)).toHaveText(/^18(\D|$)/);
    expect(await seriousAxeViolations(page)).toEqual([]);
    expect(await noSidewaysScroll(page)).toBe(true);

    // Build the cart's Size, edited in place: 3 to 4, and the totals above follow.
    const label = `Edit ${f.size} of ${cart}`;
    await grid.getByRole('button', { name: label }).click();
    await grid.getByRole('form', { name: label }).getByLabel(label).fill('4');
    await grid.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(await cellOf(page, rowOf(page, cart), f.size)).toHaveText(/^4(\D|$)/);
    await expect(await cellOf(page, rowOf(page, launch), sum)).toHaveText(/^17(\D|$)/);
    await expect(await cellOf(page, allRows(page), sum)).toHaveText(/^19(\D|$)/);

    // Write the copy dragged by its grip onto Polish the shop: asked first, then moved.
    const grip = rowOf(page, copy).getByRole('button', { name: `Move ${copy}`, exact: true });
    const from = await grip.boundingBox();
    const to = await rowOf(page, polish).boundingBox();
    if (!from || !to) throw new Error('the grip or the row has no box');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await expect(rowOf(page, polish)).toHaveAttribute('data-drop', 'yes');
    await page.mouse.up();
    const move = page.getByRole('dialog', { name: `Move ${copy} under…` });
    await expect(move.getByText(`Move ${copy} under ${polish}?`)).toBeVisible();
    await expect(move.getByText(`Its parent changes from ${launch} to ${polish}.`)).toBeVisible();
    expect(await seriousAxeViolations(page)).toEqual([]);
    // Nothing changed before the confirmation.
    expect(await parentOf(page.request, copy)).toBe(launch);
    await move.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(move).toHaveCount(0);
    await expect(page.getByText(`${copy} moved under ${polish}.`)).toBeVisible();
    expect(await parentOf(page.request, copy)).toBe(polish);
    await expect(rowOf(page, copy)).toHaveAttribute('aria-level', '3');
    // The totals follow: 4 + 8 under Launch the shop, 2 + 5 under Polish the shop.
    await expect(await cellOf(page, rowOf(page, launch), sum)).toHaveText(/^12(\D|$)/);
    await expect(await cellOf(page, rowOf(page, polish), sum)).toHaveText(/^7(\D|$)/);
    await expect(await cellOf(page, allRows(page), sum)).toHaveText(/^19(\D|$)/);
    expect(await seriousAxeViolations(page)).toEqual([]);
    expect(await noSidewaysScroll(page)).toBe(true);
  }
  // The ticket's own parent is what changed, nothing else.
  expect(await parentOf(page.request, cart)).toBe(launch);
  expect(await parentOf(page.request, footer)).toBe(polish);

  // The viewer: the same structure, the sentinel only counted, never named or totalled.
  await signInAs(page.request, f.viewer.email);
  await page.goto(`${BASE}/#/plans/${f.plan}/grid`);
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Structure', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New structure…' })).toHaveCount(0);
  if (mobile) {
    await expect(cardOf(page, launch)).toContainText('+1 not shown');
    await expect(cardOf(page, cart)).toBeVisible();
    const sheet = await openSheet(page, launch, 'Launch the shop');
    await expect(sheetValue(sheet, sum)).toHaveText(/^4(\D|$)/);
    await expect(sheet).toContainText('+1 not shown');
    expect(await seriousAxeViolations(page)).toEqual([]);
    await sheet.getByRole('button', { name: 'Close' }).last().click();
  } else {
    await expect(rowOf(page, launch)).toContainText('+1 not shown');
    await expect(await cellOf(page, rowOf(page, launch), sum)).toHaveText(/^4(\D|$)/);
    await expect(await cellOf(page, rowOf(page, polish), sum)).toHaveText(/^7(\D|$)/);
    await expect(await cellOf(page, allRows(page), sum)).toHaveText(/^11(\D|$)/);
    expect(await seriousAxeViolations(page)).toEqual([]);
  }
  const text = await page.locator('body').innerText();
  expect(text).not.toContain(SENTINEL);
  expect(text).not.toContain(f.hidden);
  expect(await page.content()).not.toContain(f.hidden);
  await expect(page.getByText('Not in this plan')).toHaveCount(0);
  expect(await noSidewaysScroll(page)).toBe(true);
});
