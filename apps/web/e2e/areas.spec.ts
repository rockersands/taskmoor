import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { uniqueKey, uniqueStamp } from './unique';

/**
 * A track's areas end to end (CORE-015; T-320): someone who runs a track and is no site
 * administrator goes from the track's Summary to its Areas, under the track's tab bar. With the
 * form they add two areas, the first owned by them with the rule that gives its new tickets to its
 * owner, change the first and archive and restore the second. A ticket made in the first with no
 * assignee goes to its owner. Delete on the first asks first, then, since a ticket is in it, where
 * its tickets go: they move to the second. A member of the track reads the areas with no way to
 * change them. No serious axe issue and no sideways page scroll, on a desktop and a phone. It uses
 * the attachments database (preview 4174), whose site administrator the API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
const PASSWORD = 'meadow copper lantern river';

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

test('[CORE-015] [IAM-030] a track’s administrator keeps its areas, and its members read them', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const stamp = uniqueStamp(testInfo);
  const key = uniqueKey('AR', testInfo);
  const api = page.request;

  // A site administrator makes the track, someone who runs it and a member of it.
  await signInAs(api, ADMIN.email, ADMIN.password as string);
  const { track } = await ok<{ track: { id: number } }>(
    api.post(`${BASE}/api/v1/tracks`, { data: { key, name: `Areas ${key}`, mode: 'shared' } }),
  );
  const person = async (who: string) => {
    const email = `${who}.${stamp}@areas.test`.toLowerCase();
    const name = `${who} ${stamp}`;
    const made = await ok<{ user: { id: number } }>(
      api.post(`${BASE}/api/v1/users`, { data: { email, name, password: PASSWORD } }),
    );
    return { id: made.user.id, email, name };
  };
  const runner = await person('Runner');
  const reader = await person('Reader');
  const roles = (await (await api.get(`${BASE}/api/v1/roles`)).json()).roles as {
    id: number;
    name: string;
  }[];
  const roleId = (name: string) => roles.find((r) => r.name === name)?.id as number;
  for (const [who, role] of [
    [runner, 'Administrators'],
    [reader, 'Members'],
  ] as const) {
    const given = await api.put(
      `${BASE}/api/v1/tracks/${track.id}/roles/${roleId(role)}/users/${who.id}`,
    );
    expect(given.status()).toBe(204);
  }

  // The runner, from the track's Summary to its areas, which keep the track's tab bar.
  await signInAs(api, runner.email, PASSWORD);
  await visit(page, `#/tracks/${key}`);
  await page.getByRole('link', { name: 'Areas', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Areas' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: `Sections of ${key}` })).toBeVisible();
  await expect(page.getByText('No areas yet')).toBeVisible();

  // The first area, owned by the runner, its new tickets going to its owner.
  await page.getByRole('button', { name: 'New area' }).click();
  const form = page.getByRole('form', { name: 'New area' });
  await form.getByRole('textbox', { name: 'Name' }).fill('API');
  await form.getByRole('textbox', { name: 'Description' }).fill('The public interface');
  await form.getByRole('searchbox', { name: 'Owner' }).fill(runner.name);
  await form.getByRole('button', { name: runner.name }).click();
  await form
    .getByRole('combobox', { name: 'New tickets with no assignee go to' })
    .selectOption({ label: 'The area owner' });
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await sideways(page)).toEqual([]);
  await form.getByRole('button', { name: 'Save the area' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'was added' })).toHaveText(
    'Area API was added.',
  );
  const list = page.getByRole('list', { name: `Areas of ${key}` });
  await expect(list.getByText(`Owner: ${runner.name}`)).toBeVisible();
  await expect(list.getByText('New tickets with no assignee go to the area owner.')).toBeVisible();

  // The second, with no owner.
  await page.getByRole('button', { name: 'New area' }).click();
  await page
    .getByRole('form', { name: 'New area' })
    .getByRole('textbox', { name: 'Name' })
    .fill('Billing');
  await page.getByRole('button', { name: 'Save the area' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'was added' })).toHaveText(
    'Area Billing was added.',
  );

  // The first renamed; the second archived, then restored.
  await page.getByRole('button', { name: 'Change area API' }).click();
  const change = page.getByRole('form', { name: 'Change area API' });
  await change.getByRole('textbox', { name: 'Name' }).fill('Public API');
  await change.getByRole('button', { name: 'Save the area' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'was saved' })).toHaveText(
    'Area Public API was saved.',
  );
  await page.getByRole('button', { name: 'Archive area Billing' }).click();
  const archived = page.getByRole('region', { name: 'Archived areas' });
  await expect(archived.getByRole('button', { name: 'Restore area Billing' })).toBeFocused();
  await archived.getByRole('button', { name: 'Restore area Billing' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'was restored' })).toHaveText(
    'Area Billing was restored.',
  );
  await expect(archived).toHaveCount(0);

  // A ticket in the first, with no assignee, goes to its owner (CORE-015 (1)).
  const listed = (await (await api.get(`${BASE}/api/v1/tracks/${track.id}/areas`)).json())
    .areas as { id: number; name: string }[];
  const publicApi = listed.find((a) => a.name === 'Public API')?.id;
  expect(publicApi).toBeDefined();
  const made = await ok<{ ticket: { key: string; assignee: { id: number } | null } }>(
    api.post(`${BASE}/api/v1/tickets`, {
      data: { track: key, summary: 'Rate limits', areaIds: [publicApi] },
    }),
  );
  expect(made.ticket.assignee?.id).toBe(runner.id);

  // Deleting the first asks first, then where its ticket goes: to the second.
  await page.getByRole('button', { name: 'Delete area Public API' }).click();
  const question = page.getByRole('group', { name: /^Delete area Public API\?/ });
  await question.getByRole('button', { name: 'Delete area Public API' }).click();
  const where = page.getByRole('form', { name: 'Where tickets in Public API go' });
  await expect(where.getByText(/1 ticket is in Public API\./)).toBeVisible();
  await expect(where.getByRole('combobox', { name: 'Move them to' })).toBeFocused();
  await where.getByRole('combobox', { name: 'Move them to' }).selectOption({ label: 'Billing' });
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await sideways(page)).toEqual([]);
  await where.getByRole('button', { name: 'Delete area Public API' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'was deleted' })).toHaveText(
    'Area Public API was deleted; its tickets moved to Billing.',
  );
  await expect(page.getByRole('heading', { level: 1, name: 'Areas' })).toBeFocused();
  const after = await (await api.get(`${BASE}/api/v1/tickets/${made.ticket.key}`)).json();
  expect((after.ticket.areas as { name: string }[]).map((a) => a.name)).toEqual(['Billing']);

  // A member reads the areas and has no way to change them.
  await signInAs(api, reader.email, PASSWORD);
  await visit(page, `#/tracks/${key}/areas`);
  await expect(
    page.getByText('Only the administrators of this track can change its areas.'),
  ).toBeVisible();
  await expect(page.getByText('Billing', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New area' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Change|Archive|Delete) area/ })).toHaveCount(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await sideways(page)).toEqual([]);
});
