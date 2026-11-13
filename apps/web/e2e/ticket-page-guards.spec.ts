import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * The full ticket page guards what people do (T-190, T-191), on tracks of their own: unsaved text
 * asks before a link inside the app or Back takes it away, a reload gets the browser's own
 * question only while there is some, a subticket's saved summary is no such text, and a person
 * sees edit controls only for the fields they may change, after an edit too (here a field rule
 * keeps three of them to a group they are not in). Desktop and
 * phone, no serious axe issue and no sideways scroll. It uses the attachments database (preview
 * 4174), whose administrator (Ada Attach) the API server made.
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

/** Signed in as Ada, with a way to call the API that fails the test on a refusal. */
async function signedIn(page: Page) {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  return async (method: 'post' | 'patch' | 'get', path: string, data?: unknown) => {
    const res = await page.request[method](`${BASE}/api/v1${path}`, data ? { data } : {});
    expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
    return res.json();
  };
}

const trackKey = (prefix: string, projectName: string) =>
  `${prefix}${projectName.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-6)}`;

const sidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('[NFR-005] the full ticket page asks before unsaved text goes: a link, Back, a reload', async ({
  page,
}, testInfo) => {
  const api = await signedIn(page);
  const key = trackKey('D', testInfo.project.name);
  await api('post', '/tracks', { key, name: `Drafts ${key}`, mode: 'shared' });
  const { ticket } = await api('post', '/tickets', { track: key, summary: 'Half done' });
  const { board } = await api('get', `/tracks/${key}/board`);

  // From the board to the pop-up, then to the full page, which leads back to the board.
  await page.goto(`${BASE}/#/tracks/${key}/board`);
  // The track's board is titled by its section (D26); the way back still names the board.
  const onBoard = page.getByRole('region', { name: 'Board', exact: true });
  await onBoard.getByRole('link', { name: new RegExp(`^${ticket.key} `) }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const address = `${BASE}/#/tickets/${ticket.key}`;
  await expect(page).toHaveURL(address);
  const title = page.getByRole('heading', { level: 1 });
  await expect(title).toHaveText(`${ticket.key} Half done`);

  const details = page.getByRole('region', { name: 'Details' });
  await details.getByRole('button', { name: 'Edit labels' }).click();
  const labels = details.getByRole('textbox', { name: 'Labels' });
  await labels.fill('half-typed');
  const asked = page.getByRole('alertdialog', { name: 'Discard what you have not saved?' });
  const backToBoard = page.getByRole('link', { name: `Back to ${board.name}` });

  // A link inside the app asks first; keeping the text loses nothing.
  await backToBoard.click();
  await expect(asked).toBeVisible();
  await expect(asked.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await asked.getByRole('button', { name: 'Keep editing' }).click();
  await expect(asked).toBeHidden();
  await expect(labels).toHaveValue('half-typed');
  await expect(page).toHaveURL(address);

  // Back asks too, and the page stays until told.
  await page.goBack();
  await expect(asked).toBeVisible();
  await expect(page).toHaveURL(address);
  await asked.getByRole('button', { name: 'Keep editing' }).click();
  await expect(labels).toHaveValue('half-typed');

  // A reload gets the browser's own question while the text is there, and none after.
  const questions: string[] = [];
  page.on('dialog', (dialog) => {
    questions.push(dialog.type());
    void dialog.accept();
  });
  await page.reload();
  await expect(title).toHaveText(`${ticket.key} Half done`);
  expect(questions).toEqual(['beforeunload']);
  await page.reload();
  await expect(title).toHaveText(`${ticket.key} Half done`);
  expect(questions).toEqual(['beforeunload']);

  // Discarding leaves by the link.
  await details.getByRole('button', { name: 'Edit labels' }).click();
  await labels.fill('again');
  await backToBoard.click();
  await asked.getByRole('button', { name: 'Discard it' }).click();
  await expect(page).toHaveURL(new RegExp(`#/boards/${board.id}`));
  await expect(onBoard).toBeVisible();
  expect(questions).toEqual(['beforeunload']);

  // Add and open saves the subticket's summary, so the page goes to it without asking.
  await page.goto(address);
  await expect(title).toHaveText(`${ticket.key} Half done`);
  const subtickets = page.getByRole('region', { name: 'Subtickets' });
  await subtickets.getByRole('textbox', { name: 'New subticket' }).fill('Write the tests');
  await subtickets.getByRole('button', { name: 'Add and open' }).click();
  await expect(title).toHaveText(new RegExp(`^${key}-\\d+ Write the tests$`));
  await expect(page).toHaveURL(new RegExp(`#/tickets/${key}-\\d+$`));
  await expect(asked).toHaveCount(0);
  expect(questions).toEqual(['beforeunload']);
});

test('[IAM-010] [WF-007] the ticket page offers controls only for the fields the person may change', async ({
  page,
  isMobile,
}, testInfo) => {
  const api = await signedIn(page);
  const key = trackKey('F', testInfo.project.name);
  const { track } = await api('post', '/tracks', { key, name: `Fields ${key}`, mode: 'shared' });
  const { group } = await api('post', '/groups', { name: `Approvers ${key}` });
  const { fieldRuleSet } = await api('post', '/field-rule-sets', {
    name: `Approvers decide ${key}`,
    rules: ['priority', 'startDate', 'assignee'].map((field) => ({
      field,
      editableBy: [{ groupId: group.id }],
    })),
  });
  await api('patch', `/tracks/${track.id}`, { fieldRuleSetId: fieldRuleSet.id });
  const { ticket } = await api('post', '/tickets', { track: key, summary: 'Partly locked' });

  await page.goto(`${BASE}/#/tickets/${ticket.key}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${ticket.key} Partly locked`);
  const details = page.getByRole('region', { name: 'Details' });
  // Controls for what Ada may change.
  const editLabels = details.getByRole('button', { name: 'Edit labels' });
  await expect(editLabels).toBeVisible();
  await expect(details.getByLabel('Due date')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit summary' })).toBeVisible();
  // Values, and no control, for what the rule keeps to the approvers.
  await expect(details.getByText(ticket.priority.name, { exact: true })).toBeVisible();
  await expect(details.getByRole('combobox', { name: 'Priority' })).toHaveCount(0);
  await expect(details.getByLabel('Start date')).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'Assign to me' })).toHaveCount(0);
  await page.keyboard.press('a');
  await expect(details.getByRole('button', { name: 'Unassign' })).toHaveCount(0);

  // What is offered works, and the edit's answer says what Ada may change, as reading did: the
  // same controls stay, and none comes back for the fields the rule keeps.
  await details.getByLabel('Due date').fill('2026-12-01');
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(details.getByLabel('Due date')).toHaveValue('2026-12-01');
  await expect(editLabels).toBeVisible();
  await expect(details.getByRole('combobox', { name: 'Priority' })).toHaveCount(0);
  await expect(details.getByLabel('Start date')).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'Assign to me' })).toHaveCount(0);
  if (isMobile) {
    expect((await editLabels.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  expect(await sidewaysScroll(page)).toBeLessThanOrEqual(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
});
