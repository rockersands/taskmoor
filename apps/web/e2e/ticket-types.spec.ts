import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { uniqueKey, uniqueStamp } from './unique';

/**
 * Ticket types and levels, and the type set settings, end to end (T-320; CORE-005 to CORE-007):
 * a site administrator adds a level on top of the ladder and a type at it, moves the type to the
 * standard level, removes the level after its preview and deletes the type; then orders a type
 * set, and drops a type that a ticket still has, mapping the ticket to a kept type of its level.
 * No serious axe issue, no sideways scroll. They use the attachments database (preview 4174),
 * whose site administrator the API server made.
 *
 * The level goes on top of the ladder, above the Objective level the deep clone test uses (made
 * here first if it is not there yet), so no parent link of another test's tickets changes while
 * it exists.
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

async function call<T>(
  request: APIRequestContext,
  method: 'get' | 'post' | 'delete',
  path: string,
  data?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await request[method](`${BASE}/api/v1${path}`, data === undefined ? {} : { data });
  const text = await res.text();
  return { status: res.status(), body: (text ? JSON.parse(text) : null) as T };
}

async function signIn(page: Page) {
  const res = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(res.status()).toBe(200);
}

/** The level the deep clone test puts its objectives at, right above Outcome. */
async function ensureObjectiveLevel(request: APIRequestContext) {
  const find = async () =>
    (
      await call<{ levels: { name: string }[] }>(request, 'get', '/hierarchy-levels')
    ).body.levels.find((l) => l.name === 'Objective');
  if (await find()) return;
  const made = await call(request, 'post', '/hierarchy-levels', { name: 'Objective' });
  // The other project may have made it meanwhile.
  expect([201, 409]).toContain(made.status);
}

/**
 * Takes away a level and a type this test made, if a failure left them: the database is shared,
 * and a level left on top would sit above every level added later.
 */
async function removeLeftovers(request: APIRequestContext, level: string, type: string) {
  const levels = await call<{ levels: { id: number; name: string }[] }>(
    request,
    'get',
    '/hierarchy-levels',
  );
  const left = levels.body.levels.find((l) => l.name === level);
  if (left) await call(request, 'delete', `/hierarchy-levels/${left.id}`);
  const types = await call<{ ticketTypes: { id: number; name: string }[] }>(
    request,
    'get',
    '/ticket-types',
  );
  const leftType = types.body.ticketTypes.find((t) => t.name === type);
  if (leftType) await call(request, 'delete', `/ticket-types/${leftType.id}`);
}

const fitsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test('[CORE-006] the administrator adds a level and a type at it, moves the type, and removes both', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await ensureObjectiveLevel(page.request);
  const stamp = uniqueStamp(testInfo);
  const level = `Theme ${stamp}`;
  const type = `Study ${stamp}`;
  try {
    await page.goto(`${BASE}/#/admin/ticket-types`);
    await expect(page.getByRole('heading', { level: 1, name: 'Ticket types' })).toBeVisible();

    // A new level goes on top unless another place is chosen.
    await page.getByRole('button', { name: 'New level' }).click();
    const addLevel = page.getByRole('form', { name: 'Add a level' });
    await addLevel.getByLabel('Level name').fill(level);
    await addLevel.getByRole('button', { name: 'Add a level' }).click();
    await expect(page.getByText(`The level ${level} was added.`)).toBeVisible();
    const levelCard = page.getByRole('region', { name: level });
    await expect(levelCard.getByText('No ticket type sits at this level.')).toBeVisible();

    // A type at the new level, with the idea's shape.
    await page.getByRole('button', { name: 'New ticket type' }).click();
    const addType = page.getByRole('form', { name: 'Add a ticket type' });
    await addType.getByLabel('Ticket type name').fill(type);
    await addType.getByLabel('Level').selectOption({ label: level });
    await addType.getByLabel('Idea', { exact: true }).check();
    await addType.getByRole('button', { name: 'Add a ticket type' }).click();
    await expect(page.getByText(`${type} was added.`)).toBeVisible();
    await expect(
      levelCard.getByRole('button', { name: `Manage ticket type ${type}` }),
    ).toBeVisible();

    // Open, it moves to the standard level; the page says first what that does.
    const settings = page.getByRole('form', { name: `Settings of ${type}` });
    await settings.getByLabel('Level').selectOption({ label: 'Standard' });
    await expect(settings.getByText('No ticket of this type changes level.')).toBeVisible();
    await settings.getByRole('button', { name: 'Save the type' }).click();
    await expect(page.getByText(`${type} was saved.`)).toBeVisible();
    await expect(levelCard.getByText('No ticket type sits at this level.')).toBeVisible();
    expect(await seriousAxeViolations(page)).toEqual([]);

    // Removing the level asks first, saying what it would do (CORE-007).
    await levelCard.getByRole('button', { name: `Remove level ${level}` }).click();
    const question = levelCard.getByRole('group', { name: /^Remove / });
    await expect(question).toContainText('No ticket type sits at it.');
    await question.getByRole('button', { name: `Remove level ${level}` }).click();
    await expect(page.getByText(`The level ${level} was removed.`)).toBeVisible();
    await expect(page.getByRole('region', { name: level })).toHaveCount(0);

    // The type goes too, once asked.
    const open = page.getByRole('form', { name: `Settings of ${type}` });
    if ((await open.count()) === 0) {
      await page.getByRole('button', { name: `Manage ticket type ${type}` }).click();
    }
    await open.getByRole('button', { name: `Delete ticket type ${type}` }).click();
    await open
      .getByRole('group', { name: /^Delete / })
      .getByRole('button', { name: `Delete ticket type ${type}` })
      .click();
    await expect(page.getByText(`${type} was deleted.`)).toBeVisible();
    expect(await fitsSideways(page)).toBe(true);
  } finally {
    await removeLeftovers(page.request, level, type);
  }
});

test('[CORE-005] the administrator orders a type set, and maps the tickets of a type it drops', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const request = page.request;
  const types = Object.fromEntries(
    (
      await call<{ ticketTypes: { id: number; name: string; trackId: number | null }[] }>(
        request,
        'get',
        '/ticket-types',
      )
    ).body.ticketTypes
      .filter((t) => t.trackId === null)
      .map((t) => [t.name, t.id]),
  );
  const setName = `Mapped types ${uniqueStamp(testInfo)}`;
  const made = await call<{ typeSet: { id: number } }>(request, 'post', '/type-sets', {
    name: setName,
    ticketTypeIds: [types.Bug, types.Chore],
    defaultTypeId: types.Bug,
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const key = uniqueKey('TM', testInfo);
  const track = await call(request, 'post', '/tracks', {
    key,
    name: `Mapped ${key}`,
    mode: 'shared',
    typeSetId: made.body.typeSet.id,
  });
  expect(track.status, JSON.stringify(track.body)).toBe(201);
  const ticket = await call<{ ticket: { key: string } }>(request, 'post', '/tickets', {
    track: key,
    summary: 'Crash on save',
    ticketTypeId: types.Bug,
  });
  expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);

  await page.goto(`${BASE}/#/admin/configuration-sets`);
  await page.getByRole('button', { name: `Manage ${setName}` }).click();
  const panel = page.getByRole('form', { name: `Settings of ${setName}` });

  // Chore first, and preselected.
  await panel.getByRole('button', { name: 'Move Chore up' }).click();
  await expect(panel.getByRole('button', { name: 'Move Chore down' })).toBeFocused();
  await panel.getByLabel('Preselected type').selectOption({ label: 'Chore' });

  // Bug goes, but a ticket has it: the page asks which kept type it takes.
  await panel
    .getByRole('group', { name: 'Ticket types in the set' })
    .getByLabel('Bug', { exact: true })
    .uncheck();
  await panel.getByRole('button', { name: 'Save the set' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Tickets have a type the set would drop: choose the type they take below, then save again.',
  );
  const target = panel.getByLabel('Tickets of Bug become');
  await expect(target).toBeFocused();
  await target.selectOption({ label: 'Chore' });
  expect(await seriousAxeViolations(page)).toEqual([]);
  await panel.getByRole('button', { name: 'Save the set' }).click();
  await expect(page.getByText(`${setName} was saved; 1 ticket took another type.`)).toBeVisible();

  const after = await call<{ ticket: { ticketType: { name: string } } }>(
    request,
    'get',
    `/tickets/${ticket.body.ticket.key}`,
  );
  expect(after.body.ticket.ticketType.name).toBe('Chore');
  const set = await call<{ typeSet: { defaultTypeId: number; ticketTypes: { id: number }[] } }>(
    request,
    'get',
    `/type-sets/${made.body.typeSet.id}`,
  );
  expect(set.body.typeSet.defaultTypeId).toBe(types.Chore);
  expect(set.body.typeSet.ticketTypes.map((t) => t.id)).toEqual([types.Chore]);
  expect(await fitsSideways(page)).toBe(true);
});
