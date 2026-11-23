import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { uniqueRun } from './unique';

/**
 * Releases across tracks end to end (T-089c; PLN-007; ADR-122 stage 4): Ori administers one track
 * and browses another; Ada, the site's administrator, is the only one who administers the second.
 * Ori makes a release across tracks from their own release, Ada links the other track's, Ori moves
 * the date from the change list: their release moves, the other stays and reads out of step in
 * words, and a third track's release hidden from Ori is only counted. Ada aligns it from its own
 * page. No serious axe issue and no sideways page scroll, on a phone too. It uses the attachments
 * database (preview 4174), whose administrator (Ada Attach) the API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
// Made for this run: no password is written in the repository.
const PASSWORD = `${randomBytes(18).toString('hex')}-Zy7`;

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
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

async function ok<T>(answer: ReturnType<APIRequestContext['post']>): Promise<T> {
  const res = await answer;
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as T;
}

async function signInAs(api: APIRequestContext, email: string, password: string | undefined) {
  await api.delete(`${BASE}/api/v1/session`);
  await ok(api.post(`${BASE}/api/v1/session`, { data: { email, password } }));
}

/** Opens a page afresh: after a change of who is signed in, a hash change alone would not do. */
async function visit(page: Page, hash: string) {
  await page.goto('about:blank');
  await page.goto(`${BASE}/${hash}`);
}

test('[PLN-007] a release across tracks: made, linked, moved with one left out of step, aligned, the hidden one only counted', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const api = page.request;
  await signInAs(api, ADMIN.email, ADMIN.password);
  const run = uniqueRun(testInfo);
  const ori = { email: `ori-${run}@cross.test`.toLowerCase(), name: `Ori ${run}` };
  const person = (
    await ok<{ user: { id: number } }>(
      api.post(`${BASE}/api/v1/users`, {
        data: { email: ori.email, name: ori.name, password: PASSWORD },
      }),
    )
  ).user.id;
  const roles = (await (await api.get(`${BASE}/api/v1/roles`)).json()).roles as {
    id: number;
    name: string;
  }[];
  const role = (name: string) => roles.find((r) => r.name === name)?.id;
  const keys = { own: `XA${run}`, other: `XB${run}`, hidden: `XC${run}` };
  const trackOf: Record<string, number> = {};
  const releaseOf: Record<string, number> = {};
  for (const [which, key] of Object.entries(keys)) {
    const id = (
      await ok<{ track: { id: number } }>(
        api.post(`${BASE}/api/v1/tracks`, {
          data: { key, name: `Track ${key}`, mode: 'shared' },
        }),
      )
    ).track.id;
    trackOf[which] = id;
    releaseOf[which] = (
      await ok<{ release: { id: number } }>(
        api.post(`${BASE}/api/v1/tracks/${id}/releases`, {
          data: { name: `Rel ${which}`, releaseDate: '2030-03-01' },
        }),
      )
    ).release.id;
  }
  const add = async (track: number, roleName: string) => {
    const res = await api.put(
      `${BASE}/api/v1/tracks/${track}/roles/${role(roleName)}/users/${person}`,
    );
    expect(res.status(), await res.text()).toBeLessThan(300);
  };
  await add(trackOf.own as number, 'Administrators');
  await add(trackOf.other as number, 'Members');
  // Ori is in no role of the third track, so it is hidden from them.
  await ok(
    api.post(`${BASE}/api/v1/tickets`, {
      data: {
        track: keys.hidden,
        summary: 'Work hidden from Ori',
        targetReleaseIds: [releaseOf.hidden],
      },
    }),
  );

  // Ori reaches the list from the track's releases, and makes one from their own release.
  await signInAs(api, ori.email, PASSWORD);
  await visit(page, `#/tracks/${keys.own}/releases`);
  await page.getByRole('link', { name: 'Releases across tracks' }).click();
  await expect(
    page.getByRole('heading', { name: 'Releases across tracks', level: 1 }),
  ).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await page.getByRole('button', { name: 'New release across tracks' }).click();
  const making = page.getByRole('dialog');
  await making.getByLabel('Name').fill(`Launch ${run}`);
  await making.getByLabel('The day').fill('2030-03-01');
  await making.getByRole('checkbox', { name: /Rel own/ }).check();
  // A track Ori only browses offers nothing to link.
  await expect(making.getByRole('checkbox', { name: /Rel other/ })).toHaveCount(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await making.getByRole('button', { name: 'Make it' }).click();
  await expect(page.getByRole('heading', { name: `Launch ${run}`, level: 1 })).toBeVisible();
  const crossId = Number(/cross-track-releases\/(\d+)/.exec(page.url())?.[1]);
  expect(crossId).toBeGreaterThan(0);

  // Ada links the other two tracks' releases, which Ori could not.
  await signInAs(api, ADMIN.email, ADMIN.password);
  for (const which of ['other', 'hidden']) {
    await ok(
      api.post(`${BASE}/api/v1/cross-track-releases/${crossId}/members`, {
        data: { releaseId: releaseOf[which] },
      }),
    );
  }

  // Ori sees two, the third only counted, and never named.
  await signInAs(api, ori.email, PASSWORD);
  await visit(page, `#/cross-track-releases/${crossId}`);
  await expect(page.getByRole('heading', { name: `Launch ${run}`, level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /Rel other/ })).toBeVisible();
  await expect(
    page.getByText('1 more release is hidden from you, with 1 open ticket you may not see.'),
  ).toBeVisible();
  await expect(page.getByText('Rel hidden')).toHaveCount(0);
  await expect(page.getByText('Work hidden from Ori')).toHaveCount(0);
  await expect(page.getByText(keys.hidden)).toHaveCount(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // The change list says what will happen, and changes nothing.
  await page.getByRole('button', { name: 'Move date' }).click();
  const moving = page.getByRole('dialog');
  await moving.getByLabel('New date').fill('2030-04-15');
  await moving.getByRole('button', { name: 'Show what changes' }).click();
  const own = moving.getByRole('listitem').filter({ hasText: 'Rel own' });
  await expect(own).toContainText('Moves from');
  const other = moving.getByRole('listitem').filter({ hasText: 'Rel other' });
  await expect(other).toContainText('you do not administer its track');
  await expect(moving.getByText('1 more release you may not see stays as it is.')).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  const before = await (await api.get(`${BASE}/api/v1/releases/${releaseOf.own}`)).json();
  expect(before.release.releaseDate).toBe('2030-03-01');
  await moving.getByRole('button', { name: 'Move 1 release' }).click();
  await expect(moving.getByRole('heading', { name: /now ends on/ })).toBeFocused();
  await expect(moving.getByText('1 release moved.')).toBeVisible();
  await moving.getByRole('button', { name: 'Done' }).click();
  const after = await (await api.get(`${BASE}/api/v1/releases/${releaseOf.own}`)).json();
  expect(after.release.releaseDate).toBe('2030-04-15');
  // The one that stayed reads as out of step, in words.
  await expect(page.getByText('Out of step').first()).toBeVisible();
  await expect(page.getByText('1 linked release is out of step with this date.')).toBeVisible();

  // Ada aligns it from its own page: the release's own change.
  await signInAs(api, ADMIN.email, ADMIN.password);
  await visit(page, `#/releases/${releaseOf.other}`);
  await expect(page.getByRole('link', { name: `Launch ${run}` })).toBeVisible();
  await expect(page.getByText(`Out of step with Launch ${run}`)).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await page.getByRole('button', { name: /^Align to/ }).click();
  await expect(page.getByText('This release now ends on')).toBeVisible();
  const aligned = await (await api.get(`${BASE}/api/v1/releases/${releaseOf.other}`)).json();
  expect(aligned.release.releaseDate).toBe('2030-04-15');

  // A search finds its work as the viewer; the hidden ticket is there for Ada and not for Ori.
  const count = async () =>
    (
      await ok<{ total: { count: number } }>(
        api.post(`${BASE}/api/v1/search`, {
          data: { q: `crossTrackRelease = ${crossId}`, count: true, limit: 1 },
        }),
      )
    ).total.count;
  expect(await count()).toBe(1);
  await signInAs(api, ori.email, PASSWORD);
  expect(await count()).toBe(0);

  // Ori takes their own release out. Other teams plan by this and only that track's administrators
  // can link it again, so it asks first, naming the release and its track (D13, T-267).
  await visit(page, `#/cross-track-releases/${crossId}`);
  await page.getByRole('button', { name: 'Remove Rel own' }).click();
  const removing = page.getByRole('group', {
    name: /^Rel own of Track .+ leaves this release across tracks/,
  });
  await expect(removing.getByRole('button', { name: 'Cancel' })).toBeFocused();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await removing.getByRole('button', { name: `Remove Track ${keys.own} Rel own` }).click();
  await expect(
    page.getByText('Rel own is no longer linked. Its date did not change.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Linked releases', level: 2 })).toBeFocused();

  // Ada takes the other track's release out from the release's own page: the same question.
  await signInAs(api, ADMIN.email, ADMIN.password);
  await visit(page, `#/releases/${releaseOf.other}`);
  await page.getByRole('button', { name: `Remove from Launch ${run}` }).click();
  const leaving = page.getByRole('group', { name: /^Rel other of Track .+ leaves Launch/ });
  await expect(leaving.getByRole('button', { name: 'Cancel' })).toBeFocused();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await leaving.getByRole('button', { name: `Remove from Launch ${run}` }).click();
  await expect(
    page.getByText(`This release is no longer linked to Launch ${run}. Its date did not change.`),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to a release across tracks…' })).toBeFocused();
});
