// Signing the sweep in to a private demo (tools/sweep/routes.mjs). The demo prints one-time password
// links; this reads the site administrator's from the demo's log, sets a password made here and
// kept only in memory, and saves the browser's state under .cache (ignored by git). Neither the
// link nor the password is ever printed, logged or written anywhere else.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** The administrator's one-time link, from the last time the demo started. */
export function adminLinkFrom(logFile) {
  if (!existsSync(logFile)) return null;
  const found = [...readFileSync(logFile, 'utf8').matchAll(/\(site administrator\)\s+(http\S+)/g)];
  return found.at(-1)?.[1] ?? null;
}

/** Whether a saved browser state still holds a session on this instance. */
async function stateWorks(browser, url, stateFile) {
  if (!existsSync(stateFile)) return false;
  const context = await browser.newContext({ storageState: stateFile });
  try {
    const answer = await context.request.get(`${url}/api/v1/session`);
    return answer.ok();
  } finally {
    await context.close();
  }
}

/** A saved state for the administrator: the one there is if it still works, else a new one. */
export async function ensureSignedIn(browser, { url, logFile, stateFile }) {
  if (await stateWorks(browser, url, stateFile)) return;
  const link = adminLinkFrom(logFile);
  if (!link) {
    throw new Error(
      `No saved session and no administrator's link in ${logFile}: start the demo with its output in that file.`,
    );
  }
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(link);
    const fields = page.locator('input[type="password"]');
    await fields.first().waitFor({ timeout: 30_000 });
    const password = `sweep-${randomBytes(24).toString('base64url')}`;
    for (const field of await fields.all()) await field.fill(password);
    await page.locator('form button[type="submit"]').first().click();
    await page.waitForFunction(() => !location.href.includes('password'), null, {
      timeout: 30_000,
    });
    if (!(await context.request.get(`${url}/api/v1/session`)).ok()) {
      throw new Error('The password link did not sign the browser in.');
    }
    await context.storageState({ path: stateFile });
  } catch (error) {
    // Playwright's messages can carry the address it was on: say what failed, not where.
    throw new Error(
      `Signing in with the demo's link failed: ${String(error.message)
        .split('\n')[0]
        .replace(/token=[^\s&"']+/g, 'token=...')}`,
    );
  } finally {
    await context.close();
  }
}
