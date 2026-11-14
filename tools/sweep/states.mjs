// What the sweep (tools/sweep/routes.mjs) does on a page to show a state the route alone does not
// show: a dialog, a menu, a grip's menu, or an answer from the backend changed on its way. Each
// takes Playwright's page; routes.mjs lists the states that use them.
import { redact } from './redact.mjs';

/**
 * What an opened menu shows: the menu, or the control that says it is open. Only what can be seen
 * counts. A page can hold such a control out of sight: on a phone the administration pages keep
 * their list of pages folded away, with the current group's button still marked open, and the
 * first match was that hidden button, so the layout editor's grip menu timed out at 375 (AD-6).
 */
export const OPENED_MENU = '[role="menu"], [aria-expanded="true"]';

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

/** Presses the first grip that can be seen (some show only on focus), and waits for its menu. */
export const openGrip = (grip) => async (page) => {
  await page.locator(grip).first().waitFor({ state: 'attached', timeout: 10_000 });
  for (const handle of (await page.locator(grip).all()).slice(0, 12)) {
    await handle.focus().catch(() => {});
    const box = await handle.boundingBox();
    if (!box || box.width < 1 || box.height < 1) continue;
    await handle.scrollIntoViewIfNeeded({ timeout: 3000 });
    await handle.click({ force: true });
    await page.locator(OPENED_MENU).filter({ visible: true }).first().waitFor({ timeout: 5000 });
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
