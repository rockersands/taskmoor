import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import { uniqueKey, uniqueStamp } from './unique';

/**
 * Who may create tracks (IAM-033): on a new site only site administrators do. A site
 * administrator gives someone the role that runs a track with **Also let them create tracks**
 * ticked, and that person can then make tracks; they in turn offer the box, untick it, and the
 * next manager cannot. They use the attachments database (preview 4174), which first-run setup
 * made, so nobody but its administrator holds the permission there.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
const PASSWORD = 'ladder violet harbour lantern';
const BOX = 'Also let them create tracks';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
async function seriousAxeViolations(page: Page): Promise<string[]> {
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

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/**
 * A dialog fits the screen: its own box, since it sits in a fixed backdrop whose overflow never
 * widens the page, so the page's scroll width cannot tell (T-249).
 */
const dialogFits = (dialog: Locator) =>
  dialog.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return box.left >= -0.5 && box.right <= innerWidth + 0.5 && el.scrollWidth <= el.clientWidth;
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

const mayCreate = async (api: APIRequestContext) =>
  (await (await api.get(`${BASE}/api/v1/session`)).json()).user.mayCreateLocalTracks as boolean;

/** Gives the role that runs the track to a person found by name, on the track's Manage page. */
async function appoint(page: Page, name: string, tick: boolean) {
  await page.getByLabel('Role', { exact: true }).selectOption({ label: 'Administrators' });
  const box = page.getByRole('checkbox', { name: BOX });
  await expect(box).toBeChecked();
  if (!tick) await box.uncheck();
  await page.getByLabel('Find a person by name').fill(name);
  await page.getByRole('button', { name: `Give Administrators to ${name}` }).click();
}

/**
 * A role given is said where the person found was, right under the search field (T-248), not
 * among the rows above, and told to a screen reader by the page's status line.
 */
async function expectSaidUnderSearch(page: Page, text: string) {
  const said = page
    .getByRole('region', { name: 'Who holds which role' })
    .getByRole('listitem')
    .filter({ hasText: text });
  await expect(said).toBeVisible();
  const search = await page.getByLabel('Find a person by name').boundingBox();
  const at = await said.boundingBox();
  const below = (at?.y ?? 0) - ((search?.y ?? 0) + (search?.height ?? 0));
  expect(below).toBeGreaterThanOrEqual(0);
  expect(below).toBeLessThan(80);
  await expect(page.getByRole('status').filter({ hasText: text })).toHaveCount(1);
}

test('[IAM-033] the box given with the managing role lets a person create tracks; unticked, it does not', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const stamp = uniqueStamp(testInfo);
  const key = uniqueKey('C', testInfo);
  const api = page.request;

  // A site administrator makes a track and two people through the API.
  await signInAs(api, ADMIN.email, ADMIN.password as string);
  const made = await ok<{ track: { id: number } }>(
    api.post(`${BASE}/api/v1/tracks`, {
      data: { key, name: 'Track makers', mode: 'shared', type: 'business' },
    }),
  );
  const people = { lead: `Lead ${stamp}`, next: `Next ${stamp}` };
  const emails = {
    lead: `lead.${stamp}@create.test`.toLowerCase(),
    next: `next.${stamp}@create.test`.toLowerCase(),
  };
  for (const who of ['lead', 'next'] as const) {
    await ok(
      api.post(`${BASE}/api/v1/users`, {
        data: { email: emails[who], name: people[who], password: PASSWORD },
      }),
    );
  }

  // On this site nobody else may create tracks: no New track for the person.
  await signInAs(api, emails.lead, PASSWORD);
  expect(await mayCreate(api)).toBe(false);
  await visit(page, '#/tracks');
  await expect(page.getByRole('heading', { level: 1, name: 'Tracks' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New track' })).toHaveCount(0);

  // The site administrator gives the role with the box ticked.
  await signInAs(api, ADMIN.email, ADMIN.password as string);
  await visit(page, `#/manage/tracks/${made.track.id}`);
  await expect(page.getByText(new RegExp(`^${key} · `))).toBeVisible();
  await page.getByLabel('Role', { exact: true }).selectOption({ label: 'Administrators' });
  await expect(page.getByRole('checkbox', { name: BOX })).toBeChecked();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await appoint(page, people.lead, true);
  await expectSaidUnderSearch(
    page,
    `${people.lead} now holds Administrators and can create tracks.`,
  );

  // The new manager can create tracks now.
  await signInAs(api, emails.lead, PASSWORD);
  expect(await mayCreate(api)).toBe(true);
  await visit(page, '#/tracks');
  await expect(page.getByRole('button', { name: 'New track' }).first()).toBeVisible();

  // Holding it, they are offered the box too; unticked, the next manager gets the role alone.
  await visit(page, `#/manage/tracks/${made.track.id}`);
  await expect(page.getByText(new RegExp(`^${key} · `))).toBeVisible();
  await appoint(page, people.next, false);
  await expectSaidUnderSearch(page, `${people.next} now holds Administrators.`);
  expect(await noSidewaysScroll(page)).toBe(true);

  // The next manager runs the track but may not create tracks, and is not offered the box.
  await signInAs(api, emails.next, PASSWORD);
  expect(await mayCreate(api)).toBe(false);
  await visit(page, `#/manage/tracks/${made.track.id}`);
  await expect(page.getByText(new RegExp(`^${key} · `))).toBeVisible();
  await page.getByLabel('Role', { exact: true }).selectOption({ label: 'Administrators' });
  await expect(page.getByRole('checkbox', { name: BOX })).toHaveCount(0);
  const refused = await api.post(`${BASE}/api/v1/tracks`, {
    data: { key: uniqueKey('CX', testInfo), name: 'Not allowed', mode: 'local' },
  });
  expect(refused.status()).toBe(403);

  // In Spanish, whose words run longer, the box and the invite dialog that offers it still fit
  // the screen (ADR-033; T-249), on a phone at the narrowest width supported.
  if (testInfo.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  await signInAs(api, ADMIN.email, ADMIN.password as string);
  await visit(page, `?locale=es#/manage/tracks/${made.track.id}`);
  await expect(page.getByText(new RegExp(`^${key} · `))).toBeVisible();
  await page.getByLabel('Rol', { exact: true }).selectOption({ label: 'Administrators' });
  await expect(page.getByRole('checkbox', { name: 'Permitir también crear tracks' })).toBeChecked();
  expect(await noSidewaysScroll(page)).toBe(true);
  await page.getByRole('button', { name: 'Invitar personas' }).click();
  const dialog = page.getByRole('dialog', { name: `Invitar personas a ${key}` });
  await dialog.getByLabel('Rol').selectOption({ label: 'Administrators' });
  await expect(
    dialog.getByRole('checkbox', { name: 'Permitir también crear tracks' }),
  ).toBeChecked();
  expect(await noSidewaysScroll(page)).toBe(true);
  expect(await dialogFits(dialog)).toBe(true);
});
