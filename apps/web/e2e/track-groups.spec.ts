import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Personal track groups end to end (CORE-034, IAM-034): a person drags two tracks together and
 * names the group, by mouse on a desktop and by a real finger on a phone; puts a third in and
 * reorders it from the keyboard; minimizes the group and finds it so after a reload; shares it
 * with a role, which the other person gets only on the tracks the first one runs; and takes it
 * back. Someone a group is shared with is told in the inbox and leaves it from the keyboard,
 * after a dialog that says which role goes, and is told it went with focus still on the page
 * (T-204, T-206). No serious axe issue and no sideways scroll. It uses the attachments database
 * (preview 4174), whose administrator (Ada Attach) the API server made; everyone else is made
 * here.
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

const centre = async (locator: Locator) => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 };
};

/** A drag from one element to another: a mouse on a desktop, a finger on a phone. */
async function drag(page: Page, from: Locator, to: Locator, touch: boolean) {
  await from.scrollIntoViewIfNeeded();
  const a = await centre(from);
  const b = await centre(to);
  const steps = 12;
  if (!touch) {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps });
    await page.mouse.up();
    return;
  }
  // Real touch input, which the browser turns into pointer events of type "touch".
  const cdp = await page.context().newCDPSession(page);
  const touchAt = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }],
    });
  await touchAt('touchStart', a.x, a.y);
  for (let i = 1; i <= steps; i++) {
    await touchAt('touchMove', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  }
  await touchAt('touchEnd', b.x, b.y);
  await cdp.detach();
}

const keysIn = (region: Locator) => region.locator('.tracks-item-key').allTextContents();

/**
 * Whether every item of the open menu is on the screen and is what a press at its centre hits:
 * not off the page's start, and not under the cards and groups that follow it.
 */
async function menuReachable(page: Page): Promise<string[]> {
  await expect(page.getByRole('menu')).toBeVisible();
  return page.evaluate(() => {
    const problems: string[] = [];
    for (const item of document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')) {
      item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const box = item.getBoundingClientRect();
      if (box.left < 0 || box.right > innerWidth) problems.push(`${item.textContent}: off screen`);
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (hit?.closest('[role="menuitem"]') !== item) problems.push(`${item.textContent}: covered`);
    }
    return problems;
  });
}

test('[CORE-034] [IAM-034] groups of tracks: made by dragging, arranged by keyboard, remembered, shared and taken back', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const touch = testInfo.project.name !== 'desktop';
  const stamp = `${testInfo.project.name.replace(/\W/g, '')}${Date.now().toString(36)}`;
  const api = page.request;

  // The administrator makes three tracks and two people. Lead runs two of the tracks and only
  // reads the third; Mate has nothing.
  await signInAs(api, ADMIN.email, ADMIN.password as string);
  const names = { one: `Alpha ${stamp}`, two: `Beta ${stamp}`, three: `Gamma ${stamp}` };
  const tracks: Record<string, { id: number; key: string }> = {};
  for (const [which, name] of Object.entries(names)) {
    const key = `G${which[0]?.toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const made = await ok<{ track: { id: number } }>(
      api.post(`${BASE}/api/v1/tracks`, { data: { key, name, mode: 'shared' } }),
    );
    tracks[which] = { id: made.track.id, key };
  }
  const roles = Object.fromEntries(
    (
      await ok<{ roles: { id: number; name: string }[] }>(api.get(`${BASE}/api/v1/roles`))
    ).roles.map((r) => [r.name, r.id]),
  );
  const people = { lead: `Lead ${stamp}`, mate: `Mate ${stamp}` };
  const emails = {
    lead: `lead.${stamp}@groups.test`.toLowerCase(),
    mate: `mate.${stamp}@groups.test`.toLowerCase(),
  };
  const ids: Record<string, number> = {};
  for (const who of ['lead', 'mate'] as const) {
    const made = await ok<{ user: { id: number } }>(
      api.post(`${BASE}/api/v1/users`, {
        data: { email: emails[who], name: people[who], password: PASSWORD },
      }),
    );
    ids[who] = made.user.id;
  }
  for (const [which, role] of [
    ['one', 'Administrators'],
    ['two', 'Administrators'],
    ['three', 'Viewers'],
  ] as const) {
    const res = await api.put(
      `${BASE}/api/v1/tracks/${tracks[which]?.id}/roles/${roles[role]}/users/${ids.lead}`,
    );
    expect(res.status(), await res.text()).toBe(204);
  }

  // Lead drags Alpha onto Beta and names the group.
  await signInAs(api, emails.lead, PASSWORD);
  await visit(page, '#/tracks');
  await expect(page.getByRole('heading', { level: 1, name: 'Tracks' })).toBeVisible();
  const group = `Launch ${stamp}`;
  await drag(
    page,
    page.getByRole('button', { name: `Move ${names.one}` }),
    page.getByRole('link', { name: new RegExp(names.two) }),
    touch,
  );
  const naming = page.getByRole('dialog', { name: 'New group' });
  await expect(naming).toBeVisible();
  await naming.getByLabel('Group name').fill(group);
  await naming.getByRole('button', { name: 'Create group' }).click();
  const bubble = page.getByRole('region', { name: group });
  await expect(bubble.getByRole('link', { name: new RegExp(names.two) })).toBeVisible();
  expect(await keysIn(bubble)).toEqual([tracks.two?.key, tracks.one?.key]);

  // The menus open on the page and above what follows them: Beta's card has Alpha's after it,
  // and on a phone the group's grip sits at the page's start.
  await page.getByRole('button', { name: `Move ${names.two}` }).click();
  expect(await menuReachable(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: `Move or change the group ${group}` }).click();
  expect(await menuReachable(page)).toEqual([]);
  await page.keyboard.press('Escape');

  // Gamma goes in from the keyboard, through its grip's menu, then one place earlier.
  const gamma = page.getByRole('button', { name: `Move ${names.three}` });
  await gamma.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: `Move to ${group}` }).click();
  await expect
    .poll(() => keysIn(bubble))
    .toEqual([tracks.two?.key, tracks.one?.key, tracks.three?.key]);
  await expect(page.getByRole('button', { name: `Move ${names.three}` })).toBeFocused();
  await page.keyboard.press('Alt+ArrowUp');
  await expect
    .poll(() => keysIn(bubble))
    .toEqual([tracks.two?.key, tracks.three?.key, tracks.one?.key]);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // Minimized, it is the size of a card with a count; the server remembers it.
  await page.getByRole('button', { name: `Minimize ${group}` }).click();
  await expect(bubble.getByText('3 tracks')).toBeVisible();
  await expect(bubble.getByRole('link')).toHaveCount(0);
  await visit(page, '#/tracks');
  await expect(page.getByRole('button', { name: `Open ${group}` })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.getByRole('button', { name: `Open ${group}` }).click();
  await expect(bubble.getByRole('link', { name: new RegExp(names.one) })).toBeVisible();

  // Shared with Mate as a member: Lead runs Alpha and Beta, not Gamma.
  await page.getByRole('button', { name: `Move or change the group ${group}` }).click();
  await page.getByRole('menuitem', { name: 'Share…' }).click();
  const dialog = page.getByRole('dialog', { name: `Share ${group}` });
  await dialog.getByLabel('Find a person by name').fill(people.mate);
  await dialog.getByRole('button', { name: `Choose ${people.mate}` }).click();
  await dialog
    .getByLabel('Role on its tracks')
    .selectOption({ label: 'Members, on 2 of 3 tracks' });
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText(
    `Shared with ${people.mate}. Members given on 2 of 3 tracks; they already had it on 0, and you may not give it on 1.`,
  );
  await expect(dialog.getByText(`${people.mate}: Members, on 2 tracks`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(bubble.getByText('Shared with 1 person')).toBeVisible();

  // Mate sees the group as Lead keeps it, with only the tracks the share opened to them.
  await signInAs(api, emails.mate, PASSWORD);
  await visit(page, '#/tracks');
  const shared = page.getByRole('region', { name: group });
  await expect(shared.getByText(`Shared by ${people.lead}`)).toBeVisible();
  await expect.poll(() => keysIn(shared)).toEqual([tracks.two?.key, tracks.one?.key]);
  // Its tracks are Lead's to move: no grip on them for Mate.
  for (const name of [names.one, names.two]) {
    await expect(shared.getByRole('button', { name: `Move ${name}` })).toHaveCount(0);
  }
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // Lead takes it back: Mate loses the group and the tracks it opened.
  await signInAs(api, emails.lead, PASSWORD);
  await visit(page, '#/tracks');
  await page.getByRole('button', { name: `Move or change the group ${group}` }).click();
  await page.getByRole('menuitem', { name: 'Share…' }).click();
  await page
    .getByRole('dialog', { name: `Share ${group}` })
    .getByRole('button', { name: `Take back from ${people.mate}` })
    .click();
  await expect(page.getByText(`Taken back from ${people.mate}.`)).toBeVisible();
  await signInAs(api, emails.mate, PASSWORD);
  await visit(page, '#/tracks');
  // The directory has loaded: empty, or listing tracks this run did not make.
  await expect(page.getByText('No tracks yet').or(page.getByLabel('Find a track'))).toBeVisible();
  await expect(page.getByRole('region', { name: group })).toHaveCount(0);
  for (const name of Object.values(names)) {
    await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(0);
  }
});

test('[IAM-034] a person told of a group shared with them leaves it, and what it gave goes with it', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  // Its own first letter, so no name here contains a name of the test above, run alongside.
  const stamp = `x${testInfo.project.name.replace(/\W/g, '')}${Date.now().toString(36)}`;
  const api = page.request;

  // The administrator makes two tracks that Lead runs, and two people; Mate has nothing.
  await signInAs(api, ADMIN.email, ADMIN.password as string);
  const names = { one: `Delta ${stamp}`, two: `Echo ${stamp}` };
  const tracks: Record<string, { id: number; key: string }> = {};
  for (const [which, name] of Object.entries(names)) {
    const key = `L${which[0]?.toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const made = await ok<{ track: { id: number } }>(
      api.post(`${BASE}/api/v1/tracks`, { data: { key, name, mode: 'shared' } }),
    );
    tracks[which] = { id: made.track.id, key };
  }
  const roles = Object.fromEntries(
    (
      await ok<{ roles: { id: number; name: string }[] }>(api.get(`${BASE}/api/v1/roles`))
    ).roles.map((r) => [r.name, r.id]),
  );
  const people = { lead: `Lead ${stamp}`, mate: `Mate ${stamp}` };
  const emails = {
    lead: `lead.${stamp}@groups.test`.toLowerCase(),
    mate: `mate.${stamp}@groups.test`.toLowerCase(),
  };
  const ids: Record<string, number> = {};
  for (const who of ['lead', 'mate'] as const) {
    const made = await ok<{ user: { id: number } }>(
      api.post(`${BASE}/api/v1/users`, {
        data: { email: emails[who], name: people[who], password: PASSWORD },
      }),
    );
    ids[who] = made.user.id;
  }
  for (const which of ['one', 'two'] as const) {
    const res = await api.put(
      `${BASE}/api/v1/tracks/${tracks[which]?.id}/roles/${roles.Administrators}/users/${ids.lead}`,
    );
    expect(res.status(), await res.text()).toBe(204);
  }

  // Lead groups both tracks and shares the group with Mate as a member.
  await signInAs(api, emails.lead, PASSWORD);
  const group = `Rollout ${stamp}`;
  const made = await ok<{ groupId: number }>(
    api.post(`${BASE}/api/v1/track-groups`, {
      data: { name: group, trackIds: [tracks.one?.id, tracks.two?.id] },
    }),
  );
  await ok(
    api.post(`${BASE}/api/v1/track-groups/${made.groupId}/shares`, {
      data: { userId: ids.mate, roleId: roles.Members },
    }),
  );

  // Mate is told in the inbox: who shared which group, and the role; it leads to the Tracks page.
  await signInAs(api, emails.mate, PASSWORD);
  await visit(page, '#/inbox');
  await expect(
    page.getByText(`${people.lead} shared a track group with you, with the role Members`),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: group }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tracks' })).toBeVisible();
  const shared = page.getByRole('region', { name: group });
  await expect.poll(() => keysIn(shared)).toEqual([tracks.one?.key, tracks.two?.key]);

  // Leaving asks first, saying what goes.
  await page.getByRole('button', { name: `Move or change the group ${group}` }).click();
  expect(await menuReachable(page)).toEqual([]);
  await page.getByRole('menuitem', { name: 'Leave group…' }).click();
  const ask = page.getByRole('dialog', { name: `Leave ${group}?` });
  await expect(ask).toContainText(
    `${group} leaves your Tracks page, and the Members role it gave you goes from 2 tracks.`,
  );
  await expect(ask).toContainText(`Only ${people.lead} can share it with you again.`);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await ask.getByRole('button', { name: 'Leave group' }).press('Enter');

  // The group goes, and so do the tracks it opened, without a reload.
  await expect(page.getByRole('region', { name: group })).toHaveCount(0);
  for (const name of Object.values(names)) {
    await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(0);
  }
  // The page says so, and focus stays on it rather than going with those tracks.
  await expect(page.getByRole('status').filter({ hasText: `You left ${group}.` })).toHaveCount(1);
  await expect(page.locator('main :focus')).toHaveCount(1);
  await visit(page, '#/tracks');
  await expect(page.getByText('No tracks yet').or(page.getByLabel('Find a track'))).toBeVisible();
  await expect(page.getByRole('region', { name: group })).toHaveCount(0);

  // Lead sees it shared with nobody now.
  await signInAs(api, emails.lead, PASSWORD);
  const sharing = await ok<{ shares: unknown[] }>(
    api.get(`${BASE}/api/v1/track-groups/${made.groupId}/shares`),
  );
  expect(sharing.shares).toEqual([]);
});
