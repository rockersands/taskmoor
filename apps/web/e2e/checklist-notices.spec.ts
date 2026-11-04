import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/**
 * Checklist notices end to end (T-196a; NTF-015; ADR-120): the person who runs a track turns them
 * on from the track's Manage page, from the keyboard; another person runs through a checklist on a
 * ticket a follower follows; the follower finds one item in the inbox that counts the changes and
 * names no item, and opens the ticket from it. The person who made the changes is told nothing. On
 * a desktop and on a phone, with no serious axe issue, no sideways scroll and a 44px target on the
 * phone. It uses the attachments database (preview 4174), whose administrator (Ada Attach) the API
 * server made, and whose worker delivers notifications; everyone else is made here.
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

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

async function ok<T>(
  answer: Promise<{ ok(): boolean; text(): Promise<string>; json(): Promise<unknown> }>,
) {
  const res = await answer;
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json().catch(() => null)) as T;
}

async function signInAs(api: APIRequestContext, email: string, password: string) {
  await api.delete(`${BASE}/api/v1/session`);
  await ok(api.post(`${BASE}/api/v1/session`, { data: { email, password } }));
}

/** Opens a page afresh: after a change of who is signed in, the app reads the session again. */
async function visit(page: Page, hash: string) {
  await page.goto('about:blank');
  await page.goto(`${BASE}/${hash}`);
}

test('[NTF-015] whoever runs a track turns checklist notices on, and a follower gets one notice for a run of changes', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const phone = testInfo.project.name !== 'desktop';
  const stamp = `${testInfo.project.name.replace(/\W/g, '')}${Date.now().toString(36)}`;
  const api = page.request;

  // The administrator makes a track and three people: Lead runs it, Doer and Fan are members.
  await signInAs(api, ADMIN.email, ADMIN.password as string);
  const key = `CN${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const track = await ok<{ track: { id: number } }>(
    api.post(`${BASE}/api/v1/tracks`, {
      data: { key, name: `Notices ${stamp}`, mode: 'shared' },
    }),
  );
  const roles = Object.fromEntries(
    (
      await ok<{ roles: { id: number; name: string }[] }>(api.get(`${BASE}/api/v1/roles`))
    ).roles.map((r) => [r.name, r.id]),
  );
  const people = { lead: `Lead ${stamp}`, doer: `Doer ${stamp}`, fan: `Fan ${stamp}` };
  const emails = Object.fromEntries(
    Object.keys(people).map((who) => [who, `${who}.${stamp}@notices.test`.toLowerCase()]),
  ) as Record<keyof typeof people, string>;
  const ids = {} as Record<keyof typeof people, number>;
  for (const who of Object.keys(people) as (keyof typeof people)[]) {
    const made = await ok<{ user: { id: number } }>(
      api.post(`${BASE}/api/v1/users`, {
        data: { email: emails[who], name: people[who], password: PASSWORD },
      }),
    );
    ids[who] = made.user.id;
    const role = who === 'lead' ? 'Administrators' : 'Members';
    const res = await api.put(
      `${BASE}/api/v1/tracks/${track.track.id}/roles/${roles[role]}/users/${ids[who]}`,
    );
    expect(res.status(), await res.text()).toBe(204);
  }

  // Lead opens the track's Manage page and turns the notices on from the keyboard.
  await signInAs(api, emails.lead, PASSWORD);
  await visit(page, `#/manage/tracks/${track.track.id}`);
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(key) })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Notices to followers' })).toBeVisible();
  const box = page.getByRole('checkbox', { name: 'Tell followers when a checklist changes' });
  await expect(box).not.toBeChecked();
  await box.focus();
  await page.keyboard.press('Space');
  await expect(
    page.getByText(`Followers of tickets in ${key} now hear when a checklist changes.`),
  ).toBeVisible();
  await expect(box).toBeChecked();
  await expect(box).toBeFocused();
  if (phone) {
    // The label is part of the target: the row is a comfortable one on a phone (ADR-033).
    const row = page.locator('label', { hasText: 'Tell followers when a checklist changes' });
    expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  // It stays on after a reload.
  await page.reload();
  await expect(
    page.getByRole('checkbox', { name: 'Tell followers when a checklist changes' }),
  ).toBeChecked();

  // Doer writes a ticket and Fan follows it; then Doer runs through a checklist.
  await signInAs(api, emails.doer, PASSWORD);
  const ticket = (
    await ok<{ ticket: { id: number; key: string } }>(
      api.post(`${BASE}/api/v1/tickets`, { data: { track: key, summary: `Launch ${stamp}` } }),
    )
  ).ticket;
  await signInAs(api, emails.fan, PASSWORD);
  const follow = await api.put(`${BASE}/api/v1/tickets/${ticket.id}/followers/${ids.fan}`);
  expect(follow.status(), await follow.text()).toBe(204);
  await signInAs(api, emails.doer, PASSWORD);
  const lists = `${BASE}/api/v1/tickets/${ticket.id}/checklists`;
  const made = await ok<{ checklists: { id: number; items: { id: number }[] }[] }>(
    api.post(lists, { data: { name: 'Secret steps', items: ['Call the vendor', 'Ship it'] } }),
  );
  const list = made.checklists[0];
  for (const item of list?.items ?? []) {
    await ok(
      api.patch(`${lists}/${list?.id}/items/${item.id}`, { data: { state: 'done' } }),
    );
  }

  // Fan finds one item for the three changes, with nothing an item says, and opens the ticket.
  await signInAs(api, emails.fan, PASSWORD);
  await visit(page, '#/inbox');
  const said = page.getByText(`${people.doer} made 3 changes to checklists`);
  await expect(said).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/changes to checklists|changed a checklist/)).toHaveCount(1);
  await expect(page.getByText('Call the vendor')).toHaveCount(0);
  await expect(page.getByText('Secret steps')).toHaveCount(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await page.getByRole('link', { name: new RegExp(ticket.key) }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(ticket.key) })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Checklists' }).getByText('2 of 2 done (100%)'),
  ).toBeVisible();

  // Doer, who made the changes, is told nothing of them.
  await signInAs(api, emails.doer, PASSWORD);
  const own = await ok<{ items: unknown[] }>(
    api.get(`${BASE}/api/v1/inbox?event=checklist_changed`),
  );
  expect(own.items).toEqual([]);
});
