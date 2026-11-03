import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * The ticket pop-up end to end (AGL-018, NFR-005), on tracks of their own: opened from a board
 * with a person filter on, an edit that shows beneath at once, Escape with focus back on the card
 * and the filter still in the address, Back closing it, a reload showing the ticket, a direct link
 * showing the full page, Ctrl-click opening a new tab, and a full-screen sheet at phone width. No
 * serious axe issue and no sideways scroll. It uses the attachments database (preview 4174), whose
 * administrator (Ada Attach) the API server made.
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

/** A track of this run's own, with a ticket assigned to Ada, and its board open with "Me" on. */
async function boardWithFilter(page: Page, prefix: string, projectName: string) {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const me = (await signIn.json()).user.id as number;
  const key = `${prefix}${projectName.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const made = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Popup ${key}`, mode: 'shared' },
  });
  expect(made.status(), await made.text()).toBe(201);
  const ticket = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: key, summary: 'Refund totals', assigneeId: me },
  });
  expect(ticket.status(), await ticket.text()).toBe(201);
  const ticketKey = (await ticket.json()).ticket.key as string;

  const opened = await page.request.get(`${BASE}/api/v1/tracks/${key}/board`);
  expect(opened.status(), await opened.text()).toBe(200);
  const boardName = (await opened.json()).board.name as string;
  await page.goto(`${BASE}/#/tracks/${key}/board`);
  const board = page.getByRole('region', { name: boardName, exact: true });
  const card = board.getByRole('link', { name: new RegExp(`^${ticketKey} `) });
  await expect(card).toBeVisible();
  await board
    .getByRole('group', { name: 'Filter by person' })
    .getByRole('button', { name: 'Me' })
    .click();
  await expect(page).toHaveURL(/\/board\?people=me$/);
  await expect(card).toBeVisible();
  return { key, ticketKey, board, card, boardAddress: page.url() };
}

test('[AGL-018] [NFR-005] a ticket opens over its board, and everything about the address holds', async ({
  page,
  context,
  isMobile,
}, testInfo) => {
  const { ticketKey, board, card, boardAddress } = await boardWithFilter(
    page,
    'U',
    testInfo.project.name,
  );

  // A plain click: the ticket over the board, at the ticket's own address.
  await card.click();
  const dialog = page.getByRole('dialog', { name: `${ticketKey} Refund totals` });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(`${BASE}/#/tickets/${ticketKey}`);
  await expect(dialog.getByRole('button', { name: /^Follow \(/ })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);

  // At phone width it is a full-screen sheet, with nothing sticking out sideways.
  if (isMobile) {
    await expect(async () => {
      const box = await dialog.boundingBox();
      const size = page.viewportSize();
      expect(box?.x).toBe(0);
      expect(box?.y).toBe(0);
      expect(box?.width).toBe(size?.width);
      expect(box?.height).toBe(size?.height);
    }).toPass({ timeout: 5_000 });
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }

  // An edit shows beneath at once.
  await dialog.getByRole('button', { name: 'Edit summary' }).click();
  const summary = dialog.getByRole('textbox', { name: 'Summary' });
  await expect(summary).toBeFocused();
  await summary.fill('Refund totals are wrong');
  await summary.press('Enter');
  const renamed = page.getByRole('dialog', { name: `${ticketKey} Refund totals are wrong` });
  await expect(renamed.getByRole('heading', { level: 1 })).toHaveText(
    `${ticketKey} Refund totals are wrong`,
  );
  await expect(card).toContainText('Refund totals are wrong');

  // Escape: closed, focus back on the card, the filter still in the address.
  await page.keyboard.press('Escape');
  await expect(renamed).toBeHidden();
  await expect(card).toBeFocused();
  await expect(page).toHaveURL(boardAddress);
  await expect(
    board.getByRole('group', { name: 'Filter by person' }).getByRole('button', {
      name: 'Me',
      pressed: true,
    }),
  ).toBeVisible();

  // Open again; Back closes it and lands on the same board.
  await card.click();
  await expect(renamed).toBeVisible();
  await page.goBack();
  await expect(renamed).toBeHidden();
  await expect(card).toBeVisible();
  await expect(page).toHaveURL(boardAddress);

  // A reload shows the ticket: its entry remembers the page, so over the board.
  await card.click();
  await expect(renamed).toBeVisible();
  await page.reload();
  await expect(renamed.getByRole('heading', { level: 1 })).toHaveText(
    `${ticketKey} Refund totals are wrong`,
  );
  await expect(page).toHaveURL(`${BASE}/#/tickets/${ticketKey}`);
  await page.keyboard.press('Escape');
  await expect(renamed).toBeHidden();
  await expect(page).toHaveURL(boardAddress);

  // A direct link has no page beneath: the full page, with no pop-up.
  const shared = await context.newPage();
  await shared.goto(`${BASE}/#/tickets/${ticketKey}`);
  await expect(shared.getByRole('heading', { level: 1 })).toHaveText(
    `${ticketKey} Refund totals are wrong`,
  );
  await expect(shared.getByRole('dialog')).toHaveCount(0);
  await shared.close();

  // Ctrl (Cmd) click: a new tab with the full page, and this page stays as it is.
  if (!isMobile) {
    const [tab] = await Promise.all([
      context.waitForEvent('page'),
      card.click({ modifiers: ['ControlOrMeta'] }),
    ]);
    await expect(tab).toHaveURL(`${BASE}/#/tickets/${ticketKey}`);
    await expect(tab.getByRole('heading', { level: 1 })).toHaveText(
      `${ticketKey} Refund totals are wrong`,
    );
    await expect(tab.getByRole('dialog')).toHaveCount(0);
    await tab.close();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(boardAddress);
  }
});

test('[NFR-005] unsaved text asks before it goes, and Escape closes only what is open', async ({
  page,
  isMobile,
}, testInfo) => {
  const { ticketKey, card, boardAddress } = await boardWithFilter(page, 'W', testInfo.project.name);
  await card.click();
  const dialog = page.getByRole('dialog', { name: `${ticketKey} Refund totals` });
  await expect(dialog.getByRole('button', { name: /^Follow \(/ })).toBeVisible();

  // A menu inside: Escape closes the menu, not the pop-up.
  await dialog.getByRole('button', { name: /^Status: / }).click();
  await expect(dialog.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('menu')).toBeHidden();
  await expect(dialog).toBeVisible();

  // The ticket's shortcuts work inside: M goes to the comment.
  await dialog.focus();
  await page.keyboard.press('m');
  const editor = dialog.getByRole('textbox', { name: 'Add a comment' });
  await expect(editor).toBeFocused();
  await page.keyboard.type('Half a thought');

  // Escape leaves the editor; then closing asks first.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(editor).not.toBeFocused();
  const asked = page.getByRole('alertdialog', { name: 'Discard what you have not saved?' });
  if (isMobile) await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  else
    await page
      .getByRole('button', { name: 'Close this ticket' })
      .click({ position: { x: 4, y: 4 } });
  await expect(asked).toBeVisible();
  await asked.getByRole('button', { name: 'Keep editing' }).click();
  await expect(asked).toBeHidden();
  await expect(editor).toContainText('Half a thought');

  // Back asks too, and stays on the ticket until told.
  await page.goBack();
  await expect(asked).toBeVisible();
  await expect(page).toHaveURL(`${BASE}/#/tickets/${ticketKey}`);
  await expect(editor).toContainText('Half a thought');
  await asked.getByRole('button', { name: 'Discard it' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(boardAddress);
});

test('[CORE-023] [CORE-014] clone, copy a link and set the priority from the pop-up', async ({
  page,
}, testInfo) => {
  const { key, ticketKey, card, boardAddress } = await boardWithFilter(
    page,
    'X',
    testInfo.project.name,
  );
  await card.click();
  const dialog = page.getByRole('dialog', { name: `${ticketKey} Refund totals` });
  await expect(dialog.getByRole('button', { name: /^Follow \(/ })).toBeVisible();

  // The link, in words, whether or not the browser lets it reach the clipboard.
  await dialog.getByRole('button', { name: 'Copy link' }).click();
  await expect(
    dialog.getByText(
      new RegExp(`The link to ${ticketKey} is copied|The browser did not allow copying`),
    ),
  ).toBeVisible();

  // The priority, by icon and name.
  await dialog.getByRole('combobox', { name: 'Priority' }).click();
  await dialog.getByRole('listbox').getByRole('option', { name: 'Urgent' }).click();
  await expect(dialog.getByText('Saved.')).toBeVisible();

  // Clone: a dialog inside the pop-up, and the copy opens in place of the original.
  await dialog.getByRole('button', { name: 'Clone', exact: true }).click();
  const clone = page.getByRole('dialog', { name: `Clone ${ticketKey}` });
  await expect(clone).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(clone).toBeHidden();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Clone', exact: true }).click();
  await clone.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(clone).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole('dialog', { name: new RegExp(`^${key}-\\d+ `) })).toBeVisible();
  await expect(page).not.toHaveURL(`${BASE}/#/tickets/${ticketKey}`);

  // Back steps to the original, and once more to the board.
  await page.goBack();
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(boardAddress);
});
