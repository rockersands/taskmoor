import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { uniqueKey, uniqueStamp } from './unique';

/**
 * A local-mode track's own ticket types and fields, for someone who runs the track (T-322;
 * CORE-003, CORE-005, CORE-009, IAM-030): a person who is no administrator runs MINE, a track with
 * its own configuration. From its Manage page they add a ticket type of its own, offer it in its
 * type set, rename it, see its delete refused while the set holds it, and delete it once it does
 * not; then add a person field of its own whose context offers the holders of a track role, with a
 * default person found among the track's people. No list only administrators may read is asked
 * for. Only MINE, its type and its field change, so no other test sees a difference. No serious
 * axe issue and no sideways scroll, on a desktop and a phone. It uses the attachments database
 * (preview 4174), whose site administrator the API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
/** Lists only site and configuration administrators may read (ADR-114). */
const ADMIN_LISTS = [
  '/api/v1/groups',
  '/api/v1/roles',
  '/api/v1/people/lookup',
  '/api/v1/hierarchy-levels/impact',
];
/** The runner's password, made per run so none is written in the repository. */
const PASSWORD = `own-${randomBytes(18).toString('base64url')}`;

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

test('[CORE-005] [CORE-009] [IAM-030] someone who runs a track keeps its own ticket types and fields', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const stamp = uniqueStamp(testInfo);
  const key = uniqueKey('OT', testInfo);
  const api = page.request;

  // A site administrator makes a track with its own configuration and a person who runs it.
  await signInAs(api, ADMIN.email, ADMIN.password as string);
  const mine = (
    await ok<{ track: { id: number } }>(
      api.post(`${BASE}/api/v1/tracks`, {
        data: { key, name: 'Ops we run', mode: 'local', type: 'business' },
      }),
    )
  ).track.id;
  const email = `owner.${stamp}@owntypes.test`.toLowerCase();
  const runnerName = `Runner ${stamp}`;
  const runner = await ok<{ user: { id: number } }>(
    api.post(`${BASE}/api/v1/users`, {
      data: { email, name: runnerName, password: PASSWORD },
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

  // The person signs in. Nothing they do asks for a list only administrators may read.
  await signInAs(api, email, PASSWORD);
  const asked: string[] = [];
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (ADMIN_LISTS.includes(path)) asked.push(path);
  });

  // Their track's Manage page leads to its configuration sets, which hold its own ticket types.
  await visit(page, `#/manage/tracks/${mine}`);
  // The track above the page's title, "People of the track" (S3-TR-9).
  await expect(page.getByText(new RegExp(`^${key} · `))).toBeVisible();
  const own = page.getByRole('region', { name: 'Its own configuration' });
  await own
    .getByRole('link', { name: 'Configuration sets: its ticket types and field rules' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/manage/tracks/${mine}/configuration-sets$`));
  const types = page.getByRole('region', { name: 'Its own ticket types' });
  await expect(types.getByText(`${key} has no ticket type of its own yet.`)).toBeVisible();

  await types.getByRole('button', { name: 'New ticket type' }).click();
  const add = types.getByRole('form', { name: 'Add a ticket type' });
  await add.getByLabel('Ticket type name').fill('Alarm');
  await add.getByLabel('Description').fill('Something paged us.');
  await add.getByLabel('Bug', { exact: true }).check();
  await add.getByRole('button', { name: 'Add a ticket type' }).click();
  await expect(
    page.getByText('Alarm was added. Tick it in the type set to offer it.'),
  ).toBeVisible();
  const row = types.getByRole('listitem').filter({ hasText: 'Something paged us.' });
  await expect(row.getByText('Standard level · not in its type set yet')).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await sideways(page)).toEqual([]);

  // Its type set offers it once it is ticked there.
  const typeSet = `${key} local type set`;
  await page.getByRole('button', { name: `Manage ${typeSet}` }).click();
  const set = page.getByRole('form', { name: `Settings of ${typeSet}` });
  await set.getByLabel('Alarm', { exact: true }).check();
  await set.getByRole('button', { name: 'Save the set' }).click();
  await expect(page.getByText(`${typeSet} was saved.`)).toBeVisible();
  await expect(row.getByText('Standard level · in its type set')).toBeVisible();

  // Renamed; then its delete is refused while the set holds it.
  await row.getByRole('button', { name: 'Manage ticket type Alarm' }).click();
  // Named after the type, so the name changes with it.
  const settings = row.getByRole('form', { name: /^Settings of / });
  await settings.getByLabel('Ticket type name').fill('Page');
  await settings.getByRole('button', { name: 'Save the type' }).click();
  await expect(page.getByText('Page was saved.')).toBeVisible();
  const held = await ok<{ ticketTypes: { name: string; trackId: number | null }[] }>(
    api.get(`${BASE}/api/v1/ticket-types?trackId=${mine}`),
  );
  expect(held.ticketTypes.filter((t) => t.trackId === mine).map((t) => t.name)).toEqual(['Page']);
  await settings.getByRole('button', { name: 'Delete ticket type Page' }).click();
  const question = settings.getByRole('group', { name: /^Delete Page\?/ });
  await question.getByRole('button', { name: 'Delete ticket type Page' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    `Page is in ${typeSet}: untick it there and save the set first.`,
  );
  await question.getByRole('button', { name: 'Cancel' }).click();
  await set.getByLabel('Page', { exact: true }).uncheck();
  await set.getByRole('button', { name: 'Save the set' }).click();
  await expect(page.getByText(`${typeSet} was saved.`)).toBeVisible();
  await settings.getByRole('button', { name: 'Delete ticket type Page' }).click();
  await settings
    .getByRole('group', { name: /^Delete Page\?/ })
    .getByRole('button', { name: 'Delete ticket type Page' })
    .click();
  await expect(page.getByText('Page was deleted.')).toBeVisible();
  await expect(types.getByRole('heading', { name: 'Its own ticket types' })).toBeFocused();
  await expect(types.getByText(`${key} has no ticket type of its own yet.`)).toBeVisible();

  // Its own fields: a page beside the others, linked from the Manage page.
  await page.getByRole('link', { name: `Back to managing ${key}.` }).click();
  await own.getByRole('link', { name: 'Fields: the custom fields it owns' }).click();
  await expect(page).toHaveURL(new RegExp(`/manage/tracks/${mine}/fields$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Fields' })).toBeVisible();
  await expect(page.getByText(`${key} · Ops we run`, { exact: true })).toBeVisible();
  // The shared fields that reach it, such as Points, are the administrators'.
  await expect(page.getByText(`${key} has no field of its own yet.`)).toBeVisible();

  await page.getByRole('button', { name: 'New field' }).click();
  const create = page.getByRole('form', { name: 'Add a field' });
  await create.getByLabel('Field name').fill('On call');
  await create.getByLabel('Type').selectOption('user');
  await create.getByRole('button', { name: 'Add a field' }).click();
  await expect(page.getByText('On call was added.')).toBeVisible();

  // Its context covers the track alone, and offers the holders of one of the track's roles.
  await page.getByRole('button', { name: 'Change context Default' }).click();
  const context = page.getByRole('form', { name: 'Change context Default' });
  await expect(
    context.getByText('It covers Ops we run only: the field belongs to that track.'),
  ).toBeVisible();
  const offer = context.getByLabel('Offer');
  await expect(offer.locator('option')).toHaveText(['Anyone', 'The holders of a track role']);
  await offer.selectOption('role');
  await context.getByLabel('Track role').selectOption({ label: 'Administrators' });
  await context.getByRole('button', { name: 'Save the context' }).click();
  await expect(page.getByText('The context Default was saved.')).toBeVisible();
  await expect(
    page.getByText('People to choose from: whoever holds Administrators in the ticket’s track'),
  ).toBeVisible();

  // Its default person is found among the people of the track.
  const fallback = page.getByRole('form', { name: 'Default value in Default' });
  // By the stamp in their name: other tests make people called Runner too.
  await fallback.getByLabel('Default value').fill(stamp);
  await fallback.getByRole('button', { name: runnerName }).click();
  await fallback.getByRole('button', { name: 'Save the default' }).click();
  await expect(page.getByText('The default in Default was saved.')).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await sideways(page)).toEqual([]);

  // The server holds exactly that: a field of the track's own, for it alone, with that default.
  const fields = await ok<{
    fields: {
      name: string;
      trackId: number | null;
      contexts: {
        trackIds: number[] | null;
        config?: { userRoleId?: number };
        defaultValue: unknown;
      }[];
    }[];
  }>(api.get(`${BASE}/api/v1/fields?trackId=${mine}`));
  const field = fields.fields.find((f) => f.trackId === mine);
  expect(field?.name).toBe('On call');
  expect(field?.contexts).toEqual([
    expect.objectContaining({
      trackIds: [mine],
      config: expect.objectContaining({ userRoleId: administrators }),
      defaultValue: { id: runner.user.id, name: runnerName },
    }),
  ]);
  expect(asked).toEqual([]);
});
