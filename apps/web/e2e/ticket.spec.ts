import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import { chooseTrack } from './pickers';

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

test('[CORE-022] [AGL-018] a ticket from creation to Closed on the ticket view, with shortcuts', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);

  // Created in the form, then opened from its link.
  await page.goto(`${BASE}/#/create`);
  // Other tests add tracks on this site, some listed before ATT: the form starts on the first.
  await chooseTrack(page, 'ATT');
  await page.getByLabel('Summary (required)').fill(`Refund fails on ${testInfo.project.name}`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const made = page.getByText(/^ATT-\d+ was created\.$/);
  await expect(made).toBeVisible();
  const key = ((await made.textContent()) ?? '').split(' ')[0] as string;
  await page.getByRole('link', { name: `Open ${key}` }).click();
  // It opens in the pop-up; the rest of this journey is on the ticket's own page.
  await page.getByRole('dialog').getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
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
  // Ada is the requester already: the assignment shows by the Unassign button. Assigning
  // makes the assignee a follower, so W comes after it.
  await expect(details.getByRole('button', { name: 'Unassign' })).toBeVisible();
  const follow = page.getByRole('button', { name: /^Follow \(/ });
  const followed = await follow.getAttribute('aria-pressed');
  await page.keyboard.press('w');
  await expect(follow).toHaveAttribute('aria-pressed', followed === 'true' ? 'false' : 'true');

  // A priority, in place.
  const priority = details.getByRole('combobox', { name: 'Priority' });
  await priority.click();
  await details.getByRole('listbox').getByRole('option', { name: 'Urgent' }).click();
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

  // Through the status control: active, then closed, each at once.
  const status = page.getByRole('button', { name: /^Status: / });
  await status.click();
  await page.getByRole('menuitem', { name: 'Active' }).click();
  await expect(page.getByText(/^Moved to /)).toBeVisible();
  await status.click();
  await page.getByRole('menuitem', { name: 'Closed' }).click();
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

test('[AGL-018] the command palette reaches 30 actions and runs them from the keyboard alone', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  await page.goto(`${BASE}/#/create`);
  // Other tests add tracks on this site, some listed before ATT: the form starts on the first.
  await chooseTrack(page, 'ATT');
  await page.getByLabel('Summary (required)').fill(`Palette check on ${testInfo.project.name}`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const made = page.getByText(/^ATT-\d+ was created\.$/);
  await expect(made).toBeVisible();
  const key = ((await made.textContent()) ?? '').split(' ')[0] as string;
  await page.goto(`${BASE}/#/tickets/${key}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(key);
  await expect(page.getByRole('button', { name: /^Follow \(/ })).toBeVisible();

  const palette = page.getByRole('combobox', { name: 'Command palette' });
  const run = async (text: string) => {
    await page.keyboard.press('Control+k');
    await expect(palette).toBeFocused();
    await page.keyboard.type(text);
    await expect(page.getByRole('option', { name: text, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden();
  };

  // Everything the administrator may do from here: pages, settings, the ticket's actions.
  await page.keyboard.press('Control+k');
  await expect(palette).toBeFocused();
  expect(await page.getByRole('option').count()).toBeGreaterThanOrEqual(30);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.keyboard.press('Escape');

  // The creator follows the ticket already: the palette offers the opposite.
  await run(`Stop following ${key}`);
  await expect(page.getByRole('button', { name: /^Follow \(/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await run(`Follow ${key}`);
  await expect(page.getByRole('button', { name: /^Follow \(/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await run(`Assign ${key} to me`);
  await expect(page.getByRole('button', { name: 'Unassign' })).toBeVisible();
  await run(`Vote for ${key}`);
  await expect(page.getByRole('button', { name: 'Vote (1)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await run(`Show the history of ${key}`);
  await expect(page.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
  await run('Use the dark skin');
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'dark');
  await run('Use the light skin');
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'light');
  await run('Follow the device for light or dark');
  await run('Fields');
  await expect(page.getByRole('heading', { level: 1, name: 'Fields' })).toBeVisible();
  // The ticket's own commands leave with the ticket view.
  await page.keyboard.press('Control+k');
  await page.keyboard.type(key);
  await expect(page.getByRole('option', { name: 'No matching commands' })).toBeVisible();
});

test('[CORE-022] [NFR-005] a ticket prints across the paper, readable, its fields as values, its cards unframed (S3-SP-2, S3-SP-3, S3-SP-4, PL-27, T-359)', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  const made = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: 'ATT', summary: `Printed on ${testInfo.project.name}` },
  });
  expect(made.status()).toBe(201);
  const { key } = (await made.json()).ticket as { key: string };
  await page.goto(`${BASE}/#/tickets/${key}`);
  const title = page.getByRole('heading', { level: 1 });
  await expect(title).toContainText(key);
  const details = page.getByRole('region', { name: 'Details' });
  await expect(details.getByLabel('Start date')).toBeVisible();

  await expect(page.locator('.ticket-page .ticket-text .rt-bar')).toHaveCount(1);

  await page.emulateMedia({ media: 'print' });
  const printed = await page.evaluate(() => {
    const page = document.querySelector('.ticket-page') as HTMLElement;
    const left = (selector: string) =>
      (page.querySelector(selector) as HTMLElement).getBoundingClientRect().left;
    // Where an element's words start: inside its border and padding.
    const wordsAt = (el: HTMLElement) => {
      const style = getComputedStyle(el);
      return (
        el.getBoundingClientRect().left +
        Number.parseFloat(style.borderLeftWidth) +
        Number.parseFloat(style.paddingLeft)
      );
    };
    const details = page.querySelector('.ticket-details') as HTMLElement;
    const date = details.querySelector('input[type="date"]') as HTMLElement;
    // A value shown as words, with no control in it.
    const value = [...details.querySelectorAll('dd')].find(
      (dd) => !dd.querySelector('input, select, button, a') && dd.textContent?.trim(),
    ) as HTMLElement;
    const bars = [...page.querySelectorAll<HTMLElement>('.ticket-text .rt-bar')];
    const cards = [
      ...page.querySelectorAll<HTMLElement>('.ticket-text, .ticket-details, .ticket-activity'),
    ];
    return {
      title: left('h1'),
      description: left('.ticket-text'),
      bar: bars.some((bar) => bar.getBoundingClientRect().height > 0),
      dateIndent: Math.round(wordsAt(date) - wordsAt(value)),
      rims: cards.map((card) => getComputedStyle(card, '::before').content),
    };
  });
  // The sidebar's column goes with the sidebar: the ticket starts at the paper's edge (S3-SP-3).
  // No line is left over from the editor's hidden toolbar above the description (S3-SP-4), and a
  // date edited in place starts its words where the other values do (PL-27). The Description,
  // Details and Activity cards print without the glass rim round them (T-359).
  expect(printed).toEqual({
    title: expect.any(Number),
    description: expect.any(Number),
    bar: false,
    dateIndent: 0,
    rims: ['none', 'none', 'none'],
  });
  expect(printed.title).toBeLessThan(40);
  expect(printed.description).toBeLessThan(40);
  // The quieter text (the track and type over the title) reads on paper: axe finds nothing
  // (S3-SP-2).
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.emulateMedia({ media: 'screen' });
});
