import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Drag and drop beyond the board, end to end (T-162; ADR-114, section 12): on the backlog a
 * ticket is dragged into a sprint and ranked, Escape cancels a drag under way and the grip's menu
 * makes the same moves from the keyboard; on a dashboard a widget is dragged into another column
 * and moved by keys, and the saved layout keeps it; on a ticket, files held over any part of it
 * outline the whole ticket and go to its attachments when let go. By mouse on a desktop and by a
 * real finger on a phone (touch input through the DevTools protocol, as the Tracks page's groups
 * are tested). No serious axe issue and no sideways scroll. It uses the attachments database
 * (preview 4174), whose administrator (Ada Attach) the API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
/**
 * Serious axe issues, with where they are. `skip` leaves out what a drag fades on purpose: the
 * item in hand stays at its old place, dimmed as on the board, while the label that follows the
 * pointer names it.
 */
async function seriousAxeViolations(page: Page, skip: string[] = []): Promise<string[]> {
  // Evaluated, not a script element, which the app's content security policy refuses (M1-107).
  await page.evaluate(readFileSync(AXE, 'utf8'));
  return page.evaluate(async (exclude) => {
    const axe = (
      window as unknown as {
        axe: {
          run: (context: unknown) => Promise<{
            violations: {
              id: string;
              impact?: string | null;
              nodes: { target: unknown[] }[];
            }[];
          }>;
        };
      }
    ).axe;
    const { violations } = await axe.run({
      include: [document],
      exclude: exclude.map((selector) => [selector]),
    });
    return violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
  }, skip);
}

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

async function ok<T>(
  answer: Promise<{ ok(): boolean; text(): Promise<string>; json(): Promise<unknown> }>,
) {
  const res = await answer;
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json().catch(() => null)) as T;
}

async function signIn(page: Page) {
  await ok(page.request.post(`${BASE}/api/v1/session`, { data: ADMIN }));
}

/** A point on an element: its centre, or `at` (a fraction of its width and height). */
async function pointOn(locator: Locator, at = { x: 0.5, y: 0.5 }) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return {
    x: (box?.x ?? 0) + (box?.width ?? 0) * at.x,
    y: (box?.y ?? 0) + (box?.height ?? 0) * at.y,
  };
}

/**
 * Whether every item of the open menu is on the screen and is what a press at its centre hits:
 * not off the page's sides, and not under the rows and sections that follow it.
 */
async function menuReachable(page: Page): Promise<string[]> {
  await expect(page.getByRole('menu')).toBeVisible();
  return page.evaluate(() => {
    const problems: string[] = [];
    for (const item of document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')) {
      item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const box = item.getBoundingClientRect();
      if (box.left < 0 || box.right > innerWidth) problems.push(`${item.textContent}: off screen`);
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (hit?.closest('[role="menuitem"]') !== item) problems.push(`${item.textContent}: covered`);
    }
    return problems;
  });
}

const CENTRE = { x: 0.5, y: 0.5 };
/** Near the top of a row or a widget: a drop there goes before it. */
const TOP = { x: 0.5, y: 0.2 };

/**
 * Holds `from` and moves it over `to`: a mouse on a desktop, a finger on a phone, which the
 * browser turns into pointer events of type "touch". Both are in view first, clear of the edges
 * where a drag scrolls the page (the two must fit on one screen). Returns the way to let go there.
 */
async function hold(
  page: Page,
  from: Locator,
  to: Locator,
  touch: boolean,
  at = CENTRE,
): Promise<() => Promise<void>> {
  // The point halfway between the two in the middle of the screen.
  await from.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const height = page.viewportSize()?.height ?? 0;
  const halfway = ((await pointOn(from)).y + (await pointOn(to, at)).y) / 2;
  await from.evaluate(
    (element, by) => {
      let scroller = element.parentElement;
      while (
        scroller &&
        !(
          scroller.scrollHeight > scroller.clientHeight &&
          /auto|scroll/.test(getComputedStyle(scroller).overflowY)
        )
      ) {
        scroller = scroller.parentElement;
      }
      (scroller ?? document.scrollingElement)?.scrollBy(0, by);
    },
    halfway - height / 2,
  );
  const a = await pointOn(from);
  const b = await pointOn(to, at);
  expect(b.y, 'the place to drop on is in view').toBeGreaterThan(80);
  expect(b.y, 'the place to drop on is in view').toBeLessThan(height - 80);
  const steps = 12;
  if (!touch) {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps });
    return () => page.mouse.up();
  }
  const cdp = await page.context().newCDPSession(page);
  const touchAt = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }],
    });
  await touchAt('touchStart', a.x, a.y);
  for (let i = 1; i <= steps; i++) {
    await touchAt('touchMove', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  }
  return async () => {
    await touchAt('touchEnd', b.x, b.y);
    await cdp.detach();
  };
}

async function drag(page: Page, from: Locator, to: Locator, touch: boolean, at = CENTRE) {
  const letGo = await hold(page, from, to, touch, at);
  await letGo();
}

test('[AGL-008] [AGL-009] the backlog by drag: into a sprint and ranked, Escape cancels, the grip’s menu does the same', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const touch = testInfo.project.name !== 'desktop';
  await signIn(page);
  const stamp = Date.now().toString(36).toUpperCase().slice(-6);
  const key = `D${testInfo.project.name.slice(0, 1).toUpperCase()}${stamp}`;
  const word = `dnd${testInfo.project.name}${stamp.toLowerCase()}`;
  const made = await ok<{ track: { id: number } }>(
    page.request.post(`${BASE}/api/v1/tracks`, {
      data: { key, name: `Dragging ${key}`, mode: 'shared' },
    }),
  );
  const board = await ok<{ board: { id: number } }>(
    page.request.post(`${BASE}/api/v1/boards`, {
      data: {
        name: `Drag ${word}`,
        kind: 'scrum',
        trackId: made.track.id,
        source: { query: `track = ${key} AND summary ~ ${word}` },
      },
    }),
  );
  const keys: string[] = [];
  for (const summary of ['Card payments', 'Order total', 'Gift cards']) {
    const ticket = await ok<{ ticket: { key: string } }>(
      page.request.post(`${BASE}/api/v1/tickets`, {
        data: { track: key, summary: `${summary} ${word}` },
      }),
    );
    keys.push(ticket.ticket.key);
  }
  const [first, second, third] = keys as [string, string, string];
  const sprint = await ok<{ sprint: { name: string } }>(
    page.request.post(`${BASE}/api/v1/boards/${board.board.id}/sprints`, { data: {} }),
  );
  const sprintName = sprint.sprint.name;

  await page.goto(`${BASE}/#/boards/${board.board.id}/backlog`);
  const backlog = page.getByRole('region', { name: 'Backlog and sprints' });
  const section = (name: string) => backlog.getByRole('region', { name, exact: true });
  const keysIn = async (name: string) =>
    (await section(name).locator('.sprint-ticket-key').allTextContents()).map((k) => k.trim());
  const grip = (ticket: string) =>
    backlog.getByRole('button', { name: `Move ${ticket}`, exact: true });
  const row = (ticket: string) => backlog.locator('[data-ticket-id]').filter({ hasText: ticket });
  const status = backlog.getByRole('status');
  await expect.poll(() => keysIn('Backlog')).toEqual([first, second, third]);
  await expect(section(sprintName)).toBeVisible();

  // The third into the empty sprint, by its grip.
  await drag(page, grip(third), section(sprintName), touch);
  await expect(status).toHaveText(`1 ticket moved to ${sprintName}.`);
  await expect.poll(() => keysIn(sprintName)).toEqual([third]);
  await expect.poll(() => keysIn('Backlog')).toEqual([first, second]);

  // The second above the first: let go near the top of the first's row.
  await drag(page, grip(second), row(first), touch, TOP);
  await expect.poll(() => keysIn('Backlog')).toEqual([second, first]);

  // Under way, the sprint is marked and the page says what is in hand; Escape puts it back.
  const letGo = await hold(page, grip(first), section(sprintName), touch);
  await expect(section(sprintName)).toHaveClass(/is-drop-target/);
  await expect(page.getByText(new RegExp(`^Moving ${first}: drop on a place`))).toBeAttached();
  expect(await seriousAxeViolations(page, ['.is-dragging'])).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(section(sprintName)).not.toHaveClass(/is-drop-target/);
  await letGo();
  await expect(status).toHaveText(`${first} stays where it was.`);
  expect(await keysIn('Backlog')).toEqual([second, first]);

  // The grip's menu, from the keyboard: the same moves one at a time.
  await grip(first).focus();
  await page.keyboard.press('Enter');
  expect(await menuReachable(page)).toEqual([]);
  await page.getByRole('menuitem', { name: 'Move to the top' }).press('Enter');
  await expect(status).toHaveText(`${first} moved to the top.`);
  await expect.poll(() => keysIn('Backlog')).toEqual([first, second]);
  await expect(grip(first)).toBeFocused();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // The server kept every move.
  await page.reload();
  await expect.poll(() => keysIn('Backlog')).toEqual([first, second]);
  await expect.poll(() => keysIn(sprintName)).toEqual([third]);
});

test('[RPT-004] dashboard widgets dragged into another column and moved by keys, kept once saved', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const touch = testInfo.project.name !== 'desktop';
  await signIn(page);
  const name = `Arrange ${testInfo.project.name} ${Date.now().toString(36)}`;
  const note = (title: string, column: number) => ({
    kind: 'introduction',
    column,
    title,
    config: { text: `What ${title} says.` },
  });
  const made = await ok<{ dashboard: { id: number } }>(
    page.request.post(`${BASE}/api/v1/dashboards`, {
      data: {
        name,
        layout: 'two',
        widgets: [note('Alpha', 0), note('Bravo', 0), note('Charlie', 1)],
      },
    }),
  );

  await page.goto(`${BASE}/#/dashboards/${made.dashboard.id}`);
  const dashboard = page.getByRole('region', { name });
  const widget = (title: string) => dashboard.getByRole('article', { name: title });
  const column = (n: number) => dashboard.locator('.dashboard-column').nth(n);
  const titlesIn = (n: number) =>
    column(n)
      .getByRole('article')
      .evaluateAll((list) => list.map((x) => x.getAttribute('aria-label')));
  const said = dashboard.locator('.visually-hidden[aria-live="polite"]');
  await expect(widget('Charlie')).toBeVisible();
  await dashboard.getByRole('button', { name: 'Edit dashboard' }).click();

  // Alpha by its grip, before Charlie in the second column.
  await drag(
    page,
    widget('Alpha').locator('.dashboard-widget-grip'),
    widget('Charlie'),
    touch,
    TOP,
  );
  await expect.poll(() => titlesIn(1)).toEqual(['Alpha', 'Charlie']);
  await expect(said).toHaveText('Alpha is now in column 2, 1 of 2.');

  // Under way, the column is marked; Escape leaves Bravo where it was.
  const letGo = await hold(
    page,
    widget('Bravo').locator('.dashboard-widget-grip'),
    widget('Charlie'),
    touch,
  );
  await expect(column(1)).toHaveClass(/is-drop-target/);
  expect(await seriousAxeViolations(page, ['.is-dragging'])).toEqual([]);
  await page.keyboard.press('Escape');
  await letGo();
  await expect(said).toHaveText('Bravo stays where it was.');
  expect(await titlesIn(0)).toEqual(['Bravo']);

  // Charlie up by Alt and an arrow on its buttons; the keyboard stays on that button.
  await dashboard.getByRole('button', { name: 'Move Charlie up' }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => titlesIn(1)).toEqual(['Charlie', 'Alpha']);
  await expect(said).toHaveText('Charlie is now in column 2, 1 of 2.');
  await expect(dashboard.getByRole('button', { name: 'Move Charlie up' })).toBeFocused();
  expect(await noSidewaysScroll(page)).toBe(true);

  // Saved, and still so after a reload: the server checked and kept the layout.
  await dashboard.getByRole('button', { name: 'Save dashboard' }).click();
  await expect(dashboard.getByRole('status')).toHaveText('Saved.');
  await page.reload();
  await expect(widget('Charlie')).toBeVisible();
  await expect.poll(() => titlesIn(0)).toEqual(['Bravo']);
  await expect.poll(() => titlesIn(1)).toEqual(['Charlie', 'Alpha']);
});

test('[CORE-021] files held over any part of a ticket outline it, and go to its attachments when let go', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const ticket = await ok<{ ticket: { key: string } }>(
    page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: 'ATT', summary: `Files from afar ${testInfo.project.name}` },
    }),
  );
  const key = ticket.ticket.key;
  await page.goto(`${BASE}/#/tickets/${key}`);
  const title = page.getByRole('heading', { level: 1 });
  await expect(title).toHaveText(`${key} Files from afar ${testInfo.project.name}`);
  const panel = page.getByRole('region', { name: 'Attachments' });
  await expect(panel.getByLabel('Attach files')).toBeAttached();
  const overlay = page.locator('.file-drop-overlay');

  // Files from outside the page, as the browser reports them while over the title.
  const files = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['from afar'], 'from-afar.txt', { type: 'text/plain' }));
    return transfer;
  });
  await title.dispatchEvent('dragenter', { dataTransfer: files });
  await title.dispatchEvent('dragover', { dataTransfer: files });
  await expect(page.getByText(`Drop to attach to ${key}`)).toBeVisible();
  await expect(page.getByText(/^Up to .+ a file$/)).toBeVisible();
  // The outline is round the whole ticket, not only the attachments.
  const ticketBox = await page.locator('.ticket-view').boundingBox();
  const outline = await overlay.boundingBox();
  expect(outline?.height ?? 0).toBeGreaterThanOrEqual(
    ticketBox?.height ?? Number.POSITIVE_INFINITY,
  );
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // Let go on the title, far from the attachments: the file goes there.
  await title.dispatchEvent('drop', { dataTransfer: files });
  await expect(overlay).toHaveCount(0);
  await expect(panel.getByText('from-afar.txt attached.')).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Download from-afar.txt' })).toBeVisible();

  // Text dragged within the page is left alone.
  const words = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'some words');
    return transfer;
  });
  await title.dispatchEvent('dragenter', { dataTransfer: words });
  await title.dispatchEvent('dragover', { dataTransfer: words });
  await expect(overlay).toHaveCount(0);
});
