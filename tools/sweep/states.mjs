// What the sweep (tools/sweep/routes.mjs) does on a page to show a state the route alone does not
// show: a dialog, a menu, a grip's menu, or an answer from the backend changed on its way. Each
// takes Playwright's page; routes.mjs lists the states that use them.
import { redact } from './redact.mjs';

export const openBoardTicket = async (page) => {
  const link = page.locator('.board-card-link').first();
  await link.waitFor({ timeout: 10_000 });
  await link.click();
  await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
};

export const openCreate = async (page) => {
  await page.locator('.create-open').click({ timeout: 10_000 });
  await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
};

/**
 * Presses the first grip that can be seen (some show only on focus) and has a menu, and waits for
 * that grip's own menu: the grip marked open, and the menu it names shown. Nothing else on the page
 * counts: an administration page keeps its current group's button marked open (on a phone folded
 * away, on a desktop in sight), and a wait for any open control there passed before the press had
 * done anything (AD-6). `wait` is how long the menu has, in milliseconds.
 */
export const openGrip =
  (grip, { wait = 5000 } = {}) =>
  async (page) => {
    await page.locator(grip).first().waitFor({ state: 'attached', timeout: 10_000 });
    for (const handle of (await page.locator(grip).all()).slice(0, 12)) {
      // A grip with nothing to move to says no menu at all.
      if ((await handle.getAttribute('aria-expanded')) === null) continue;
      await handle.focus().catch(() => {});
      const box = await handle.boundingBox();
      if (!box || box.width < 1 || box.height < 1) continue;
      await handle.scrollIntoViewIfNeeded({ timeout: 3000 });
      await handle.click({ force: true });
      await handle.and(page.locator('[aria-expanded="true"]')).waitFor({ timeout: wait });
      const menu = await handle.getAttribute('aria-controls');
      if (menu) {
        await page.locator(`[id="${menu}"]`).filter({ visible: true }).waitFor({ timeout: wait });
      }
      return;
    }
    throw new Error('no grip could be seen');
  };

/** Opens the first thing of this kind inside the dialog: a menu, a list or a tip. */
export const openInDialog = (kind) => async (page) => {
  const opener = page.locator('[role="dialog"]').first().locator(kind).first();
  await opener.waitFor({ timeout: 10_000 });
  const opened = (await opener.getAttribute('aria-label')) ?? (await opener.innerText());
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  await page.waitForTimeout(200);
  return { opened: redact(opened, 80) };
};

/** The backend says another frontend is wanted; nothing changes on the server. */
export const metaSays = (frontend) => async (page) => {
  await page.route('**/api/meta*', async (call) => {
    const answer = await call.fetch();
    const body = await answer.json();
    await call.fulfill({ response: answer, json: { ...body, frontend } });
  });
};

/** Asked about a link, the backend answers as for a good one, so the form shows (never sent). */
export const linkLooksGood = (path, json) => async (page) => {
  await page.route(`**/api/v1/${path}`, (call) =>
    call.request().method() === 'POST' || path === 'setup'
      ? call.fulfill({ json })
      : call.continue(),
  );
};
