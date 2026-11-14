import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import { chooseTrack } from './pickers';
import { uniqueKey } from './unique';

/**
 * Ticket templates end to end (CORE-029, CORE-030; ADR-113): from a track's summary to its
 * templates, one made with the form; the create dialog fills in its values for review, and
 * Create makes the ticket and its subtickets. A field rule then hides a value: the form does not
 * show it and the ticket says it was left out. A template for every track is kept on its own
 * page, shows in the track's, and is deleted after asking. No serious axe issue and no sideways
 * page scroll, on a phone too. It uses the attachments database (preview 4174), whose
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
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test('[CORE-029] [CORE-030] a template kept on its page starts a ticket and its subtickets', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const api = async (method: 'post' | 'patch' | 'get', path: string, data?: unknown) => {
    const res = await page.request[method](`${BASE}/api/v1${path}`, data ? { data } : {});
    expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
    return res.json();
  };
  const key = uniqueKey('T', testInfo);
  const name = `Templates ${key}`;
  const { track } = await api('post', '/tracks', { key, name, mode: 'shared' });

  // From the track's summary to its templates; one made with the form.
  await page.goto(`${BASE}/#/tracks/${key}`);
  await page.getByRole('link', { name: 'Ticket templates', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ticket templates' })).toBeVisible();
  // The track's tab bar stays above its templates (T-215).
  await expect(page.getByRole('navigation', { name: `Sections of ${key}` })).toBeVisible();
  await page.getByRole('button', { name: 'New template' }).click();
  const form = page.getByRole('form', { name: 'New template' });
  await form.getByRole('textbox', { name: 'Name' }).fill('Release checklist');
  await form.getByRole('textbox', { name: 'What it is for' }).fill('Everything a release needs');
  await form.getByRole('textbox', { name: 'Summary' }).fill('Release {track}');
  await form.getByRole('textbox', { name: 'Labels' }).fill('release checklist');
  await form.getByRole('spinbutton', { name: 'Due date, in days from today' }).fill('7');
  await form.getByRole('button', { name: 'Add a subticket' }).click();
  await form.getByRole('textbox', { name: 'Subticket 1: summary' }).fill('Notes for {track}');
  await form.getByRole('button', { name: 'Add a subticket' }).click();
  await form.getByRole('textbox', { name: 'Subticket 2: summary' }).fill('Announce it');
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await form.getByRole('button', { name: 'Save the template' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'was saved' })).toHaveText(
    'Template Release checklist was saved.',
  );
  await expect(page.getByText('2 subtickets')).toBeVisible();

  // The create dialog fills in its values for review.
  const open = async () => {
    await page.keyboard.press('c');
    const dialog = page.getByRole('dialog', { name: 'Create ticket' });
    await expect(dialog).toBeVisible();
    await chooseTrack(dialog, key);
    const picker = dialog.getByRole('combobox', { name: 'Start from a template' });
    await expect(picker).toBeEnabled();
    await expect(dialog.getByLabel('Summary (required)')).toBeVisible();
    await picker.selectOption({ label: 'Release checklist' });
    await expect(dialog.getByLabel('Summary (required)')).toHaveValue(`Release ${key}`);
    return dialog;
  };
  await page.goto(`${BASE}/#/home`);
  await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible();
  const dialog = await open();
  await expect(dialog.getByLabel('Labels')).toHaveValue('release checklist');
  await expect(dialog.getByLabel('Due date')).not.toHaveValue('');
  await expect(dialog.getByRole('checkbox', { name: 'Create its 2 subtickets' })).toBeChecked();
  expect(await seriousAxeViolations(page)).toEqual([]);

  // The person's edit wins; the ticket and its subtickets are made.
  await dialog.getByLabel('Labels').fill('release mine');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const made = dialog.getByText(new RegExp(`^${key}-\\d+ was created\\.$`));
  await expect(made).toBeVisible();
  const ticketKey = ((await made.textContent()) ?? '').split(' ')[0] as string;
  await expect(dialog.getByText(/^Subtickets created: /)).toBeVisible();
  const { ticket } = await api('get', `/tickets/${ticketKey}`);
  expect(ticket.summary).toBe(`Release ${key}`);
  expect(ticket.labels.sort()).toEqual(['mine', 'release']);
  expect(ticket.dueDate).not.toBeNull();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();

  // A field rule hides the labels: the form does not show them, and the ticket says so.
  const { fieldRuleSet } = await api('post', '/field-rule-sets', {
    name: `Hide labels ${key}`,
    rules: [{ field: 'labels', hidden: true }],
  });
  await api('patch', `/tracks/${track.id}`, { fieldRuleSetId: fieldRuleSet.id });
  await page.goto(`${BASE}/#/home`);
  await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible();
  const again = await open();
  await expect(again.getByLabel('Labels')).toHaveCount(0);
  await again.getByRole('checkbox', { name: 'Create its 2 subtickets' }).uncheck();
  await again.getByRole('button', { name: 'Create', exact: true }).click();
  const second = again.getByText(new RegExp(`^${key}-\\d+ was created\\.$`));
  await expect(second).toBeVisible();
  await expect(again.getByText('Left out, because they cannot be set here: Labels.')).toBeVisible();
  const secondKey = ((await second.textContent()) ?? '').split(' ')[0] as string;
  expect((await api('get', `/tickets/${secondKey}`)).ticket.labels).toEqual([]);
  await again.getByRole('button', { name: 'Close', exact: true }).click();

  // A template for every track, kept on its own page.
  const shared = `Everywhere ${key}`;
  await page.goto(`${BASE}/#/admin/ticket-templates`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Ticket templates for every track' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'New template' }).click();
  const everywhere = page.getByRole('form', { name: 'New template' });
  await expect(everywhere.getByRole('searchbox', { name: 'Assignee' })).toHaveCount(0);
  await everywhere.getByRole('textbox', { name: 'Name' }).fill(shared);
  await everywhere.getByRole('button', { name: 'Save the template' }).click();
  await expect(page.getByRole('button', { name: `Edit template ${shared}` })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // It shows in the track's list, read-only there.
  await page.goto(`${BASE}/#/tracks/${key}/templates`);
  const row = page.getByRole('listitem').filter({ hasText: shared });
  await expect(row.getByText('Every track', { exact: true })).toBeVisible();
  await expect(row.getByRole('button')).toHaveCount(0);

  // Deleted after asking.
  await page.goto(`${BASE}/#/admin/ticket-templates`);
  await page.getByRole('button', { name: `Delete template ${shared}` }).click();
  await page
    .getByRole('group', { name: /Tickets already made from it stay as they are\.$/ })
    .getByRole('button', { name: `Delete template ${shared}` })
    .click();
  await expect(page.getByRole('button', { name: `Edit template ${shared}` })).toHaveCount(0);
});
