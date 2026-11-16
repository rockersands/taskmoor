import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * The board's person filter (AGL-005 (3)) and the search page's date and field filters (QRY-014
 * (4), QRY-006) against the real server: from the keyboard, kept in the address, with no serious
 * axe issue and no sideways page scroll at phone width. It uses the attachments database (preview
 * 4174) and its ATT track, as the board and search specs do.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
async function seriousAxeViolations(page: Page): Promise<string[]> {
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
/** What sticks out of the page sideways: nothing when the page does not scroll that way. */
const sidewaysOverflow = (page: Page) =>
  page.evaluate(() => {
    if (document.documentElement.scrollWidth <= innerWidth) return [];
    return [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth)
      .slice(0, 10)
      .map((el) => `${el.tagName} ${el.className}`);
  });

test('[AGL-005] a board filtered by person, by keyboard and from a shared address', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const me = (await signIn.json()).user.id as number;
  const word = `ppl${testInfo.project.name}${Date.now().toString(36)}`;
  const make = async (summary: string, assigneeId: number | null) => {
    const res = await page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: 'ATT', summary: `${summary} ${word}`, assigneeId },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()).ticket.key as string;
  };
  const mine = await make('Mine', me);
  const nobodys = await make('Nobody has this', null);

  // The track's own board (one per track, ADR-116): other tests' tickets may be on it too, so
  // the checks look only at this run's two cards.
  const opened = await page.request.get(`${BASE}/api/v1/tracks/ATT/board`);
  expect(opened.status(), await opened.text()).toBe(200);
  const { id: boardId } = (await opened.json()).board as { id: number };
  await page.goto(`${BASE}/#/boards/${boardId}`);
  const board = page.getByRole('region', { name: 'Board', exact: true });
  const links = board.getByRole('link', { name: new RegExp(`^ATT-\\d+ .*${word}`) });
  await expect(links).toHaveCount(2);

  // "Me" with the keyboard: the card that is mine, and the address says so.
  const filter = board.getByRole('group', { name: 'Filter by person' });
  await filter.getByRole('button', { name: 'Me' }).focus();
  await page.keyboard.press('Space');
  await expect(links).toHaveCount(1);
  await expect(links).toContainText(mine);
  await expect(page).toHaveURL(/[?&]people=me(&|$)/);
  // The counts stay whole.
  await expect(board.getByText(/hidden by board filters/).first()).toBeVisible();

  // Several show any of them.
  await filter.getByRole('button', { name: 'Unassigned' }).click();
  await expect(links).toHaveCount(2);
  await expect(page).toHaveURL(/people=me,none/);

  // The address opens the same view: a shared link.
  await page.reload();
  await expect(filter.getByRole('button', { name: 'Me', pressed: true })).toBeVisible();
  await expect(filter.getByRole('button', { name: 'Unassigned', pressed: true })).toBeVisible();
  await filter.getByRole('button', { name: 'Me' }).click();
  await expect(links).toHaveCount(1);
  await expect(links).toContainText(nobodys);

  // The popover with the real keyboard: Enter opens it over the board, which stays where it is;
  // Escape closes it and comes back to its button.
  const columns = board.getByRole('region', { name: 'Columns', exact: true });
  const opener = filter.getByRole('button', { name: /^People/ });
  const panel = filter.getByRole('group', { name: 'People on this board' });
  const top = async () => (await columns.boundingBox())?.y;
  const before = await top();
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  expect(await top()).toBe(before);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(opener).toBeFocused();

  // A click outside closes it too, and focus comes back: the corner of the screen is no control,
  // and on a phone it is the dimmed page around the panel.
  await opener.click();
  await expect(panel).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(panel).toBeHidden();
  await expect(opener).toBeFocused();

  // A phone: nothing scrolls sideways, and the popover docks at the bottom of the screen.
  await page.setViewportSize({ width: 360, height: 700 });
  await expect.poll(() => sidewaysOverflow(page)).toEqual([]);
  await opener.click();
  await expect(panel).toBeVisible();
  // It rises into place, so its edges are read once it has landed.
  await expect
    .poll(async () => {
      const docked = await panel.boundingBox();
      return [docked?.x, docked?.width, Math.round((docked?.y ?? 0) + (docked?.height ?? 0))];
    })
    .toEqual([0, 360, 700]);
  await expect.poll(() => sidewaysOverflow(page)).toEqual([]);
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toBeHidden();
  await filter.getByRole('button', { name: 'Clear people' }).click();
  await expect(links).toHaveCount(2);
  await expect(page).not.toHaveURL(/people=/);
});

test('[QRY-014] [QRY-006] basic date and field filters run on the server and survive the address', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const word = `flt${testInfo.project.name}${Date.now().toString(36)}`;
  // Ada's time zone here is Automatic, which queries read as UTC.
  const today = new Date().toISOString().slice(0, 10);
  const label = `lbl-${word}`;
  const made = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: 'ATT', summary: `Filter me ${word}`, labels: [label], dueDate: today },
  });
  expect(made.status(), await made.text()).toBe(201);
  const ticket = (await made.json()).ticket as {
    key: string;
    ticketType: { name: string };
  };
  const tracks = await page.request.get(`${BASE}/api/v1/tracks?limit=200`);
  const track = ((await tracks.json()).tracks as { id: number; key: string }[]).find(
    (t) => t.key === 'ATT',
  );
  const release = `rel-${word}`;
  const area = `area-${word}`;
  expect(
    (
      await page.request.post(`${BASE}/api/v1/tracks/${track?.id}/releases`, {
        data: { name: release },
      })
    ).status(),
  ).toBe(201);
  expect(
    (
      await page.request.post(`${BASE}/api/v1/tracks/${track?.id}/areas`, { data: { name: area } })
    ).status(),
  ).toBe(201);

  await page.goto(`${BASE}/#/search`);
  const basic = page.getByRole('form', { name: 'Basic' });
  const addFilter = async (name: string) => {
    await basic.getByRole('combobox', { name: 'Add a filter' }).selectOption({ label: name });
    await basic.getByRole('button', { name: 'Add filter' }).click();
    return basic.getByRole('group', { name, exact: true });
  };
  const search = () => basic.getByRole('button', { name: 'Search' }).click();
  const results = page.getByRole('region', { name: 'Results' });
  const found = results.getByRole('link', { name: ticket.key });
  await basic.getByLabel('Words').fill(word);

  // On today it is found; before today it is not; after yesterday it is.
  const created = await addFilter('Date created');
  await expect(created.getByRole('combobox', { name: 'When' })).toBeFocused();
  await created.getByLabel('Day').fill(today);
  await search();
  await expect(found).toBeVisible();
  await created.getByRole('combobox', { name: 'When' }).selectOption('before');
  await search();
  await expect(results.getByText('0 tickets')).toBeVisible();
  await created.getByRole('combobox', { name: 'When' }).selectOption('between');
  await created.getByLabel('From').fill('2000-01-01');
  await created.getByLabel('To').fill(today);
  await search();
  await expect(found).toBeVisible();

  // Each other date field is a query the server takes.
  const due = await addFilter('Due date');
  await due.getByLabel('Day').fill(today);
  await search();
  await expect(found).toBeVisible();
  for (const name of ['Date updated', 'Start date', 'Date closed']) {
    const row = await addFilter(name);
    await row.getByRole('combobox', { name: 'When' }).selectOption('after');
    await row.getByLabel('Day').fill('2000-01-01');
    await search();
    await expect(page.getByText('Searching…')).toHaveCount(0);
    await expect(results.getByRole('alert')).toHaveCount(0);
    await row.getByRole('button', { name: `Remove filter: ${name}` }).click();
  }

  // Values: a type by its box, a label typed, Me as requester and creator.
  const types = await addFilter('Type');
  await types.getByRole('checkbox', { name: ticket.ticketType.name }).check();
  const labels = await addFilter('Labels');
  await labels.getByRole('combobox', { name: 'Value for Labels' }).fill(label);
  await page.keyboard.press('Enter');
  await expect(labels.getByRole('button', { name: `Remove ${label} from Labels` })).toBeVisible();
  const requester = await addFilter('Requester');
  await requester.getByRole('button', { name: 'Me' }).click();
  const creator = await addFilter('Creator');
  await creator.getByRole('button', { name: 'Me' }).click();
  await search();
  await expect(found).toBeVisible();

  // The form and the query agree, and the query in the address opens the same form.
  await page.getByRole('button', { name: 'Advanced' }).click();
  const query = page.getByRole('textbox', { name: 'Query' });
  await expect(query).toHaveValue(
    `type = ${ticket.ticketType.name} AND labels = ${label} AND requester = currentUser() AND creator = currentUser() AND created >= 2000-01-01 AND created < ${nextDay(today)} AND due = ${today} AND text ~ "${word}" ORDER BY updated DESC`,
  );
  await page.getByRole('button', { name: 'Basic' }).click();
  await page.reload();
  await expect(found).toBeVisible();
  await expect(basic.getByRole('group', { name: 'Due date' }).getByLabel('Day')).toHaveValue(today);
  await expect(
    basic
      .getByRole('group', { name: 'Labels' })
      .getByRole('button', { name: `Remove ${label} from Labels` }),
  ).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);

  // Releases and areas: a real name is taken and finds nothing here; the values are offered.
  // A site with many tracks offers values only for the tracks chosen, and this run makes many.
  await basic.getByRole('group', { name: 'Tracks' }).getByRole('checkbox', { name: /ATT/ }).check();
  const target = await addFilter('Target release');
  await expect(target.locator(`datalist option[value="${release}"]`)).toHaveCount(1);
  await target.getByRole('combobox', { name: 'Value for Target release' }).fill(release);
  await target.getByRole('button', { name: 'Add', exact: true }).click();
  const areaRow = await addFilter('Area');
  await expect(areaRow.locator(`datalist option[value="${area}"]`)).toHaveCount(1);
  await areaRow.getByRole('combobox', { name: 'Value for Area' }).fill(area);
  await areaRow.getByRole('button', { name: 'Add', exact: true }).click();
  await search();
  await expect(results.getByText('0 tickets')).toBeVisible();
  await expect(results.getByRole('alert')).toHaveCount(0);

  // A phone: nothing scrolls sideways, and Clear all empties the form.
  await page.setViewportSize({ width: 360, height: 700 });
  await expect.poll(() => sidewaysOverflow(page)).toEqual([]);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await basic.getByRole('button', { name: 'Clear all' }).click();
  await expect(basic.getByRole('group', { name: 'Due date' })).toHaveCount(0);
  await expect(basic.getByLabel('Words')).toHaveValue('');

  // A query the form cannot say keeps saying so.
  await page.getByRole('button', { name: 'Advanced' }).click();
  await query.fill('created >= -7d');
  await page.getByRole('button', { name: 'Basic' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'This query says more than the basic mode can show.',
  );
});

function nextDay(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}
