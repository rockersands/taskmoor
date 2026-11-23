import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { uniqueKey, uniqueStamp } from './unique';

/**
 * A track's settings that were API-only before T-322, end to end: a site administrator deletes a
 * track to the trash, after the question that says what goes with it, and restores it from Trash;
 * switches a shared-mode track's access policy and type set on Which sets a track uses, mapping
 * the tickets of the type the new set lacks; and sees that a local-mode track keeps its own. Each
 * test makes its own tracks, type sets and policy with names no other test uses, and changes
 * nothing it did not make. No serious axe issue, no sideways scroll. They use the attachments
 * database (preview 4174), whose site administrator the API server made.
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

/** A track of this test's own, made through the API. */
async function makeTrack(
  request: APIRequestContext,
  key: string,
  body: Record<string, unknown> = {},
): Promise<number> {
  const made = await call<{ track: { id: number } }>(request, 'post', '/tracks', {
    key,
    name: `Settings ${key}`,
    mode: 'shared',
    ...body,
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.track.id;
}

const fitsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test('[CORE-025] the administrator deletes a track to the trash and restores it from Trash', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const key = uniqueKey('TD', testInfo);
  await makeTrack(page.request, key);

  await page.goto(`${BASE}/#/admin/tracks`);
  await expect(page.getByRole('heading', { level: 1, name: 'Tracks' })).toBeVisible();
  await page.getByRole('button', { name: `Manage track ${key}` }).click();
  await page.getByRole('button', { name: `Delete track ${key}` }).click();

  // Asks first, saying what goes to the trash and that Trash brings it back (D13).
  const question = page.getByRole('group', { name: new RegExp(`^${key} goes to the trash`) });
  await expect(question).toContainText('with its tickets, releases and areas');
  await expect(question).toContainText('restored from Trash');
  await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await question.getByRole('button', { name: `Delete track ${key}` }).click();
  await expect(page.getByText(`Track ${key} is in the trash.`)).toBeVisible();
  await expect(page.getByRole('button', { name: `Manage track ${key}` })).toHaveCount(0);
  expect(await fitsSideways(page)).toBe(true);

  // Trash brings it back.
  await page.getByRole('link', { name: `Restore ${key} from Trash` }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trash' })).toBeVisible();
  await page.getByRole('button', { name: `Restore track ${key}` }).click();
  await expect(page.getByText(`Track ${key} is back.`)).toBeVisible();
  await page.goto(`${BASE}/#/admin/tracks`);
  await expect(page.getByRole('button', { name: `Manage track ${key}` })).toBeVisible();
});

test('[CORE-005] [IAM-010] the administrator switches a shared-mode track’s access policy and type set, mapping its tickets', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const request = page.request;
  const stamp = uniqueStamp(testInfo);
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
  const bug = types.Bug;
  const chore = types.Chore;
  if (bug === undefined || chore === undefined)
    throw new Error('The site has no Bug or Chore type');
  // Two type sets of this test's own: the track's, and one that lacks Bug.
  const makeSet = async (name: string, ticketTypeIds: number[]) => {
    const made = await call<{ typeSet: { id: number } }>(request, 'post', '/type-sets', {
      name,
      ticketTypeIds,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.typeSet.id;
  };
  const from = await makeSet(`Bugs and chores ${stamp}`, [bug, chore]);
  const toName = `Chores only ${stamp}`;
  const to = await makeSet(toName, [chore]);
  // An access policy of this test's own, a copy of the default one.
  const policies = await call<{ policies: { id: number; isDefault: boolean }[] }>(
    request,
    'get',
    '/access-policies',
  );
  const policyName = `Settings policy ${stamp}`;
  const policy = await call<{ policy: { id: number } }>(request, 'post', '/access-policies', {
    name: policyName,
    copyFrom: policies.body.policies.find((p) => p.isDefault)?.id,
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(201);
  const key = uniqueKey('TS', testInfo);
  const trackId = await makeTrack(request, key, { typeSetId: from });
  const ticket = await call<{ ticket: { key: string } }>(request, 'post', '/tickets', {
    track: key,
    summary: 'Crash on save',
    ticketTypeId: bug,
  });
  expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);

  await page.goto(`${BASE}/#/admin/track-sets?track=${trackId}`);
  const form = page.getByRole('form', { name: `Sets of ${key}` });
  await form.getByRole('combobox', { name: 'Access policy' }).selectOption({ label: policyName });
  await form.getByRole('combobox', { name: 'Type set' }).selectOption({ label: toName });
  await form.getByRole('button', { name: 'Save' }).click();

  // The ticket's Bug is not in the new set: the page asks which type it takes.
  await expect(form.getByRole('alert')).toHaveText(
    `Tickets in ${key} have a type ${toName} lacks: choose the type they take, then save again.`,
  );
  const question = form.getByRole('group', { name: `Tickets of the types ${toName} lacks` });
  const target = question.getByRole('combobox', { name: 'Tickets of Bug become' });
  await expect(target).toBeFocused();
  await target.selectOption({ label: 'Chore' });
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await fitsSideways(page)).toBe(true);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByText(`${key} was saved; 1 ticket took another type.`)).toBeVisible();

  const track = await call<{ track: { accessPolicyId: number; typeSetId: number } }>(
    request,
    'get',
    `/tracks/${trackId}`,
  );
  expect(track.body.track).toMatchObject({
    accessPolicyId: policy.body.policy.id,
    typeSetId: to,
  });
  const after = await call<{ ticket: { ticketType: { name: string } } }>(
    request,
    'get',
    `/tickets/${ticket.body.ticket.key}`,
  );
  expect(after.body.ticket.ticketType.name).toBe('Chore');
});

test('[IAM-010] a local-mode track keeps its own access policy and type set, and says where each changes', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const key = uniqueKey('TL', testInfo);
  const trackId = await makeTrack(page.request, key, { mode: 'local' });

  await page.goto(`${BASE}/#/admin/track-sets?track=${trackId}`);
  const form = page.getByRole('form', { name: `Sets of ${key}` });
  await expect(
    form.getByText(
      `${key} has its own access policy and type set. Its administrators change the type set on its own Configuration sets page, and the access policy through the API.`,
    ),
  ).toBeVisible();
  await expect(form.getByRole('combobox', { name: 'Access policy' })).toHaveCount(0);
  await expect(form.getByRole('combobox', { name: 'Type set' })).toHaveCount(0);
  await form.getByRole('link', { name: `Open the configuration sets of ${key}` }).click();
  await expect(page).toHaveURL(new RegExp(`#/manage/tracks/${trackId}/configuration-sets$`));
  expect(await fitsSideways(page)).toBe(true);
});
