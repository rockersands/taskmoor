import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * A ticket's whole life on the ticket view (M1-051): created in the form, opened, renamed,
 * assigned, followed and commented on with keyboard shortcuts, given a priority, worked on (time
 * logged), moved through its workflow to Closed with a close reason, its history read, with no
 * serious axe issue on the way. It uses the attachments database (preview 4174), whose
 * administrator (Ada Attach) the API server made with the ATT track.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
async function seriousAxeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE });
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

test('[CORE-022] [AGL-018] a ticket from creation to Closed on the ticket view, with shortcuts', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);

  // Created in the form, then opened from its link.
  await page.goto(`${BASE}/#/create`);
  await page.getByLabel('Summary (required)').fill(`Refund fails on ${testInfo.project.name}`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const made = page.getByText(/^ATT-\d+ was created\.$/);
  await expect(made).toBeVisible();
  const key = ((await made.textContent()) ?? '').split(' ')[0] as string;
  await page.getByRole('link', { name: `Open ${key}` }).click();
  const title = page.getByRole('heading', { level: 1 });
  await expect(title).toHaveText(`${key} Refund fails on ${testInfo.project.name}`);
  await expect(page.getByRole('button', { name: /^Follow \(/ })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);

  // E: rename it.
  await page.keyboard.press('e');
  const summary = page.getByRole('textbox', { name: 'Summary' });
  await expect(summary).toBeFocused();
  await summary.fill(`Refunds fail for expired cards on ${testInfo.project.name}`);
  await summary.press('Enter');
  await expect(title).toHaveText(
    `${key} Refunds fail for expired cards on ${testInfo.project.name}`,
  );

  // A: assign it to me. W: follow it (creating it may already have: W toggles either way).
  const details = page.getByRole('region', { name: 'Details' });
  await page.keyboard.press('a');
  await expect(details.getByText('Ada Attach', { exact: true }).first()).toBeVisible();
  const follow = page.getByRole('button', { name: /^Follow \(/ });
  const followed = await follow.getAttribute('aria-pressed');
  await page.keyboard.press('w');
  await expect(follow).toHaveAttribute('aria-pressed', followed === 'true' ? 'false' : 'true');

  // A priority, in place.
  const priority = details.getByRole('combobox', { name: 'Priority' });
  await priority.selectOption({ index: 1 });
  await expect(page.getByText('Saved.')).toBeVisible();

  // M: comment.
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('m');
  const editor = page.getByRole('textbox', { name: 'Add a comment' });
  await expect(editor).toBeFocused();
  await page.keyboard.type('Reproduced with a card that expired last month');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Comments' }).getByText('Reproduced with a card'),
  ).toBeVisible();

  // Time logged.
  await page.getByRole('tab', { name: 'Time entries' }).click();
  await page.getByRole('textbox', { name: 'Time spent' }).fill('1h 30m');
  await page.getByRole('button', { name: 'Log time' }).click();
  await expect(page.getByText('Time logged.')).toBeVisible();
  await expect(
    page.getByRole('tabpanel', { name: 'Time entries' }).getByText(/^1\.5 h/),
  ).toBeVisible();

  // Through the workflow: started, then closed with a reason.
  await page.getByRole('button', { name: /^Start, to / }).click();
  await expect(page.getByText(/^Moved to /)).toBeVisible();
  await page.getByRole('button', { name: /^Close, to / }).click();
  const closing = page.getByRole('form', { name: 'Close: what it needs' });
  await expect(closing.getByRole('combobox', { name: 'Close reason' })).toBeVisible();
  await closing.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.ticket-status')).toHaveAttribute('data-stage', 'closed');

  // The history tells the story.
  await page.getByRole('tab', { name: 'History' }).click();
  const history = page.getByRole('tabpanel', { name: 'History' });
  await expect(history.getByText(/^Changed Status from /).first()).toBeVisible();
  await expect(history.getByText(/^Changed Summary from /)).toBeVisible();
  await expect(history.getByText('Added a comment')).toBeVisible();

  // Nothing scrolls sideways, on a phone either; no serious axe issue at the end either.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await seriousAxeViolations(page)).toEqual([]);
});
