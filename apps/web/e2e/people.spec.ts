import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * Administration journeys for people and groups (M1-053, IAM-008): a site administrator adds a
 * person and gets their one-time link, deactivates and reactivates them; makes a group, adds
 * the person, nests another group, refuses a loop and deletes the group. No serious axe issue.
 * They use the attachments database (preview 4174), whose site administrator the API server
 * made.
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

test('[IAM-008] the administrator adds a person, sees their link, deactivates and reactivates them', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const name = `Mo Chen ${testInfo.project.name}`;
  const email = `mo.${testInfo.project.name}.${Date.now()}@people.test`;
  await page.goto(`${BASE}/#/admin/users`);
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
  await page.getByRole('button', { name: 'Add a person' }).click();
  const form = page.getByRole('form', { name: 'Add a person' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Email').fill(email);
  await form.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText(`${name} was added.`)).toBeVisible();
  const link = page.getByRole('textbox', { name: `Link for ${name}` });
  await expect(link).toHaveValue(/#\/password\?/);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('searchbox', { name: 'Find by name or email' }).fill(email);
  await page.getByRole('button', { name: `Deactivate ${name}` }).click();
  await expect(page.getByText(`${name} was deactivated and signed out everywhere.`)).toBeVisible();
  await page.getByRole('combobox', { name: 'Show' }).selectOption('all');
  await page.getByRole('button', { name: `Reactivate ${name}` }).click();
  await expect(page.getByText(`${name} was reactivated.`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('[IAM-008] the administrator makes a group, adds a person, nests a group and deletes it', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const outer = `Payments ${suffix}`;
  const inner = `Refunds ${suffix}`;
  await page.goto(`${BASE}/#/admin/groups`);
  await expect(page.getByRole('heading', { level: 1, name: 'Groups' })).toBeVisible();
  const add = page.getByRole('form', { name: 'Add a group' });
  await add.getByLabel('Group name').fill(inner);
  await add.getByRole('button', { name: 'Add a group' }).click();
  await expect(page.getByText(`${inner} was added.`)).toBeVisible();
  await add.getByLabel('Group name').fill(outer);
  await add.getByRole('button', { name: 'Add a group' }).click();
  await expect(page.getByText(`${outer} was added.`)).toBeVisible();

  // The new group is open: Ada joins it, and the inner group goes inside it.
  await expect(page.getByText(`Members of ${outer}`)).toBeVisible();
  await page.getByRole('searchbox', { name: 'Add a person' }).fill('ada');
  await page.getByRole('button', { name: `Add Ada Attach to ${outer}` }).click();
  await expect(page.getByText(`Ada Attach is in ${outer} now.`)).toBeVisible();
  await page.getByRole('combobox', { name: 'Put a group inside' }).selectOption({ label: inner });
  await page.locator('.people-inline').getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText(`${inner} is inside ${outer} now.`)).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);

  // The outer group inside the inner one would be a loop.
  await page.getByRole('button', { name: `Manage ${outer}` }).click();
  await page.getByRole('button', { name: `Manage ${inner}` }).click();
  await page.getByRole('combobox', { name: 'Put a group inside' }).selectOption({ label: outer });
  await page.locator('.people-inline').getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('alert')).toHaveText('That would put a group inside itself.');

  // Delete both.
  for (const name of [outer, inner]) {
    const manage = page.getByRole('button', { name: `Manage ${name}` });
    if ((await manage.getAttribute('aria-expanded')) !== 'true') await manage.click();
    await page.getByRole('button', { name: `Delete group ${name}` }).click();
    await page.getByRole('button', { name: 'Yes, delete' }).click();
    await expect(page.getByText(`${name} was deleted.`)).toBeVisible();
  }
});

test('[IAM-008] ASVS 8.3.2: a person downloads their own data, and the administrator erases a person', async ({
  page,
}, testInfo) => {
  await signIn(page);
  // The administrator's own data: asked for on the account page, made by the worker.
  await page.goto(`${BASE}/#/account/data`);
  const data = page.getByRole('region', { name: 'Your data' });
  await data.getByRole('button', { name: 'Prepare a download' }).click();
  await expect(data.getByRole('status')).toHaveText(/being prepared/);
  const link = data.getByRole('link', { name: /Download the data asked for/ }).first();
  await expect(link).toBeVisible({ timeout: 30_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toMatch(
    /^taskmoor-personal-data-\d+-\d{4}-\d{2}-\d{2}\.zip$/,
  );
  expect(await seriousAxeViolations(page)).toEqual([]);

  // Someone added and then erased, confirmed by typing their email.
  const name = `Erin Vale ${testInfo.project.name}`;
  const email = `erin.${testInfo.project.name}.${Date.now()}@people.test`;
  await page.goto(`${BASE}/#/admin/users`);
  await page.getByRole('button', { name: 'Add a person' }).click();
  const form = page.getByRole('form', { name: 'Add a person' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Email').fill(email);
  await form.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText(`${name} was added.`)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('searchbox', { name: 'Find by name or email' }).fill(email);
  await page.getByRole('button', { name: `Erase ${name}` }).click();
  const erase = page.getByRole('form', { name: `Erase ${name}` });
  await expect(erase.getByRole('button', { name: 'Erase permanently' })).toBeDisabled();
  await erase.getByLabel(`Type ${email} to confirm`).fill(email);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await erase.getByRole('button', { name: 'Erase permanently' }).click();
  await expect(
    page.getByText(/The person was erased; they are Former user \d+ from now on\./),
  ).toBeVisible();
  // Their email finds nobody any more.
  await page.getByRole('combobox', { name: 'Show' }).selectOption('all');
  await expect(page.getByText('Nobody matches.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
