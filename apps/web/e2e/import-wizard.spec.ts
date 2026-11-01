import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The import wizard on the 10,000-issue synthetic Data Center backup (M1-097; IMP-013, IMP-007,
 * IMP-009, IMP-010), against the instance web-server.ts serves on 4185 with its own imports
 * folder and import worker: a site administrator opens Settings > Imports, uploads the backup,
 * chooses configuration and tickets, runs a dry run, maps a person of the backup to themselves,
 * imports, reads the report, then runs a delta from that import with the same backup, which
 * finds nothing changed. web-server.ts generates the backup once and keeps it in `.cache/e2e`.
 */
const BASE = 'http://localhost:4185';
const ADMIN = 'iris@imports.test';
const ISSUES = 10_000;
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BACKUP = join(ROOT, '.cache', 'e2e', `dc-backup-${ISSUES}-seed97.zip`);

async function signIn(page: Page) {
  await page.goto(`${BASE}/#/sign-in`);
  await page.getByLabel('Email').fill(ADMIN);
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.TASKMOOR_E2E_IMPORT_PASSWORD as string);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/#/home`);
}

/** The row of a kind in the report's table, as its cells' texts. */
async function kindRow(scope: Locator, kind: string) {
  const row = scope.getByRole('row', { name: new RegExp(`^${kind} `) }).first();
  await expect(row).toBeVisible();
  return row.getByRole('cell').allTextContents();
}

test('[IMP-013] a backup of 10,000 issues: upload, dry run, people, import, report, delta', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'one imports instance: the desktop project imports',
  );
  test.setTimeout(8 * 60_000);
  await signIn(page);
  await page.goto(`${BASE}/#/settings`);
  await page.getByRole('link', { name: 'Imports' }).click();
  await expect(page.getByRole('heading', { name: 'Imports', level: 1 })).toBeVisible();

  const wizard = page.getByRole('form', { name: 'New import' });
  await wizard.getByLabel('Upload a file into the folder').setInputFiles(BACKUP);
  await wizard.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(wizard.getByRole('status')).toHaveText(
    `dc-backup-${ISSUES}-seed97.zip is in the imports folder.`,
  );
  await expect(wizard.getByRole('combobox', { name: 'File in the imports folder' })).toHaveValue(
    `dc-backup-${ISSUES}-seed97.zip`,
  );
  await wizard.getByRole('radio', { name: /^Configuration and tickets/ }).check();
  await wizard.getByRole('textbox', { name: 'Name of the import' }).fill('Ten thousand issues');

  // The dry run: its report, and the backup's people.
  await wizard.getByRole('button', { name: 'Dry run' }).click();
  const dry = page.getByRole('region', { name: /^Report of import 1$/ });
  await expect(dry).toContainText(/A dry run: [\d,]+ records read, 0 would fail/, {
    timeout: 180_000,
  });
  expect((await kindRow(dry, 'Tickets')).slice(0, 2)).toEqual(['10,000', '10,000']);
  const people = page.getByRole('group', { name: '3. People' });
  const first = people.getByRole('textbox').first();
  const label = (await first.getAttribute('id')) ?? '';
  const name = (await page.locator(`label[for="${label}"]`).textContent())?.replace(
    'Taskmoor person for ',
    '',
  );
  expect(name).toBeTruthy();
  await first.fill(ADMIN);

  // The import itself.
  await wizard.getByRole('button', { name: 'Import' }).click();
  const report = page.getByRole('region', { name: /^Report of import 2$/ });
  await expect(report).toContainText(/[\d,]+ records read, [\d,]+ in Taskmoor now, 0 failed/, {
    timeout: 300_000,
  });
  expect((await kindRow(report, 'Tickets')).slice(0, 2)).toEqual(['10,000', '10,000']);
  // The mapped person is linked to the administrator, and warnings say what their codes mean.
  await report.getByText(/^Mapping of the configuration/).click();
  await expect(report.getByText(`People ${name}: Linked`)).toBeVisible();
  await expect(report.getByRole('link', { name: 'Download the report as a page' })).toHaveAttribute(
    'href',
    /\/api\/v1\/admin\/imports\/2\/report\?format=html$/,
  );
  const page2 = await page.request.get(`${BASE}/api/v1/admin/imports/2/report?format=html`);
  expect(page2.ok()).toBe(true);
  // The tickets are there.
  const search = await page.request.get(
    `${BASE}/api/v1/search?q=${encodeURIComponent('ORDER BY key ASC')}&limit=1`,
  );
  expect(search.ok()).toBe(true);

  // A delta run from the import, with the same backup: nothing changed.
  await page.getByRole('button', { name: 'Delta run from import 2' }).click();
  const delta = page.getByRole('form', { name: 'Delta run from import 2' });
  await delta
    .getByRole('combobox', { name: 'File in the imports folder' })
    .selectOption(`dc-backup-${ISSUES}-seed97.zip`);
  await delta.getByRole('radio', { name: /^Configuration and tickets/ }).check();
  await delta.getByRole('button', { name: 'Import' }).click();
  const again = page.getByRole('region', { name: /^Report of import 3$/ });
  await expect(again).toContainText(/A delta run from import 2: 0 records/, { timeout: 300_000 });
  const tickets = await kindRow(again, 'Tickets');
  // Read, created, updated, unchanged.
  expect(tickets.slice(0, 4)).toEqual(['10,000', '0', '0', '10,000']);
});

test('[IMP-013] the imports page works on a phone', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'the phone layout');
  await signIn(page);
  await page.goto(`${BASE}/#/admin/imports`);
  await expect(page.getByRole('form', { name: 'New import' })).toBeVisible();
  await page.getByRole('radio', { name: 'Jira Cloud site' }).check();
  await expect(page.getByLabel('API token')).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
});
