import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/**
 * The guided tutorial end to end (T-161; AGL-025; ADR-115), on a desktop and a phone: a new
 * person is offered the sections once at the top of Home and, after Not now, finds every section
 * in Settings, Tutorials instead. Another new person starts Dashboards from the offer and walks it
 * in the coach card: it waits for each real action (a dashboard made, then saved with a widget),
 * pauses on Escape, docks at the bottom of a phone, and ends as Done. No serious axe issue and no
 * sideways scroll. Each person is made for this run on the attachments database (preview 4174),
 * whose administrator (Ada Attach) the API server made.
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

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function ok<T>(answer: ReturnType<APIRequestContext['post']>): Promise<T> {
  const res = await answer;
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as T;
}

/** A person made for this run by the administrator, then signed in in this page's context. */
async function newPerson(page: Page, label: string, run: string) {
  const api = page.request;
  const person = {
    email: `${label}-${run}@tutorial.test`.toLowerCase(),
    name: `${label[0]?.toUpperCase()}${label.slice(1)} ${run}`,
    password: `walk-${randomBytes(18).toString('hex')}`,
  };
  await api.delete(`${BASE}/api/v1/session`);
  await ok(api.post(`${BASE}/api/v1/session`, { data: ADMIN }));
  await ok(api.post(`${BASE}/api/v1/users`, { data: person }));
  await api.delete(`${BASE}/api/v1/session`);
  await ok(api.post(`${BASE}/api/v1/session`, { data: person }));
  return person;
}

async function openHome(page: Page) {
  await page.goto('about:blank');
  await page.goto(`${BASE}/#/home`);
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

const runOf = (project: string) =>
  `${project.slice(0, 1)}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

test('[AGL-025] the first-run offer shows once, and every section stays in Settings, Tutorials', async ({
  page,
}, testInfo) => {
  const person = await newPerson(page, 'nora', runOf(testInfo.project.name));
  await openHome(page);
  const offer = page.getByRole('region', { name: `Welcome to Taskmoor, ${person.name}` });
  await expect(offer).toBeVisible();
  await expect(offer.getByRole('checkbox')).toHaveCount(5);
  await expect(offer.getByRole('checkbox', { checked: true })).toHaveCount(3);
  // In the page, not over it: Home stays usable around it.
  await expect(page.getByRole('region', { name: 'Your tracks' })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await noSidewaysScroll(page);

  await offer.getByRole('button', { name: 'Not now' }).click();
  const note = page.getByRole('status').filter({ hasText: 'Every tutorial waits' });
  await expect(note).toBeVisible();
  await expect(offer).toHaveCount(0);

  // Answered: the next visit shows no offer.
  await openHome(page);
  await expect(page.getByRole('region', { name: /^Welcome to Taskmoor/ })).toHaveCount(0);

  await page.goto(`${BASE}/#/settings/tutorials`);
  await expect(page.getByRole('heading', { level: 1, name: 'Tutorials' })).toBeVisible();
  for (const name of [
    'Tracks and tickets',
    'Boards and sprints',
    'Search and saved searches',
    'Dashboards',
    'Releases',
  ]) {
    await expect(page.getByRole('button', { name: `Start: ${name}` })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Start: Administration' })).toHaveCount(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await noSidewaysScroll(page);
});

test('[AGL-025] the Dashboards section, walked in the coach card from the offer to Done', async ({
  page,
  isMobile,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = runOf(testInfo.project.name);
  await newPerson(page, 'dara', run);
  await openHome(page);
  const offer = page.getByRole('region', { name: /^Welcome to Taskmoor/ });
  for (const name of ['Tracks and tickets', 'Boards and sprints', 'Search and saved searches']) {
    await offer.getByRole('checkbox', { name: `Learn ${name}` }).uncheck();
  }
  await offer.getByRole('checkbox', { name: 'Learn Dashboards' }).check();
  await offer.getByRole('button', { name: 'Start 1 section' }).click();

  const card = page.getByRole('dialog', { name: 'Dashboards' });
  await expect(card).toBeFocused();
  await expect(card.getByText('Dashboards · Step 1 of 6', { exact: true })).toBeVisible();
  if (isMobile) {
    // Docked at the bottom of a phone, across its width.
    const box = await card.boundingBox();
    const size = page.viewportSize();
    expect(box && size && Math.abs(box.y + box.height - size.height) <= 1).toBe(true);
    expect(box && size && box.x === 0 && Math.round(box.width) === size.width).toBe(true);
  }
  await card.getByRole('button', { name: 'Next' }).click();

  // Going to Dashboards: the person's own way there moves the tutorial on.
  const open = page.getByRole('dialog', { name: 'Open Dashboards' });
  await expect(open).toBeVisible();
  if (isMobile) {
    await open.getByRole('link', { name: 'Take me there' }).click();
  } else {
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Dashboards' })
      .click();
  }

  // It waits until the dashboard is made.
  const make = page.getByRole('dialog', { name: 'Make a dashboard' });
  await expect(make).toBeVisible();
  await expect(make.getByText(/moves on by itself/)).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await noSidewaysScroll(page);
  await page.getByLabel('New dashboard').fill(`Tour ${run}`);
  await page.getByRole('button', { name: 'Create dashboard' }).click();

  const edit = page.getByRole('dialog', { name: 'Edit it' });
  await expect(edit).toBeVisible();
  // Escape pauses and keeps the place; Resume comes back to it.
  await edit.focus();
  await page.keyboard.press('Escape');
  const paused = page.getByRole('region', { name: 'Tutorial paused: Dashboards, step 4 of 6' });
  await expect(paused).toBeVisible();
  await expect(edit).toHaveCount(0);
  await paused.getByRole('button', { name: 'Resume' }).click();
  await expect(edit).toBeFocused();

  const dashboard = page.getByRole('region', { name: `Tour ${run}` });
  await dashboard.getByRole('button', { name: 'Edit dashboard' }).click();
  const widget = page.getByRole('dialog', { name: 'Add a widget and save' });
  await expect(widget).toBeVisible();
  await dashboard
    .getByRole('combobox', { name: 'Widget to add' })
    .selectOption({ label: 'Search results' });
  await dashboard.getByRole('button', { name: 'Add widget' }).click();
  const settings = dashboard.getByRole('form', { name: 'Settings of Search results' });
  await settings.getByLabel('Query').fill(`summary ~ ${run}`);
  await settings.getByRole('button', { name: 'Apply' }).click();
  await dashboard.getByRole('button', { name: 'Save dashboard' }).click();

  const finish = page.getByRole('dialog', { name: 'Your dashboard is ready' });
  await expect(finish).toBeVisible();
  await expect(finish.getByRole('link', { name: 'Open what you made' })).toHaveAttribute(
    'href',
    /#\/dashboards\/\d+$/,
  );
  expect(await seriousAxeViolations(page)).toEqual([]);
  await noSidewaysScroll(page);
  // The end is saved in the background, as each step is. The page is left only once the server
  // has it: leaving sooner cancelled the request, and the section was not done (T-013a).
  const done = page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' &&
      r.url().endsWith('/api/v1/account/tutorial/dashboards') &&
      r.request().postDataJSON()?.state === 'done',
  );
  await finish.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await done).status()).toBe(200);

  // Saved with the account: Settings, Tutorials shows it done, to do again.
  await page.goto('about:blank');
  await page.goto(`${BASE}/#/settings/tutorials`);
  await expect(page.getByRole('button', { name: 'Do it again: Dashboards' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start: Tracks and tickets' })).toBeVisible();
});
