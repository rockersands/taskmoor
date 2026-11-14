import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { uniqueRun } from './unique';

/**
 * Clone and deep clone end to end (M1-124, CORE-023): the Clone action on the ticket view starts
 * the copies, the API server's bulk job loop makes them, and the dialog opens the copy. It uses
 * the attachments database (preview 4174), whose administrator and ATT track the API server
 * made; the deep clone sets up a level above Outcome and two tracks of its own.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

interface Ticket {
  id: number;
  key: string;
  summary: string;
  track: { key: string };
  ticketType: { name: string };
  parent: { key: string | null } | null;
}

async function signIn(request: APIRequestContext) {
  const res = await request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(res.status()).toBe(200);
}

async function call<T>(
  request: APIRequestContext,
  method: 'get' | 'post',
  path: string,
  data?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await request[method](`${BASE}/api/v1${path}`, data === undefined ? {} : { data });
  const text = await res.text();
  return { status: res.status(), body: (text ? JSON.parse(text) : null) as T };
}

async function make(request: APIRequestContext, data: Record<string, unknown>): Promise<Ticket> {
  const res = await call<{ ticket: Ticket }>(request, 'post', '/tickets', data);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.ticket;
}

const children = async (request: APIRequestContext, key: string) =>
  (await call<{ tickets: Ticket[] }>(request, 'get', `/tickets?parent=${key}`)).body.tickets;
const linkTexts = async (request: APIRequestContext, key: string) =>
  (
    await call<{ links: { phrase: string; ticket: { key: string } }[] }>(
      request,
      'get',
      `/tickets/${key}/links`,
    )
  ).body.links
    .map((l) => `${l.phrase} ${l.ticket.key}`)
    .sort();

/** Clones the ticket open on the page through the dialog, and lands on the copy. */
async function cloneOnPage(page: Page, sourceKey: string, choose: () => Promise<void>) {
  await page.getByRole('button', { name: 'Clone', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Clone ${sourceKey}` });
  await expect(dialog).toBeVisible();
  await choose();
  await dialog.getByRole('button', { name: 'Clone', exact: true }).click();
  // The copies are made in the background; the dialog then opens the first one.
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const shownKey = async () =>
    (
      (await page
        .getByRole('heading', { level: 1 })
        .textContent({ timeout: 1000 })
        .catch(() => '')) ?? ''
    ).split(' ')[0] as string;
  await expect.poll(shownKey, { timeout: 30_000 }).not.toMatch(new RegExp(`^(${sourceKey})?$`));
  return shownKey();
}

test('[CORE-023] (1) clones a ticket with its subtickets, attachments and links; the copies copy their originals', async ({
  page,
}, testInfo) => {
  await signIn(page.request);
  const name = testInfo.project.name;
  const types = (
    await call<{ ticketTypes: { id: number; name: string }[] }>(
      page.request,
      'get',
      '/tracks/ATT/ticket-types',
    )
  ).body.ticketTypes;
  const subticket = types.find((t) => t.name === 'Subticket')?.id;
  const other = await make(page.request, { track: 'ATT', summary: `Card API outage ${name}` });
  const source = await make(page.request, {
    track: 'ATT',
    summary: `Refunds fail on ${name}`,
    labels: ['payments'],
  });
  const subs = [
    await make(page.request, {
      track: 'ATT',
      summary: 'Find the cause',
      parent: source.key,
      ticketTypeId: subticket,
    }),
    await make(page.request, {
      track: 'ATT',
      summary: 'Write the fix',
      parent: source.key,
      ticketTypeId: subticket,
    }),
  ];
  const linkTypes = (
    await call<{ linkTypes: { id: number; name: string }[] }>(page.request, 'get', '/link-types')
  ).body.linkTypes;
  const blocks = linkTypes.find((t) => t.name === 'Blocks')?.id;
  expect(
    (
      await call(page.request, 'post', `/tickets/${source.key}/links`, {
        linkTypeId: blocks,
        ticket: other.key,
      })
    ).status,
  ).toBe(201);
  const upload = await page.request.post(`${BASE}/api/v1/tickets/${source.key}/attachments`, {
    multipart: {
      file: { name: 'trace.txt', mimeType: 'text/plain', buffer: Buffer.from('card expired\n') },
    },
  });
  expect(upload.status(), await upload.text()).toBe(201);

  await page.goto(`${BASE}/#/tickets/${source.key}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(source.key);
  const copyKey = await cloneOnPage(page, source.key, async () => {
    const dialog = page.getByRole('dialog');
    // Everything comes by default.
    for (const label of ['Subtickets', 'Attachments', 'Links and web links']) {
      await expect(dialog.getByLabel(label)).toBeChecked();
    }
  });
  expect(copyKey).toMatch(/^ATT-\d+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    `${copyKey} Refunds fail on ${name}`,
  );
  // On the copy: its Copies link, the original's link, its file.
  const links = page.getByRole('region', { name: 'Links' });
  await expect(links.getByText('copies')).toBeVisible();
  await expect(links.getByRole('link', { name: source.key })).toBeVisible();
  await expect(links.getByRole('link', { name: other.key })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Attachments' }).getByText('trace.txt'),
  ).toBeVisible();

  expect(await linkTexts(page.request, copyKey)).toEqual(
    [`blocks ${other.key}`, `copies ${source.key}`].sort(),
  );
  // The subtickets came along under the copy, each a copy of its own original.
  const copiedSubs = await children(page.request, copyKey);
  expect(copiedSubs.map((t) => t.summary)).toEqual(['Find the cause', 'Write the fix']);
  for (const [i, sub] of copiedSubs.entries()) {
    expect(await linkTexts(page.request, sub.key)).toEqual([`copies ${subs[i]?.key}`]);
  }
  // The original is untouched but for its side of the link.
  expect(await linkTexts(page.request, source.key)).toEqual(
    [`blocks ${other.key}`, `is copied by ${copyKey}`].sort(),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

/** Something shared by both projects' runs: found, else made, else found (the other made it). */
async function ensure<T>(find: () => Promise<T | undefined>, create: () => Promise<number>) {
  const found = await find();
  if (found !== undefined) return found;
  const status = await create();
  expect([201, 409]).toContain(status);
  const made = await find();
  expect(made).toBeDefined();
  return made as T;
}

test('[CORE-023] (2) deep-clones an objective with its outcome, features and subtickets, three levels below it, into another track', async ({
  page,
}, testInfo) => {
  await signIn(page.request);
  const request = page.request;
  // A level above Outcome, a type at it, and a type set with it (CORE-006).
  const level = await ensure(
    async () =>
      (
        await call<{ levels: { id: number; name: string }[] }>(request, 'get', '/hierarchy-levels')
      ).body.levels.find((l) => l.name === 'Objective'),
    async () => (await call(request, 'post', '/hierarchy-levels', { name: 'Objective' })).status,
  );
  const allTypes = async () =>
    (await call<{ ticketTypes: { id: number; name: string }[] }>(request, 'get', '/ticket-types'))
      .body.ticketTypes;
  const objective = await ensure(
    async () => (await allTypes()).find((t) => t.name === 'Objective'),
    async () =>
      (await call(request, 'post', '/ticket-types', { name: 'Objective', levelId: level.id }))
        .status,
  );
  const types = Object.fromEntries((await allTypes()).map((t) => [t.name, t.id]));
  const typeSet = await ensure(
    async () =>
      (
        await call<{ typeSets: { id: number; name: string }[] }>(request, 'get', '/type-sets')
      ).body.typeSets.find((s) => s.name === 'Clone e2e'),
    async () =>
      (
        await call(request, 'post', '/type-sets', {
          name: 'Clone e2e',
          ticketTypeIds: [objective.id, types.Outcome, types.Feature, types.Subticket],
          defaultTypeId: types.Feature,
        })
      ).status,
  );
  // Two tracks of this run's own.
  const stamp = uniqueRun(testInfo);
  const [from, to] = [`DF${stamp}`, `DT${stamp}`];
  for (const key of [from, to]) {
    const res = await call(request, 'post', '/tracks', {
      key,
      name: `Deep clone ${key}`,
      mode: 'shared',
      typeSetId: typeSet.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
  const top = await make(request, {
    track: from,
    summary: 'Grow card payments',
    ticketTypeId: objective.id,
  });
  const outcome = await make(request, {
    track: from,
    summary: 'Checkout in one step',
    ticketTypeId: types.Outcome,
    parent: top.key,
  });
  const features = [
    await make(request, {
      track: from,
      summary: 'Saved cards',
      ticketTypeId: types.Feature,
      parent: outcome.key,
    }),
    await make(request, {
      track: from,
      summary: 'Wallet buttons',
      ticketTypeId: types.Feature,
      parent: outcome.key,
    }),
  ];
  for (const [i, feature] of features.entries()) {
    await make(request, {
      track: from,
      summary: `Part ${i + 1}`,
      ticketTypeId: types.Subticket,
      parent: feature.key,
    });
  }

  await page.goto(`${BASE}/#/tickets/${top.key}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(top.key);
  const copyKey = await cloneOnPage(page, top.key, async () => {
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Track').selectOption(to);
    await dialog.getByLabel('Everything below it, at every level (deep clone)').check();
  });
  expect(copyKey).toMatch(new RegExp(`^${to}-\\d+$`));

  // The whole tree, three levels below the objective, now in the other track.
  const [outcomeCopy, ...extra] = await children(request, copyKey);
  expect(extra).toEqual([]);
  expect(outcomeCopy).toMatchObject({
    summary: 'Checkout in one step',
    track: { key: to },
    ticketType: { name: 'Outcome' },
  });
  const featureCopies = await children(request, outcomeCopy?.key as string);
  expect(featureCopies.map((t) => [t.summary, t.track.key, t.ticketType.name])).toEqual([
    ['Saved cards', to, 'Feature'],
    ['Wallet buttons', to, 'Feature'],
  ]);
  for (const [i, feature] of featureCopies.entries()) {
    const parts = await children(request, feature.key);
    expect(parts.map((t) => [t.summary, t.track.key, t.ticketType.name])).toEqual([
      [`Part ${i + 1}`, to, 'Subticket'],
    ]);
    expect(await linkTexts(request, feature.key)).toEqual([`copies ${features[i]?.key}`]);
  }
  // The originals stay where they were.
  expect((await children(request, outcome.key)).map((t) => t.key)).toEqual(
    features.map((f) => f.key),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
