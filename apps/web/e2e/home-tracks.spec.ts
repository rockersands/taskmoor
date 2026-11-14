import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { uniqueRun } from './unique';

/**
 * Home's "Your tracks" (T-194; AGL-019; ADR-046) end to end, on a desktop and a phone: a person
 * sees the track where they hold a role and the one their team owns an area of, but not a track
 * they only see through a grant of its access policy, which the Tracks page still lists. A person
 * in no track is told so and led to the Tracks page. No serious axe issue and no sideways scroll.
 * Everything is made for this run on the attachments database (preview 4174), whose
 * administrator (Ada Attach) the API server made.
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

async function signInAs(
  api: APIRequestContext,
  data: { email: string; password: string | undefined },
) {
  await api.delete(`${BASE}/api/v1/session`);
  await ok(api.post(`${BASE}/api/v1/session`, { data }));
}

/** Opens Home afresh: after a change of who is signed in, the app reads the session again. */
async function openHome(page: Page) {
  await page.goto('about:blank');
  await page.goto(`${BASE}/#/home`);
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

test('[AGL-019] Your tracks shows the tracks a person belongs to, not every track they see', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const api = page.request;
  const run = uniqueRun(testInfo);
  const person = {
    email: `mina-${run}@home.test`.toLowerCase(),
    name: `Mina ${run}`,
    password: `walk-${randomBytes(18).toString('hex')}`,
  };

  // Ada makes Mina and three tracks: one where Mina is a Member, one her team owns an area of,
  // and one she may only see, through a grant of its access policy to her by name.
  await signInAs(api, ADMIN);
  const minaId = (
    await ok<{ user: { id: number } }>(api.post(`${BASE}/api/v1/users`, { data: person }))
  ).user.id;
  const policy = (
    await ok<{ policy: { id: number } }>(
      api.post(`${BASE}/api/v1/access-policies`, { data: { name: `Mina may look ${run}` } }),
    )
  ).policy.id;
  await ok(
    api.post(`${BASE}/api/v1/access-policies/${policy}/grants`, {
      data: { permission: 'browse_track', grantee: 'user', userId: minaId },
    }),
  );
  const track = async (key: string, name: string, extra: Record<string, unknown> = {}) =>
    (
      await ok<{ track: { id: number } }>(
        api.post(`${BASE}/api/v1/tracks`, { data: { key, name, mode: 'shared', ...extra } }),
      )
    ).track.id;
  const keys = { role: `HR${run}`, team: `HT${run}`, seen: `HS${run}` };
  const roleTrack = await track(keys.role, `Role ${run}`);
  const teamTrack = await track(keys.team, `Team ${run}`, { accessPolicyId: policy });
  await track(keys.seen, `Seen ${run}`, { accessPolicyId: policy });
  const roles = (await (await api.get(`${BASE}/api/v1/roles`)).json()).roles as {
    id: number;
    name: string;
  }[];
  const members = roles.find((r) => r.name === 'Members')?.id;
  expect(
    (await api.put(`${BASE}/api/v1/tracks/${roleTrack}/roles/${members}/users/${minaId}`)).status(),
  ).toBeLessThan(300);
  const team = (
    await ok<{ team: { id: number } }>(
      api.post(`${BASE}/api/v1/teams`, { data: { name: `Crew ${run}` } }),
    )
  ).team.id;
  expect((await api.put(`${BASE}/api/v1/teams/${team}/members/${minaId}`)).status()).toBeLessThan(
    300,
  );
  await ok(
    api.post(`${BASE}/api/v1/tracks/${teamTrack}/areas`, {
      data: { name: 'Billing', ownerTeamId: team },
    }),
  );

  // On Home, Mina's tracks are the two she belongs to.
  await signInAs(api, person);
  await openHome(page);
  const yours = page.getByRole('region', { name: 'Your tracks' });
  const cards = yours.getByRole('link', { name: /Key / });
  await expect(cards).toHaveCount(2);
  await expect(yours.getByRole('link', { name: new RegExp(`Key ${keys.role}`) })).toBeVisible();
  await expect(yours.getByRole('link', { name: new RegExp(`Key ${keys.team}`) })).toBeVisible();
  await expect(yours.getByRole('link', { name: new RegExp(`Key ${keys.seen}`) })).toHaveCount(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await noSidewaysScroll(page);

  // The one she opened last comes first, in this browser.
  await yours.getByRole('link', { name: new RegExp(`Key ${keys.team}`) }).click();
  await expect(page).toHaveURL(new RegExp(`#/tracks/${keys.team}`));
  await openHome(page);
  await expect(cards.first()).toHaveAccessibleName(new RegExp(`Key ${keys.team}`));

  // The Tracks page still lists the track she only sees.
  await page.goto(`${BASE}/#/tracks`);
  await expect(page.getByRole('heading', { level: 1, name: 'Tracks' })).toBeVisible();
  await expect(page.getByText(`Seen ${run}`)).toBeVisible();
});

test('[AGL-019] a person in no track is told so and led to the Tracks page', async ({
  page,
}, testInfo) => {
  const api = page.request;
  const run = `${testInfo.project.name}-${Date.now()}`;
  const person = {
    email: `new-${run}@home.test`.toLowerCase(),
    name: `New ${run}`,
    password: `walk-${randomBytes(18).toString('hex')}`,
  };
  await signInAs(api, ADMIN);
  await ok(api.post(`${BASE}/api/v1/users`, { data: person }));

  await signInAs(api, person);
  await openHome(page);
  const yours = page.getByRole('region', { name: 'Your tracks' });
  await expect(yours.getByText('You are not in any track yet')).toBeVisible();
  const go = yours.getByRole('link', { name: 'Go to Tracks' });
  await expect(go).toBeVisible();
  // A comfortable target on a phone (ADR-033).
  if (testInfo.project.name === 'mobile') {
    expect((await go.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  expect(await seriousAxeViolations(page)).toEqual([]);
  await noSidewaysScroll(page);
  await go.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tracks' })).toBeVisible();
});
