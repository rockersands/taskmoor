import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { uniqueKey, uniqueStamp } from './unique';

/**
 * A track's own layout sets and configuration sets, for someone who runs the track (T-163a;
 * ADR-114 section 8; CORE-008, CORE-013, IAM-030): a person who is no administrator runs MINE, a
 * track with its own configuration, and is not in THEIRS, another. From MINE's Manage page they
 * reach its layout sets, add one, place fields with the keyboard path of each grip, see the
 * preview in MINE alone, save, and make MINE use the set; then add a field rule set and make MINE
 * use it. The shared page offers them only MINE; THEIRS's page refuses them, and the server
 * refuses every change to a shared set or to THEIRS's. No serious axe issue and no sideways
 * scroll, on a desktop and a phone. It uses the attachments database (preview 4174), whose site
 * administrator the API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
const PASSWORD = 'ladder violet harbour lantern';

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

/** What reaches past the right of the window, so a failure names it; empty when nothing does. */
const sideways = (page: Page) =>
  page.evaluate(() => {
    if (document.documentElement.scrollWidth <= innerWidth) return [];
    return [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5)
      .filter(
        (el) => ![...el.children].some((c) => c.getBoundingClientRect().right > innerWidth + 0.5),
      )
      .slice(0, 8)
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
  });

async function ok<T>(answer: ReturnType<APIRequestContext['post']>): Promise<T> {
  const res = await answer;
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as T;
}

async function signInAs(api: APIRequestContext, email: string, password: string) {
  await api.delete(`${BASE}/api/v1/session`);
  await ok(api.post(`${BASE}/api/v1/session`, { data: { email, password } }));
}

/**
 * Opens a page of the app afresh: after a change of who is signed in, a hash change alone would
 * keep the session the app read when it loaded.
 */
async function visit(page: Page, hash: string) {
  await page.goto('about:blank');
  await page.goto(`${BASE}/${hash}`);
}

const MAIN = 'Details, section 1: main column';

/**
 * The select of sets, by role: a bare getByLabel('Layout set') also finds the page's own section,
 * which its heading "Layout sets" names, and so every option on the page.
 */
const setPicker = (page: Page) => page.getByRole('combobox', { name: 'Layout set', exact: true });

test('[CORE-013] [IAM-030] someone who runs a track arranges its own forms and rules, and only its own', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const stamp = uniqueStamp(testInfo);
  const keys = { mine: uniqueKey('LM', testInfo), theirs: uniqueKey('LT', testInfo) };
  const api = page.request;

  // A site administrator makes two tracks with their own configuration, a person who runs only
  // the first, a layout set of the second's own, and finds the shared default set.
  await signInAs(api, ADMIN.email, ADMIN.password as string);
  const made = async (key: string, name: string) =>
    (
      await ok<{ track: { id: number } }>(
        api.post(`${BASE}/api/v1/tracks`, {
          data: { key, name, mode: 'local', type: 'business' },
        }),
      )
    ).track.id;
  const mine = await made(keys.mine, 'Forms we run');
  const theirs = await made(keys.theirs, 'Forms elsewhere');
  const email = `runner.${stamp}@layouts.test`.toLowerCase();
  const runner = await ok<{ user: { id: number } }>(
    api.post(`${BASE}/api/v1/users`, {
      data: { email, name: `Runner ${stamp}`, password: PASSWORD },
    }),
  );
  const roles = (await (await api.get(`${BASE}/api/v1/roles`)).json()).roles as {
    id: number;
    name: string;
  }[];
  const administrators = roles.find((r) => r.name === 'Administrators')?.id as number;
  const appointed = await api.put(
    `${BASE}/api/v1/tracks/${mine}/roles/${administrators}/users/${runner.user.id}`,
  );
  expect(appointed.status()).toBe(204);
  const elsewhere = await ok<{ layoutSet: { id: number } }>(
    api.post(`${BASE}/api/v1/layout-sets`, {
      data: { name: `Elsewhere ${stamp}`, trackId: theirs },
    }),
  );
  const shared = (
    (await (await api.get(`${BASE}/api/v1/layout-sets`)).json()).layoutSets as {
      id: number;
      name: string;
      isDefault: boolean;
    }[]
  ).find((s) => s.isDefault) as { id: number; name: string };

  // The person signs in. Their track's Manage page leads to its own layout sets.
  await signInAs(api, email, PASSWORD);
  await visit(page, `#/manage/tracks/${mine}`);
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(keys.mine) })).toBeVisible();
  const own = page.getByRole('region', { name: 'Its own configuration' });
  await own.getByRole('link', { name: 'Layout sets: where fields appear on its forms' }).click();
  await expect(page).toHaveURL(new RegExp(`/manage/tracks/${mine}/layouts$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Layout sets' })).toBeVisible();
  await expect(page.getByText(`${keys.mine} · Forms we run`, { exact: true })).toBeVisible();
  await expect(
    page.getByText(`${keys.mine} has no layout set of its own yet`, { exact: false }),
  ).toBeVisible();

  // A set of the track's own: the only one on the page.
  const name = `Ours ${stamp}`;
  await page.getByRole('button', { name: 'New layout set' }).click();
  const add = page.getByRole('form', { name: 'Add a layout set' });
  await add.getByLabel('New set name').fill(name);
  await add.getByRole('button', { name: 'Add a layout set' }).click();
  await expect(page.getByText(`${name} was added.`)).toBeVisible();
  const editor = page.getByRole('form', { name: `Layouts of ${name}` });
  await expect(setPicker(page).locator('option')).toHaveText([name]);
  await expect(page.getByText(shared.name)).toHaveCount(0);
  await expect(page.getByText(`Elsewhere ${stamp}`)).toHaveCount(0);

  // Fields placed by the keyboard path of each grip.
  await editor.getByRole('button', { name: 'Make a layout for this form' }).click();
  for (const field of ['Description', 'Summary']) {
    await editor.getByRole('button', { name: `Place ${field}` }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: `Put in ${MAIN}` })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(editor.getByRole('button', { name: `Move ${field}` })).toBeFocused();
  }
  // The preview is of this track alone, and follows the draft.
  const preview = editor.getByRole('region', { name: 'Preview' });
  await expect(
    preview.getByText(
      `With the fields and rules of ${keys.mine} · Forms we run, the track this set belongs to.`,
    ),
  ).toBeVisible();
  await expect(preview.getByLabel('Fields and rules of')).toHaveCount(0);
  await expect
    .poll(() => preview.locator('.layout-preview-label').allTextContents())
    .toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Description/),
        expect.stringMatching(/^Summary/),
      ]),
    );
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await sideways(page)).toEqual([]);

  await editor.getByRole('button', { name: 'Save the layouts' }).click();
  await expect(page.getByText(`${name} was saved.`)).toBeVisible();
  await editor.getByRole('button', { name: `Use this set for ${keys.mine}` }).click();
  await expect(page.getByText(`${keys.mine} now uses ${name}.`)).toBeVisible();
  await expect(editor.getByText(`Used by ${keys.mine}.`)).toBeVisible();

  // The server holds exactly that: the set is the track's, and the track uses it.
  const track = await ok<{ track: { layoutSetId: number } }>(
    api.get(`${BASE}/api/v1/tracks/${mine}`),
  );
  const saved = await ok<{
    layoutSet: { trackId: number; layouts: { definition: { tabs: { sections: unknown }[] } }[] };
  }>(api.get(`${BASE}/api/v1/layout-sets/${track.track.layoutSetId}`));
  expect(saved.layoutSet.trackId).toBe(mine);
  expect(saved.layoutSet.layouts[0]?.definition.tabs[0]?.sections).toEqual([
    { kind: 'main', hideWhenEmpty: false, fields: ['description', 'summary'] },
    { kind: 'context', hideWhenEmpty: false, fields: [] },
  ]);

  // Its field rules: a rule set of its own, used by the track.
  await page
    .getByRole('link', { name: `The field rules of ${keys.mine} are on its configuration sets.` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/manage/tracks/${mine}/configuration-sets$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Configuration sets' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Add a type set' })).toHaveCount(0);
  const rules = `Rules ${stamp}`;
  await page.getByRole('button', { name: 'New field rule set' }).click();
  const addRules = page.getByRole('form', { name: 'Add a field rule set' });
  await addRules.getByLabel('Rule set name').fill(rules);
  await addRules.getByRole('button', { name: 'Add a field rule set' }).click();
  await expect(page.getByText(`${rules} was added.`)).toBeVisible();
  const panel = page.getByRole('form', { name: `Settings of ${rules}` });
  await panel.getByRole('group', { name: 'Due date' }).getByLabel('Required').check();
  await panel.getByRole('button', { name: 'Save the set' }).click();
  await expect(page.getByText(`${rules} was saved.`)).toBeVisible();
  await panel.getByRole('button', { name: `Use this set for ${keys.mine}` }).click();
  await expect(page.getByText(`${keys.mine} now uses ${rules}.`)).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await sideways(page)).toEqual([]);
  const ruled = await ok<{ track: { fieldRuleSetId: number } }>(
    api.get(`${BASE}/api/v1/tracks/${mine}`),
  );
  const ruleSet = await ok<{ fieldRuleSet: { name: string; rules: { field: string }[] } }>(
    api.get(`${BASE}/api/v1/field-rule-sets/${ruled.track.fieldRuleSetId}`),
  );
  expect(ruleSet.fieldRuleSet.name).toBe(rules);
  expect(ruleSet.fieldRuleSet.rules).toEqual([expect.objectContaining({ field: 'dueDate' })]);

  // The shared page offers only the track they run; the other track's page refuses them.
  await visit(page, '#/admin/layouts');
  await expect(
    page.getByRole('link', { name: `Layout sets of ${keys.mine} · Forms we run` }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(keys.theirs) })).toHaveCount(0);
  await expect(setPicker(page)).toHaveCount(0);
  expect(await sideways(page)).toEqual([]);
  await visit(page, `#/manage/tracks/${theirs}/layouts`);
  await expect(
    page.getByText(
      'Only the people who run this track, and site and configuration administrators, change its configuration.',
    ),
  ).toBeVisible();

  // The server stays the judge: a shared set and the other track's are not theirs to change.
  const tryChange = async (setId: number) =>
    (await api.patch(`${BASE}/api/v1/layout-sets/${setId}`, { data: { name: 'Taken' } })).status();
  expect(await tryChange(shared.id)).toBe(403);
  expect(await tryChange(elsewhere.layoutSet.id)).toBe(404);
  expect((await api.get(`${BASE}/api/v1/layout-sets/${elsewhere.layoutSet.id}`)).status()).toBe(
    404,
  );
});
