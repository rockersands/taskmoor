// Signing the sweep in to a private demo (tools/sweep/routes.mjs). The demo prints one-time password
// links. A demo the sweep starts hands its administrator's link over in memory (demo.mjs); for a
// demo started by hand, the link is read from that demo's output file. A password made here, kept
// only in memory, is set, and the browser's state is saved under .cache (ignored by git), readable
// by this account only. Neither the link nor the password is ever printed, logged or written.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { firstLine, redact } from './redact.mjs';

const ADMIN_LINK = /\(site administrator\)\s+(https?:\/\/\S+)/g;

/**
 * The site administrator's one-time link in a demo's output: the last one printed, or null. A link
 * with nothing left to hide (the sweep's own log, where redact() put "..." for its token) is no
 * link: it would open a password page that never comes.
 */
export function adminLinkIn(text) {
  const link = [...String(text ?? '').matchAll(ADMIN_LINK)].at(-1)?.[1] ?? null;
  return link && redact(link, Number.POSITIVE_INFINITY) !== link ? link : null;
}

/** The administrator's one-time link, from the last time a demo wrote its output to this file. */
export function adminLinkFrom(logFile) {
  if (!logFile || !existsSync(logFile)) return null;
  return adminLinkIn(readFileSync(logFile, 'utf8'));
}

/** A password for the demo's administrator: random, used once, never kept. */
export const makePassword = () => `sweep-${randomBytes(24).toString('base64url')}`;

/** The error to show when signing in fails: what failed, never the link or the password. */
export function signInFailure(error) {
  return new Error(`Signing in with the demo's link failed: ${firstLine(error)}`);
}

/** Whether a saved browser state still holds a session on this site. */
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

/**
 * A saved state for the administrator: the one there is if it still works, else a new one made
 * with `link` (from a demo this run started) or the link in `logFile`.
 */
export async function ensureSignedIn(browser, { url, link, logFile, stateFile }) {
  if (await stateWorks(browser, url, stateFile)) return;
  const oneTime = link ?? adminLinkFrom(logFile);
  if (!oneTime) {
    throw new Error(
      `No saved session and no administrator's link: run with --demo, or start the demo with its output in ${logFile}.`,
    );
  }
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(oneTime);
    const fields = page.locator('input[type="password"]');
    await fields.first().waitFor({ timeout: 30_000 });
    const password = makePassword();
    for (const field of await fields.all()) await field.fill(password);
    await page.locator('form button[type="submit"]').first().click();
    await page.waitForFunction(() => !location.href.includes('password'), null, {
      timeout: 30_000,
    });
    if (!(await context.request.get(`${url}/api/v1/session`)).ok()) {
      throw new Error('The password link did not sign the browser in.');
    }
    await context.storageState({ path: stateFile });
    // The saved state holds a session cookie: for this account's eyes only.
    chmodSync(stateFile, 0o600);
  } catch (error) {
    // Playwright's messages can carry the address it was on: say what failed, not where.
    throw signInFailure(error);
  } finally {
    await context.close();
  }
}
