import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * Administration journeys for tracks and workflow maps (M1-053): a site administrator adds a
 * track, renames it, gives a role to a person and takes it back, archives and restores it;
 * makes a workflow map, gives a ticket type its own workflow, puts a track on the map and
 * deletes the map once no track uses it. No serious axe issue. They use the attachments
 * database (preview 4174), whose site administrator the API server made.
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
  await page.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  // Back to the default map, and then the map goes.
  await page.goto(`${BASE}/#/admin/tracks`);
  await page.getByRole('button', { name: `Manage track ${key}` }).click();
  await page.getByRole('combobox', { name: 'Workflow map' }).selectOption({ index: 0 });
  await expect(page.getByText(new RegExp(`Track ${key} uses .* now\\.`))).toBeVisible();
  await page.goto(`${BASE}/#/admin/workflow-maps`);
  await page.getByRole('button', { name: `Manage ${map}` }).click();
  await page.getByRole('button', { name: `Delete map ${map}` }).click();
  await page.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(page.getByText(`${map} was deleted.`)).toBeVisible();
});
