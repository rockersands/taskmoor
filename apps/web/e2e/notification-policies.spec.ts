import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import { uniqueKey, uniqueStamp } from './unique';

/**
 * Notification policies and email settings in the web app (T-155; NTF-001, NTF-002, NTF-004): a
 * site administrator adds a shared policy from the default's rules, gives an event the followers
 * and takes a rule away, renames it and deletes it; makes a local-mode track's own policy and has
 * the track use it; reads whether mail can go out and changes the batch window and the digest
 * hour, then puts them back. No serious axe issue. They use the attachments database (preview
 * 4174), whose site administrator the API server made, and which names no SMTP server.
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

async function signIn(page: Page) {
  const res = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(res.status()).toBe(200);
}

const fitsTheWindow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test('[NTF-001] the administrator adds a policy, changes its rules, renames and deletes it', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const name = `Payments ${uniqueStamp(testInfo)}`;
  await page.goto(`${BASE}/#/admin/notification-policies`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Notification policies' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage Default notifications' })).toBeVisible();

  await page.getByRole('button', { name: 'New policy' }).click();
  const add = page.getByRole('form', { name: 'Add policy' });
  await add.getByLabel('Policy name').fill(name);
  await expect(add.getByLabel('Start with')).toHaveValue(/\d+/);
  await add.getByRole('button', { name: 'Add policy' }).click();
  await expect(page.getByText(`Policy ${name} was added.`)).toBeVisible();

  // The new policy is open, with the default's rules: the followers hear of updates already.
  await expect(page.getByRole('heading', { name: `Who hears of what in ${name}` })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Ticket updated' }).getByText('The followers'),
  ).toBeVisible();
  const rule = page.getByRole('form', { name: `Add a rule to ${name}` });
  await rule.getByLabel('Event').selectOption({ label: 'Time logged' });
  await rule.getByLabel('Who hears of it').selectOption({ label: 'The people with a track role' });
  await rule.getByLabel('Track role').selectOption({ label: 'Members' });
  await rule.getByRole('button', { name: 'Add rule' }).click();
  await expect(
    page.getByText('Rule added for Time logged: People with the role Members.'),
  ).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await fitsTheWindow(page)).toBe(true);

  await page.getByRole('button', { name: 'Remove The requester from Ticket created' }).click();
  await expect(page.getByText('Rule removed for Ticket created: The requester.')).toBeVisible();
  await expect(page.getByRole('heading', { name: `Who hears of what in ${name}` })).toBeFocused();

  const details = page.getByRole('form', { name: `Name and description of ${name}` });
  await details.getByLabel('Description').fill('Payments hear of logged time.');
  await details.getByRole('button', { name: 'Save name and description' }).click();
  await expect(page.getByText(`${name} was saved.`)).toBeVisible();

  // The server kept what the page shows.
  await page.reload();
  await page.getByRole('button', { name: `Manage ${name}` }).click();
  await expect(
    page.getByRole('list', { name: 'Time logged' }).getByText('People with the role Members'),
  ).toBeVisible();
  await expect(
    page.getByRole('form', { name: `Name and description of ${name}` }).getByLabel('Description'),
  ).toHaveValue('Payments hear of logged time.');

  // Asks first, saying what will happen (D13).
  await page.getByRole('button', { name: `Delete ${name}` }).click();
  await page
    .getByRole('group', { name: /are deleted for good/ })
    .getByRole('button', { name: `Delete ${name}` })
    .click();
  await expect(page.getByText(`Policy ${name} was deleted.`)).toBeVisible();
  await expect(page.getByRole('button', { name: `Manage ${name}` })).toHaveCount(0);
});

test('[NTF-001] a local-mode track gets a policy of its own and uses it', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const key = uniqueKey('NP', testInfo);
  const track = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Night shift ${key}`, mode: 'local' },
  });
  expect(track.status(), await track.text()).toBe(201);
  const trackId = (await track.json()).track.id as number;

  // From the track's Manage page, its own configuration leads here.
  await page.goto(`${BASE}/#/manage/tracks/${trackId}`);
  await page
    .getByRole('link', { name: 'Notification policies: who hears of which changes in it' })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Notification policies' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: `Policies of ${key}` })).toBeVisible();
  await expect(page.getByText(`${key} uses a shared policy now.`, { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'New policy' }).click();
  const add = page.getByRole('form', { name: 'Add policy' });
  await add.getByLabel('Policy name').fill(`On call ${key}`);
  await add.getByRole('button', { name: 'Add policy' }).click();
  await expect(page.getByText(`Policy On call ${key} was added.`)).toBeVisible();
  const rule = page.getByRole('form', { name: `Add a rule to On call ${key}` });
  await rule.getByLabel('Event').selectOption({ label: 'Ticket created' });
  await rule.getByLabel('Who hears of it').selectOption({ label: 'The track owner' });
  await rule.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByText('Rule added for Ticket created: The track owner.')).toBeVisible();

  await page.getByRole('button', { name: `Use this policy for ${key}` }).click();
  await expect(page.getByText(`${key} now uses On call ${key}.`)).toBeVisible();
  await expect(page.getByText(`${key} uses On call ${key}.`)).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await fitsTheWindow(page)).toBe(true);
  const read = await page.request.get(`${BASE}/api/v1/tracks/${trackId}`);
  const used = (await read.json()).track.notificationPolicyId as number;
  const policy = await page.request.get(`${BASE}/api/v1/notification-policies/${used}`);
  expect((await policy.json()).notificationPolicy.name).toBe(`On call ${key}`);
});

test('[NTF-002] [NTF-004] the administrator sees whether mail can go out and changes its timing', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto(`${BASE}/#/admin/email`);
  await expect(page.getByRole('heading', { level: 1, name: 'Email' })).toBeVisible();
  const mail = page.getByRole('region', { name: 'Outgoing mail' });
  await expect(mail.getByText('Not set up')).toBeVisible();
  await expect(mail.getByText(/^Email waits unsent/)).toBeVisible();

  // The two projects run at once on one site: each sets a value of its own.
  const hour = testInfo.project.name === 'mobile' ? '06:00' : '07:00';
  const minutes = testInfo.project.name === 'mobile' ? '3' : '5';
  const form = page.getByRole('form', { name: 'When email goes out' });
  const window = form.getByRole('spinbutton', {
    name: 'Wait before emailing a ticket’s changes, in minutes',
  });
  await window.fill(minutes);
  await form.getByLabel('Digest hour').selectOption({ label: hour });
  await form.getByRole('button', { name: 'Save email settings' }).click();
  await expect(form.getByText('The email settings were saved.')).toBeVisible();
  const saved = await page.request.get(`${BASE}/api/v1/admin/email-settings`);
  expect((await saved.json()).emailSettings).toMatchObject({ smtpConfigured: false });
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await fitsTheWindow(page)).toBe(true);

  // Back to the defaults: two minutes, 08:00.
  await window.fill('2');
  await form.getByLabel('Digest hour').selectOption({ label: '08:00' });
  await form.getByRole('button', { name: 'Save email settings' }).click();
  await expect(form.getByText('The email settings were saved.')).toBeVisible();
});
