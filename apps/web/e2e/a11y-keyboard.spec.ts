import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * A keyboard-only journey (M1-115; NFR-005, WCAG 2.1 2.1.1 and 2.4.7): signing in, skipping
 * to the content, editing a list cell, assigning, commenting and moving a ticket with its
 * shortcuts, ranking on the backlog, and moving a timeline bar and a calendar entry, all with
 * Tab, Enter and shortcut keys. Focus is visible where it lands. Data is made through the API
 * in a separate context; the page itself is only ever typed at. It uses the attachments
 * database (preview 4174) and its administrator (Ada Attach).
 */
const BASE = 'http://localhost:4174';
const ADMIN = {
  email: 'ada@attach.test',
  password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD as string,
};

/** Presses Tab until the element has focus (at most 60 times). */
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 60; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${target}`);
}

/** Whether the focused element shows a focus ring (an outline or a box shadow). */
const focusShown = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const style = getComputedStyle(el);
    return (
      (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') || style.boxShadow !== 'none'
    );
  });

test('[NFR-005] the main journeys work with the keyboard alone', async ({
  page,
  playwright,
  isMobile,
  browserName,
}, testInfo) => {
  test.skip(isMobile, 'a keyboard journey: desktop');
  // WebKit, like Safari until "Press Tab to highlight each item" is on, skips links on Tab.
  test.skip(browserName === 'webkit', 'WebKit skips links on Tab by default');
  test.setTimeout(120_000);
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/v1/session', { data: ADMIN })).status()).toBe(200);
  const key = `K${testInfo.project.name.slice(0, 1).toUpperCase()}${testInfo.workerIndex.toString(36).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const post = async (url: string, data: unknown) => {
    const res = await api.post(url, { data });
    expect(res.status(), `${url}: ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  const track = (await post('/api/v1/tracks', { key, name: `Keys ${key}`, mode: 'shared' })).track;
  const day = (n: number) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), n))
      .toISOString()
      .slice(0, 10);
  };
  await post('/api/v1/tickets', {
    track: key,
    summary: 'First by keyboard',
    startDate: day(8),
    dueDate: day(10),
  });
  await post('/api/v1/tickets', { track: key, summary: 'Second by keyboard' });
  const board = (
    await post('/api/v1/boards', {
      name: `Keys ${key}`,
      kind: 'scrum',
      trackId: track.id,
      source: { query: `track = ${key}` },
    })
  ).board;

  // Sign in with the form.
  await page.goto(`${BASE}/#/sign-in`);
  await tabTo(page, page.getByLabel('Email'));
  await page.keyboard.type(ADMIN.email);
  await tabTo(page, page.getByLabel('Password', { exact: true }));
  await page.keyboard.type(ADMIN.password);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // The first Tab reaches the skip link, which moves focus to the content.
  await page.goto(`${BASE}/#/home`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  expect(await focusShown(page)).toBe(true);
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.closest('main') !== null)).toBe(true);

  // A list cell edited in place.
  await page.goto(`${BASE}/#/tracks/${key}/list`);
  const edit = page.getByRole('button', { name: `Edit Summary of ${key}-1`, exact: true });
  await tabTo(page, edit);
  expect(await focusShown(page)).toBe(true);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Edited by keyboard');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Edited by keyboard', { exact: true })).toBeVisible();

  // The ticket's shortcuts: assign to me, comment, transition.
  await page.goto(`${BASE}/#/tickets/${key}-1`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Edited by keyboard');
  await page.keyboard.press('a');
  await expect(page.getByText('Ada Attach').first()).toBeVisible();
  await page.keyboard.press('m');
  await expect(page.getByRole('textbox', { name: 'Add a comment' })).toBeFocused();
  await page.keyboard.type('Typed without a mouse');
  await tabTo(page, page.getByRole('button', { name: 'Comment', exact: true }));
  await page.keyboard.press('Enter');
  // The posted comment, in the list: the composer holds the same words until it is sent.
  await expect(
    page
      .getByRole('region', { name: 'Comments' })
      .getByRole('listitem')
      .filter({ hasText: 'Typed without a mouse' }),
  ).toBeVisible();
  await page.keyboard.press('t');
  const transition = page.locator(':focus');
  await expect(transition).toHaveText(/./);
  await page.keyboard.press('Enter');
  await expect
    .poll(
      async () => (await (await api.get(`/api/v1/tickets/${key}-1`)).json()).ticket.status.stage,
    )
    .not.toBe('new');

  // Ranking on the backlog: the second ticket above the first.
  await page.goto(`${BASE}/#/boards/${board.id}/backlog`);
  await tabTo(page, page.getByRole('link', { name: `${key}-2`, exact: true }));
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.getByRole('status')).toHaveText(`${key}-2 moved up.`);

  // A timeline bar a day later.
  await page.goto(`${BASE}/#/tracks/${key}/timeline`);
  await tabTo(page, page.getByRole('button', { name: new RegExp(`^${key}-1: `) }));
  expect(await focusShown(page)).toBe(true);
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.getByRole('status')).toContainText(`${key}-1 now runs from`);

  // A calendar entry a week later.
  await page.goto(`${BASE}/#/tracks/${key}/calendar`);
  await tabTo(page, page.getByRole('button', { name: new RegExp(`^${key}-1 .*, due this day$`) }));
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.getByRole('status')).toContainText(`${key}-1 is now due on`);
  await api.dispose();
});
