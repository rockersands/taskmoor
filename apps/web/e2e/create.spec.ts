import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import { chooseTrack } from './pickers';
import { uniqueKey } from './unique';

/**
 * The create dialog honours layouts per ticket type (M1-052; CORE-008, CORE-013): a track of
 * its own gets two create layouts, one per ticket type, and a rule that makes Environment
 * required for the first. The dialog, opened with C, shows each type's fields and no others,
 * refuses the first type without its environment and creates it once given. The home page then
 * lists a ticket assigned to the person, opened by them and followed. Custom person, group,
 * team, release and area fields are set with their pickers, and a ticket template's values fill
 * them (T-276). No serious axe issue. It uses the attachments database (preview 4174), whose site administrator the API
 * server made.
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

test('[CORE-008] [CORE-013] the create dialog shows each ticket type its own layout', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  const api = async (method: 'post' | 'patch' | 'get', path: string, data?: unknown) => {
    const res = await page.request[method](`${BASE}/api/v1${path}`, data ? { data } : {});
    expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
    return res.json();
  };

  // A track of its own, so other tests' tracks keep their forms.
  const key = uniqueKey('L', testInfo);
  const { track } = await api('post', '/tracks', {
    key,
    name: `Layouts ${testInfo.project.name}`,
    mode: 'shared',
  });
  const { ticketTypes } = await api('get', `/tracks/${key}/ticket-types`);
  const [report, plan] = ticketTypes as { id: number; name: string }[];
  if (!report || !plan) throw new Error('the track needs two ticket types');
  const { fieldRuleSet } = await api('post', '/field-rule-sets', {
    name: `Rules ${key}`,
    rules: [{ ticketTypeId: report.id, field: 'environment', required: true }],
  });
  const tab = (name: string, fields: string[]) => ({
    tabs: [{ name, sections: [{ fields }] }],
    others: 'omit',
  });
  const { layoutSet } = await api('post', '/layout-sets', {
    name: `Layouts ${key}`,
    layouts: [
      {
        ticketTypeId: report.id,
        operation: 'create',
        definition: tab('What happened', ['summary', 'environment']),
      },
      {
        ticketTypeId: plan.id,
        operation: 'create',
        definition: tab('When', ['summary', 'dueDate']),
      },
    ],
  });
  await api('patch', `/tracks/${track.id}`, {
    fieldRuleSetId: fieldRuleSet.id,
    layoutSetId: layoutSet.id,
  });

  await page.goto(`${BASE}/#/home`);
  await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible();
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'Create ticket' });
  await expect(dialog).toBeVisible();
  await chooseTrack(dialog, key);
  const type = dialog.getByLabel('Ticket type');

  // The first type: its tab, Environment required, no due date.
  const chooseType = async (name: string) => {
    await type.click();
    await dialog.getByRole('option', { name, exact: true }).click();
  };
  await chooseType(report.name);
  await expect(dialog.getByRole('region', { name: 'What happened' })).toBeVisible();
  await expect(dialog.getByLabel('Environment (required)')).toBeVisible();
  await expect(dialog.getByLabel('Due date')).toHaveCount(0);
  // The second: its tab, a due date, no environment.
  await chooseType(plan.name);
  await expect(dialog.getByRole('region', { name: 'When' })).toBeVisible();
  await expect(dialog.getByLabel('Due date')).toBeVisible();
  await expect(dialog.getByLabel(/^Environment/)).toHaveCount(0);
  expect(await seriousAxeViolations(page)).toEqual([]);

  // Back to the first: refused without its environment, created with it.
  await chooseType(report.name);
  await expect(dialog.getByLabel('Environment (required)')).toBeVisible();
  await dialog
    .getByLabel('Summary (required)')
    .fill(`Checkout times out on ${testInfo.project.name}`);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Some fields need attention before the ticket can be created.',
  );
  await dialog.getByLabel('Environment (required)').click();
  await page.keyboard.type('Safari 18 on a phone');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const made = dialog.getByText(new RegExp(`^${key}-\\d+ was created\\.$`));
  await expect(made).toBeVisible();
  const ticketKey = ((await made.textContent()) ?? '').split(' ')[0] as string;
  await dialog.getByRole('link', { name: `Open ${ticketKey}` }).click();
  await expect(dialog).toBeHidden();
  // It opens in the pop-up, over the page the dialog was on.
  await expect(
    page.getByRole('dialog', { name: new RegExp(`^${ticketKey} `) }).getByRole('heading', {
      level: 1,
    }),
  ).toContainText(ticketKey);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('[CORE-008] [CORE-013] [IAM-010] the create dialog sets the assignee a layout requires, the parent, releases, areas and a person field', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  const api = async (method: 'post' | 'patch' | 'get', path: string, data?: unknown) => {
    const res = await page.request[method](`${BASE}/api/v1${path}`, data ? { data } : {});
    expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
    return res.json();
  };
  const me = (await api('get', '/session')).user as { id: number; name: string };

  // A track of its own, with a release, an area, an outcome to sit under and a person field.
  const key = `P${testInfo.project.name[0]?.toUpperCase()}${Date.now() % 10_000_000}`;
  const { track } = await api('post', '/tracks', {
    key,
    name: `Pickers ${testInfo.project.name}`,
    mode: 'shared',
  });
  const { ticketTypes, defaultTypeId } = (await api('get', `/tracks/${key}/ticket-types`)) as {
    defaultTypeId: number;
    ticketTypes: { id: number; name: string }[];
  };
  const outcomeType = ticketTypes.find((t) => t.name === 'Outcome');
  const child =
    ticketTypes.find((t) => t.name === 'Feature') ??
    ticketTypes.find((t) => t.id === defaultTypeId);
  if (!outcomeType || !child) throw new Error('the track needs an Outcome and a type below it');
  await api('post', `/tracks/${track.id}/releases`, { name: 'Spring' });
  await api('post', `/tracks/${track.id}/areas`, { name: 'Checkout' });
  const { ticket: outcome } = await api('post', '/tickets', {
    track: key,
    ticketTypeId: outcomeType.id,
    summary: `Faster checkout ${key}`,
  });
  const reviewerName = `Reviewer ${key}`;
  const { field } = await api('post', '/fields', {
    name: reviewerName,
    type: 'user',
    context: { trackIds: [track.id] },
  });
  const { fieldRuleSet } = await api('post', '/field-rule-sets', {
    name: `Rules ${key}`,
    rules: [{ ticketTypeId: child.id, field: 'assignee', required: true }],
  });
  const { layoutSet } = await api('post', '/layout-sets', {
    name: `Layouts ${key}`,
    layouts: [
      {
        ticketTypeId: child.id,
        operation: 'create',
        definition: {
          tabs: [
            {
              name: 'Who and where',
              sections: [
                {
                  fields: [
                    'summary',
                    'assignee',
                    'parent',
                    'targetRelease',
                    'area',
                    `cf[${field.id}]`,
                  ],
                },
              ],
            },
          ],
          others: 'omit',
        },
      },
    ],
  });
  await api('patch', `/tracks/${track.id}`, {
    fieldRuleSetId: fieldRuleSet.id,
    layoutSetId: layoutSet.id,
  });

  await page.goto(`${BASE}/#/home`);
  await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible();
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'Create ticket' });
  await expect(dialog).toBeVisible();
  await chooseTrack(dialog, key);
  await dialog.getByLabel('Ticket type').click();
  await dialog.getByRole('option', { name: child.name, exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'Who and where' })).toBeVisible();
  await dialog.getByLabel('Summary (required)').fill(`Pay by card ${testInfo.project.name}`);
  // Every picker empty, some below the dialog's fold: no serious axe issue.
  await expect(dialog.getByRole('searchbox', { name: reviewerName })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);

  // The assignee, required by the layout, among those who may be given tickets here.
  const assignee = dialog.getByRole('searchbox', { name: 'Assignee (required)' });
  await assignee.fill(me.name.slice(0, 3));
  await dialog.getByRole('button', { name: me.name, exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: `Remove ${me.name}`, exact: true }),
  ).toBeVisible();
  // The parent, found by words of its summary.
  await dialog.getByRole('combobox', { name: 'Parent' }).fill('Faster checkout');
  await dialog.getByRole('option', { name: new RegExp(outcome.key) }).click();
  await expect(
    dialog.getByRole('button', { name: `Remove ${outcome.key} as parent` }),
  ).toBeVisible();
  // A release and an area, a checkbox each.
  await dialog.getByRole('group', { name: 'Target releases' }).getByLabel('Spring').check();
  await dialog.getByRole('group', { name: 'Areas' }).getByLabel('Checkout').check();
  // The person field.
  await dialog.getByRole('searchbox', { name: reviewerName }).fill(me.name.slice(0, 3));
  await dialog.getByRole('button', { name: me.name, exact: true }).click();
  await expect(dialog.getByRole('list', { name: reviewerName })).toContainText(me.name);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const made = dialog.getByText(new RegExp(`^${key}-\\d+ was created\\.$`));
  await expect(made).toBeVisible();
  const ticketKey = ((await made.textContent()) ?? '').split(' ')[0] as string;
  const { ticket } = await api('get', `/tickets/${ticketKey}`);
  expect(ticket.assignee?.id).toBe(me.id);
  expect(ticket.parent?.key).toBe(outcome.key);
  expect((ticket.targetReleases as { name: string }[]).map((r) => r.name)).toEqual(['Spring']);
  expect((ticket.areas as { name: string }[]).map((a) => a.name)).toEqual(['Checkout']);
  expect(ticket.fields?.[String(field.id)]).toEqual({ id: me.id, name: me.name });
});

test('[CORE-008] [CORE-010] [CORE-009] [CORE-006] the create dialog sets the requester and group, team, release and area fields, offering only valid parents and allowed people', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  const api = async (method: 'post' | 'patch' | 'get' | 'put', path: string, data?: unknown) => {
    const res = await page.request[method](`${BASE}/api/v1${path}`, data ? { data } : {});
    expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
    return res.status() === 204 ? null : res.json();
  };
  const me = (await api('get', '/session')).user as { id: number; name: string };

  // A track of its own; someone else to be the requester and the only one who may approve.
  const key = uniqueKey('Q', testInfo);
  const { track } = await api('post', '/tracks', {
    key,
    name: `More pickers ${testInfo.project.name}`,
    mode: 'shared',
  });
  const rae = (
    await api('post', '/users', {
      email: `rae.${key.toLowerCase()}@attach.test`,
      name: `Rae ${key}`,
    })
  ).user as { id: number; name: string };
  const { group } = await api('post', '/groups', { name: `Approvers ${key}` });
  await api('put', `/groups/${group.id}/members/${rae.id}`);
  const { team } = await api('post', '/teams', { name: `Ledger team ${key}` });
  const { team: squad } = await api('post', '/teams', { name: `Ledger squad ${key}` });
  const { release: autumn } = await api('post', `/tracks/${track.id}/releases`, { name: 'Autumn' });
  const { area: billing } = await api('post', `/tracks/${track.id}/areas`, { name: 'Billing' });
  const { ticketTypes } = (await api('get', `/tracks/${key}/ticket-types`)) as {
    ticketTypes: { id: number; name: string }[];
  };
  const outcomeType = ticketTypes.find((t) => t.name === 'Outcome');
  const child = ticketTypes.find((t) => t.name === 'Feature');
  if (!outcomeType || !child) throw new Error('the track needs an Outcome and a Feature');
  // Two tickets whose summaries match: only the Outcome may hold a Feature.
  const { ticket: outcome } = await api('post', '/tickets', {
    track: key,
    ticketTypeId: outcomeType.id,
    summary: `Ledger rework ${key}`,
  });
  const { ticket: sibling } = await api('post', '/tickets', {
    track: key,
    ticketTypeId: child.id,
    summary: `Ledger cleanup ${key}`,
  });
  const context = { trackIds: [track.id] };
  const made = async (name: string, type: string, more: Record<string, unknown> = {}) =>
    (await api('post', '/fields', { name: `${name} ${key}`, type, context, ...more })).field as {
      id: number;
      name: string;
    };
  const approver = await made('Approver', 'user', {
    context: { ...context, config: { userGroupId: group.id } },
  });
  const owning = await made('Owning group', 'group');
  const ledgerTeam = await made('Team', 'team');
  const fixedIn = await made('Fixed in', 'release');
  const parts = await made('Parts', 'area', { multiple: true });
  const { layoutSet } = await api('post', '/layout-sets', {
    name: `Layouts ${key}`,
    layouts: [
      {
        ticketTypeId: child.id,
        operation: 'create',
        definition: {
          tabs: [
            {
              name: 'Who and what',
              sections: [
                {
                  fields: [
                    'summary',
                    'requester',
                    'parent',
                    ...[approver, owning, ledgerTeam, fixedIn, parts].map((f) => `cf[${f.id}]`),
                  ],
                },
              ],
            },
          ],
          others: 'omit',
        },
      },
    ],
  });
  await api('patch', `/tracks/${track.id}`, { layoutSetId: layoutSet.id });

  await page.goto(`${BASE}/#/home`);
  await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible();
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'Create ticket' });
  await expect(dialog).toBeVisible();
  await chooseTrack(dialog, key);
  await dialog.getByLabel('Ticket type').click();
  await dialog.getByRole('option', { name: child.name, exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'Who and what' })).toBeVisible();
  await dialog.getByLabel('Summary (required)').fill(`Split invoices ${testInfo.project.name}`);
  expect(await seriousAxeViolations(page)).toEqual([]);

  // The requester: someone else than the person creating.
  await dialog.getByRole('searchbox', { name: 'Requester' }).fill(rae.name);
  await dialog.getByRole('button', { name: rae.name, exact: true }).click();
  await expect(dialog.getByRole('list', { name: 'Requester' })).toContainText(rae.name);
  // The parent: the Outcome is offered, the Feature beside it is not.
  await dialog.getByRole('combobox', { name: 'Parent' }).fill(`Ledger ${key}`);
  await expect(dialog.getByRole('option', { name: new RegExp(outcome.key) })).toBeVisible();
  await expect(dialog.getByRole('option', { name: new RegExp(sibling.key) })).toHaveCount(0);
  await dialog.getByRole('option', { name: new RegExp(outcome.key) }).click();
  // The approver: only the group's people, so not the person creating.
  const approverSearch = dialog.getByRole('searchbox', { name: approver.name });
  await approverSearch.fill(me.name);
  await expect(dialog.getByText('No one matches.')).toBeVisible();
  await approverSearch.fill(rae.name);
  await dialog.getByRole('button', { name: rae.name, exact: true }).click();
  // A group and a team by name (T-276); a release from a list; an area ticked.
  await dialog.getByRole('searchbox', { name: owning.name }).fill(`Approvers ${key}`);
  await dialog.getByRole('button', { name: `Approvers ${key}`, exact: true }).click();
  await dialog.getByRole('searchbox', { name: ledgerTeam.name }).fill(`Ledger team ${key}`);
  await dialog.getByRole('button', { name: team.name, exact: true }).click();
  await dialog.getByRole('combobox', { name: fixedIn.name }).selectOption('Autumn');
  await dialog.getByRole('group', { name: parts.name }).getByLabel('Billing').check();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const madeText = dialog.getByText(new RegExp(`^${key}-\\d+ was created\\.$`));
  await expect(madeText).toBeVisible();
  const ticketKey = ((await madeText.textContent()) ?? '').split(' ')[0] as string;
  const { ticket } = await api('get', `/tickets/${ticketKey}`);
  expect(ticket.requester?.id).toBe(rae.id);
  expect(ticket.parent?.key).toBe(outcome.key);
  expect(ticket.fields?.[String(approver.id)]).toEqual({ id: rae.id, name: rae.name });
  expect(ticket.fields?.[String(owning.id)]).toEqual({ id: group.id, name: `Approvers ${key}` });
  expect(ticket.fields?.[String(ledgerTeam.id)]).toEqual({ id: team.id, name: team.name });
  expect(ticket.fields?.[String(fixedIn.id)]).toMatchObject({ name: 'Autumn' });
  expect(ticket.fields?.[String(parts.id)]).toMatchObject([{ name: 'Billing' }]);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();

  // A ticket template with the same values fills the same pickers (T-276); a team chosen in
  // the form instead wins.
  const templateName = `Ledger split ${key}`;
  await api('post', '/ticket-templates', {
    track: key,
    name: templateName,
    summary: 'Split from a template',
    ticketTypeIds: [child.id],
    defaults: {
      fields: {
        [approver.id]: rae.id,
        [owning.id]: group.id,
        [ledgerTeam.id]: team.id,
        [fixedIn.id]: autumn.id,
        [parts.id]: [billing.id],
      },
    },
  });
  await page.goto(`${BASE}/#/home`);
  await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible();
  await page.keyboard.press('c');
  await expect(dialog).toBeVisible();
  await chooseTrack(dialog, key);
  await dialog.getByLabel('Ticket type').click();
  await dialog.getByRole('option', { name: child.name, exact: true }).click();
  // The track's releases and areas are here before the template is chosen.
  await expect(dialog.getByRole('group', { name: parts.name }).getByLabel('Billing')).toBeVisible();
  const startFrom = dialog.getByRole('combobox', { name: 'Start from a template' });
  await expect(startFrom).toBeEnabled();
  await startFrom.selectOption({ label: templateName });
  await expect(dialog.getByLabel('Summary (required)')).toHaveValue('Split from a template');
  await expect(dialog.getByRole('list', { name: approver.name })).toContainText(rae.name);
  await expect(dialog.getByRole('list', { name: owning.name })).toContainText(`Approvers ${key}`);
  await expect(dialog.getByRole('list', { name: ledgerTeam.name })).toContainText(team.name);
  await expect(dialog.getByRole('combobox', { name: fixedIn.name })).toHaveValue(String(autumn.id));
  await expect(dialog.getByRole('group', { name: parts.name }).getByLabel('Billing')).toBeChecked();
  await expect(dialog.getByRole('group', { name: 'Also from this template' })).toHaveCount(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: `Remove ${team.name}` }).click();
  await dialog.getByRole('searchbox', { name: ledgerTeam.name }).fill(`Ledger squad ${key}`);
  await dialog.getByRole('button', { name: squad.name, exact: true }).click();
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const fromTemplate = dialog.getByText(new RegExp(`^${key}-\\d+ was created\\.$`));
  await expect(fromTemplate).toBeVisible();
  const templated = (
    await api('get', `/tickets/${((await fromTemplate.textContent()) ?? '').split(' ')[0]}`)
  ).ticket;
  expect(templated.fields?.[String(approver.id)]).toEqual({ id: rae.id, name: rae.name });
  expect(templated.fields?.[String(owning.id)]).toEqual({
    id: group.id,
    name: `Approvers ${key}`,
  });
  expect(templated.fields?.[String(ledgerTeam.id)]).toEqual({ id: squad.id, name: squad.name });
  expect(templated.fields?.[String(fixedIn.id)]).toMatchObject({ name: 'Autumn' });
  expect(templated.fields?.[String(parts.id)]).toMatchObject([{ name: 'Billing' }]);
});

test('[AGL-019] the home page lists what is assigned to me, what I opened and what I follow', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(signIn.status()).toBe(200);
  const me = (await (await page.request.get(`${BASE}/api/v1/session`)).json()).user.id as number;
  const made = await page.request.post(`${BASE}/api/v1/tickets`, {
    data: { track: 'ATT', summary: `Home check on ${testInfo.project.name} ${Date.now()}` },
  });
  expect(made.status()).toBe(201);
  const ticket = (await made.json()).ticket as { id: number; key: string; summary: string };
  const assign = await page.request.patch(`${BASE}/api/v1/tickets/${ticket.id}`, {
    data: { assigneeId: me },
  });
  expect(assign.status()).toBe(200);

  // Opening the ticket puts it among those opened lately; the visit is recorded in the
  // background, so wait for it before going home.
  const visited = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().includes(`/me/recent-tickets/${ticket.id}`),
  );
  await page.goto(`${BASE}/#/tickets/${ticket.key}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(ticket.key);
  expect((await visited).ok()).toBe(true);
  await page.goto(`${BASE}/#/home`);
  const link = `${ticket.key} ${ticket.summary}`;
  const assigned = page.getByRole('region', { name: 'Assigned to you' });
  await expect(assigned.getByRole('link', { name: link })).toBeVisible();
  const recent = page.getByRole('region', { name: 'Opened lately' });
  // Other journeys open tickets as Ada at the same time, so it is in the list, not always first.
  await expect(recent.getByRole('link', { name: link })).toBeVisible();
  const followed = page.getByRole('region', { name: 'You follow' });
  await expect(followed.getByRole('link', { name: link })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await assigned.getByRole('link', { name: link }).click();
  await expect(
    page.getByRole('dialog', { name: link }).getByRole('heading', { level: 1 }),
  ).toContainText(ticket.key);
});
