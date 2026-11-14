import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * Administration journeys for tracks and workflow maps (M1-053): a site administrator adds a
 * track, renames it, gives a role to a person and takes it back, archives and restores it;
 * makes a workflow map, gives a ticket type its own workflow, puts a track on the map and
 * deletes the map once no track uses it; adds a choice list, keeps its options and deletes it;
 * adds a role and an access policy, gives the role a permission and deletes both; gives a person
 * a global permission and takes it back; adds a type set and a field rule set, changes and
 * deletes them. No serious axe issue. They use the attachments
 * database (preview 4174), whose site administrator the API server made.
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

/** A track key of at most ten letters and digits, unique per project and run. */
function trackKey(project: string, prefix: string): string {
  return `${prefix}${project[0]?.toUpperCase()}${Date.now() % 10_000_000}`;
}

async function addTrack(page: Page, key: string, name: string) {
  await page.goto(`${BASE}/#/admin/tracks`);
  await expect(page.getByRole('heading', { level: 1, name: 'Tracks' })).toBeVisible();
  await page.getByRole('button', { name: 'New track' }).click();
  const form = page.getByRole('form', { name: 'Add a track' });
  await form.getByLabel('Key').fill(key);
  await form.getByLabel('Track name').fill(name);
  await form.getByRole('button', { name: 'Add a track' }).click();
  await expect(page.getByText(`Track ${key} was added.`)).toBeVisible();
}

test('[CORE-001] the administrator adds a track, gives a role, archives and restores it', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const key = trackKey(testInfo.project.name, 'T');
  await addTrack(page, key, `Payments ${testInfo.project.name}`);

  // The new track is open: rename it.
  const name = page.locator('.people-panel').getByLabel('Track name');
  await name.fill(`Payments team ${testInfo.project.name}`);
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByText(`Track ${key} was changed.`)).toBeVisible();

  // Ada becomes a viewer as well, then stops being one.
  await page
    .getByRole('combobox', { name: 'Role', exact: true })
    .selectOption({ label: 'Viewers' });
  await page.getByRole('searchbox', { name: 'Give the role to a person' }).fill('ada');
  await page.getByRole('button', { name: 'Add Ada Attach as Viewers' }).click();
  await expect(page.getByText('Ada Attach is Viewers now.')).toBeVisible();
  await expect(page.getByText('Ada Attach: Viewers')).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Remove Ada Attach as Viewers' }).click();
  await expect(page.getByText('Ada Attach is no longer Viewers.')).toBeVisible();

  await page.getByRole('button', { name: `Archive track ${key}` }).click();
  await page.getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByText(`Track ${key} was archived.`)).toBeVisible();
  const manage = page.getByRole('button', { name: `Manage track ${key}` });
  if ((await manage.getAttribute('aria-expanded')) !== 'true') await manage.click();
  await page.getByRole('button', { name: `Restore track ${key}` }).click();
  await page.getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByText(`Track ${key} was restored.`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('[WF-001] the administrator makes a workflow map, puts a track on it and deletes it', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const map = `Map ${testInfo.project.name} ${Date.now()}`;
  await page.goto(`${BASE}/#/admin/workflow-maps`);
  await expect(page.getByRole('heading', { level: 1, name: 'Workflow maps' })).toBeVisible();
  await page.getByRole('button', { name: 'New workflow map' }).click();
  const add = page.getByRole('form', { name: 'Add a workflow map' });
  await add.getByLabel('Map name').fill(map);
  await add.getByRole('button', { name: 'Add a workflow map' }).click();
  await expect(page.getByText(`${map} was added.`)).toBeVisible();

  // The new map is open: the first ticket type gets its own workflow.
  const editor = page.getByRole('form', { name: `Workflows in ${map}` });
  const types = editor.getByRole('combobox', { name: 'Give a type its own workflow' });
  const type = (await types.locator('option:not([value=""])').first().textContent()) ?? '';
  await types.selectOption({ label: type });
  await editor.getByRole('button', { name: 'Add' }).click();
  await expect(editor.getByRole('combobox', { name: `${type} follows` })).toBeVisible();
  await editor.getByRole('button', { name: 'Save the map' }).click();
  await expect(page.getByText(`${map} was saved.`)).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);

  // A new track goes on the map; the map cannot go while the track uses it.
  const key = trackKey(testInfo.project.name, 'M');
  await addTrack(page, key, `Mapped ${testInfo.project.name}`);
  await page.getByRole('combobox', { name: 'Workflow map' }).selectOption({ label: map });
  await expect(page.getByText(`Track ${key} uses ${map} now.`)).toBeVisible();
  await page.goto(`${BASE}/#/admin/workflow-maps`);
  await page.getByRole('button', { name: `Manage ${map}` }).click();
  await page.getByRole('button', { name: `Delete map ${map}` }).click();
  // Asks first, saying what will happen (D13); the answer names what goes.
  await page
    .getByRole('group', { name: /^Delete / })
    .getByRole('button', { name: `Delete map ${map}` })
    .click();
  await expect(page.getByRole('alert')).toBeVisible();

  // Back to the default map, and then the map goes.
  await page.goto(`${BASE}/#/admin/tracks`);
  await page.getByRole('button', { name: `Manage track ${key}` }).click();
  await page.getByRole('combobox', { name: 'Workflow map' }).selectOption({ index: 0 });
  await expect(page.getByText(new RegExp(`Track ${key} uses .* now\\.`))).toBeVisible();
  await page.goto(`${BASE}/#/admin/workflow-maps`);
  await page.getByRole('button', { name: `Manage ${map}` }).click();
  await page.getByRole('button', { name: `Delete map ${map}` }).click();
  // Asks first, saying what will happen (D13); the answer names what goes.
  await page
    .getByRole('group', { name: /^Delete / })
    .getByRole('button', { name: `Delete map ${map}` })
    .click();
  await expect(page.getByText(`${map} was deleted.`)).toBeVisible();
});

test('[CORE-009] the administrator adds a choice list, keeps its options and deletes it', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const field = `Region ${testInfo.project.name} ${Date.now()}`;
  await page.goto(`${BASE}/#/admin/fields`);
  await expect(page.getByRole('heading', { level: 1, name: 'Fields' })).toBeVisible();
  await page.getByRole('button', { name: 'New field' }).click();
  const add = page.getByRole('form', { name: 'Add a field' });
  await add.getByLabel('Field name').fill(field);
  await add.getByLabel('Type').selectOption('select');
  await add.getByLabel('Holds several values').check();
  await add.getByRole('button', { name: 'Add a field' }).click();
  await expect(page.getByText(`${field} was added.`)).toBeVisible();

  // The new field is open: two options, one renamed, the other no longer offered.
  const options = page.getByRole('form', { name: /^Add an option to / });
  for (const value of ['North', 'South']) {
    await options.getByLabel('New option').fill(value);
    await options.getByRole('button', { name: 'Add the option' }).click();
    await expect(page.getByText(`${value} was added.`)).toBeVisible();
  }
  await page.getByRole('button', { name: 'Rename North' }).click();
  await page.getByLabel('New name for North').fill('North east');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('The option is called North east now.')).toBeVisible();
  await page.getByRole('button', { name: 'Stop offering South' }).click();
  await expect(page.getByText('South is no longer offered.')).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Delete North east' }).click();
  await expect(page.getByText('North east was deleted.')).toBeVisible();

  await page.getByRole('button', { name: `Delete field ${field}` }).click();
  // Asks first, saying what will happen (D13); the answer names what goes.
  await page
    .getByRole('group', { name: /^Delete / })
    .getByRole('button', { name: `Delete field ${field}` })
    .click();
  await expect(page.getByText(`${field} was deleted.`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('[IAM-010] the administrator adds a role and a policy, grants, and deletes them', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const suffix = `${testInfo.project.name} ${Date.now()}`;
  const role = `Reviewers ${suffix}`;
  const policy = `Partners ${suffix}`;
  await page.goto(`${BASE}/#/admin/permissions`);
  await expect(page.getByRole('heading', { level: 1, name: 'Permissions' })).toBeVisible();
  // Each list comes first; its New button opens the form (D11).
  await page.getByRole('button', { name: 'New role' }).click();
  const addRole = page.getByRole('form', { name: 'Add a role' });
  await addRole.getByLabel('Role name').fill(role);
  await addRole.getByRole('button', { name: 'Add a role' }).click();
  await expect(page.getByText(`Role ${role} was added.`)).toBeVisible();

  await page.getByRole('button', { name: 'New access policy' }).click();
  const addPolicy = page.getByRole('form', { name: 'Add an access policy' });
  await addPolicy.getByLabel('Policy name').fill(policy);
  await addPolicy.getByLabel('Start from').selectOption({ label: 'Default access policy' });
  await addPolicy.getByRole('button', { name: 'Add an access policy' }).click();
  await expect(page.getByText(`${policy} was added.`)).toBeVisible();

  // The new policy is open, with the default's grants: the role may edit tickets too. Its form
  // opens from its New button, as Global permissions' does (D11).
  await page.getByRole('button', { name: `New permission in ${policy}` }).click();
  const give = page.getByRole('form', { name: `Give a permission in ${policy}` });
  await give.getByLabel('Permission').selectOption({ label: 'Edit tickets' });
  await give.getByLabel('Role', { exact: true }).selectOption({ label: role });
  await give.getByRole('button', { name: 'Give' }).click();
  await expect(page.getByText(`Edit tickets was given to Role ${role}.`)).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);

  // A role a policy uses stays; once the grant goes, both go.
  // Deleting asks first, as every destructive action does (D13); a refusal keeps the question.
  await page.getByRole('button', { name: `Delete role ${role}` }).click();
  const askRole = page.getByRole('group', { name: `Delete the role ${role}?` });
  await expect(askRole.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await askRole.getByRole('button', { name: `Delete role ${role}` }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Access policies or tracks still use this role: take it out of them first.',
  );
  await askRole.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: `Delete role ${role}` })).toBeFocused();
  await page.getByRole('button', { name: `Remove Role ${role} from Edit tickets` }).click();
  await expect(page.getByText(`Role ${role} no longer has Edit tickets.`)).toBeVisible();
  await page.getByRole('button', { name: `Delete policy ${policy}` }).click();
  await page
    .getByRole('group', { name: `Delete the access policy ${policy}?` })
    .getByRole('button', { name: `Delete policy ${policy}` })
    .click();
  await expect(page.getByText(`${policy} was deleted.`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Access policies' })).toBeFocused();
  await page.getByRole('button', { name: `Delete role ${role}` }).click();
  await askRole.getByRole('button', { name: `Delete role ${role}` }).click();
  await expect(page.getByText(`Role ${role} was deleted.`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Roles', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('[IAM-011] the administrator gives a person a global permission and takes it back', async ({
  page,
}, testInfo) => {
  await signIn(page);
  // One permission per project, so the two runs never give the same grant at once.
  const permission =
    testInfo.project.name === 'mobile' ? 'Subscribe groups to searches' : 'Share saved searches';
  await page.goto(`${BASE}/#/admin/permissions`);
  await page.getByRole('button', { name: 'New global permission' }).click();
  const give = page.getByRole('form', { name: 'Give a global permission' });
  await give.getByLabel('Permission').selectOption({ label: permission });
  await give.getByLabel('To').selectOption({ label: 'A person' });
  await give.getByRole('searchbox', { name: 'Find a person' }).fill('ada');
  await expect(give.getByLabel('Person', { exact: true })).toHaveValue(/\d+/);
  await give.getByRole('button', { name: 'Give' }).click();
  await expect(page.getByText(`${permission} was given to Ada Attach.`)).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: `Remove Ada Attach from ${permission}` }).click();
  await expect(page.getByText(`Ada Attach no longer has ${permission}.`)).toBeVisible();
});

test('[CORE-008] the administrator adds a type set and a field rule set, changes and deletes them', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const suffix = `${testInfo.project.name} ${Date.now()}`;
  const types = `Support types ${suffix}`;
  const rules = `Support rules ${suffix}`;
  await page.goto(`${BASE}/#/admin/configuration-sets`);
  await expect(page.getByRole('heading', { level: 1, name: 'Configuration sets' })).toBeVisible();

  // Each list comes first; its New button opens the form (D11).
  await page.getByRole('button', { name: 'New type set' }).click();
  const addTypes = page.getByRole('form', { name: 'Add a type set' });
  await addTypes.getByLabel('Type set name').fill(types);
  const boxes = addTypes.getByRole('checkbox');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await addTypes.getByRole('button', { name: 'Add a type set' }).click();
  await expect(page.getByText(`${types} was added.`)).toBeVisible();
  const typePanel = page.getByRole('form', { name: `Settings of ${types}` });
  await typePanel.getByRole('checkbox').nth(1).uncheck();
  await typePanel.getByRole('button', { name: 'Save the set' }).click();
  await expect(page.getByText(`${types} was saved.`)).toBeVisible();
  await typePanel.getByRole('button', { name: `Delete set ${types}` }).click();
  // Asks first, saying what will happen (D13); the answer names what goes.
  await page
    .getByRole('group', { name: /^Delete / })
    .getByRole('button', { name: `Delete set ${types}` })
    .click();
  await expect(page.getByText(`${types} was deleted.`)).toBeVisible();

  await page.getByRole('button', { name: 'New field rule set' }).click();
  const addRules = page.getByRole('form', { name: 'Add a field rule set' });
  await addRules.getByLabel('Rule set name').fill(rules);
  await addRules.getByRole('button', { name: 'Add a field rule set' }).click();
  await expect(page.getByText(`${rules} was added.`)).toBeVisible();
  const rulePanel = page.getByRole('form', { name: `Settings of ${rules}` });
  await rulePanel.getByRole('group', { name: 'Priority' }).getByLabel('Required').check();
  await rulePanel
    .getByRole('group', { name: 'Due date' })
    .getByLabel('Help text')
    .fill('When it must be done');
  await rulePanel.getByRole('button', { name: 'Save the set' }).click();
  await expect(page.getByText(`${rules} was saved.`)).toBeVisible();
  await expect(
    rulePanel.getByRole('group', { name: 'Priority' }).getByLabel('Hidden'),
  ).toBeDisabled();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await rulePanel.getByRole('button', { name: `Delete set ${rules}` }).click();
  // Asks first, saying what will happen (D13); the answer names what goes.
  await page
    .getByRole('group', { name: /^Delete / })
    .getByRole('button', { name: `Delete set ${rules}` })
    .click();
  await expect(page.getByText(`${rules} was deleted.`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
