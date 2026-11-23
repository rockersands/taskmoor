import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import { uniqueKey, uniqueStamp } from './unique';

/**
 * T-320 (UI-T21 wave 1), controls that were API-only, on their pages: a track's switch to a
 * workflow map whose workflow lacks its tickets' status asks where they go and moves them
 * (WF-001, WF-002); a group is renamed and given a service account, and the account renamed
 * (IAM-008, IAM-007); a permission and a visibility level go to the people in a user field,
 * chosen by the field's name (IAM-010, IAM-011). No serious axe issue, no sideways scroll. They
 * use the attachments database (preview 4174), whose site administrator the API server made.
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

async function signIn(page: Page) {
  const res = await page.request.post(`${BASE}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(res.status()).toBe(200);
}

/** Posts through the signed-in session and returns the answer's JSON, failing on an error. */
async function post<T>(page: Page, path: string, data: object): Promise<T> {
  const res = await page.request.post(`${BASE}/api/v1${path}`, { data });
  expect(res.status(), `${path}: ${await res.text()}`).toBe(201);
  return (await res.json()) as T;
}

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test('[WF-001] [WF-002] a track switches to a map whose workflow lacks its tickets’ status, and they move where chosen', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const stamp = uniqueStamp(testInfo);
  const key = uniqueKey('SM', testInfo);
  await post(page, '/tracks', { key, name: `Mapped ${stamp}`, mode: 'shared' });
  const { ticket } = await post<{
    ticket: { key: string; status: { id: number; name: string } };
  }>(page, '/tickets', { track: key, summary: 'Waits for its new status' });

  // A workflow of a status of its own and a closed one, which the ticket is in neither of.
  const parked = `Parked ${stamp}`;
  const { status } = await post<{ status: { id: number } }>(page, '/statuses', {
    name: parked,
    stage: 'active',
  });
  const statuses = (
    (await (await page.request.get(`${BASE}/api/v1/statuses`)).json()) as {
      statuses: { id: number; stage: string }[];
    }
  ).statuses;
  const closed = statuses.find((s) => s.stage === 'closed' && s.id !== ticket.status.id);
  const { workflow } = await post<{ workflow: { id: number } }>(page, '/workflows', {
    name: `Parking ${stamp}`,
    definition: {
      initialStatusId: status.id,
      statuses: [{ statusId: status.id }, ...(closed ? [{ statusId: closed.id }] : [])],
    },
  });
  const map = `Parking map ${stamp}`;
  await post(page, '/workflow-maps', { name: map, defaultWorkflowId: workflow.id });

  await page.goto(`${BASE}/#/admin/tracks`);
  await page.getByRole('button', { name: `Manage track ${key}` }).click();
  await page.getByRole('combobox', { name: 'Workflow map' }).selectOption({ label: map });
  const step = page.getByRole('form', { name: `Switch ${key} to ${map}` });
  await expect(step).toContainText('1 ticket is in statuses the new workflows lack.');
  await expect(step.getByRole('heading', { name: `Switch ${key} to ${map}` })).toBeFocused();
  // Nothing is chosen for the administrator.
  await step.getByRole('button', { name: 'Switch and move the tickets' }).click();
  await expect(step.getByRole('alert')).toHaveText('Choose a status for each, then confirm.');
  const choice = step.getByRole('combobox', {
    name: new RegExp(`^Move the 1 .+ ticket in ${ticket.status.name} to$`),
  });
  await choice.selectOption({ label: parked });
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await step.getByRole('button', { name: 'Switch and move the tickets' }).click();
  await expect(
    page.getByText(`Track ${key} uses ${map} now. 1 ticket moved to its new status.`),
  ).toBeVisible();
  await expect(page.getByRole('form', { name: `Switch ${key} to ${map}` })).toHaveCount(0);
  const moved = await page.request.get(`${BASE}/api/v1/tickets/${ticket.key}`);
  expect(
    ((await moved.json()) as { ticket: { status: { name: string } } }).ticket.status.name,
  ).toBe(parked);
});

test('[IAM-008] [IAM-007] a group is renamed and given a service account, which is renamed too', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const stamp = uniqueStamp(testInfo);
  const { group } = await post<{ group: { id: number } }>(page, '/groups', {
    name: `Robots ${stamp}`,
  });
  const account = `Builder ${stamp}`;
  const { serviceAccount } = await post<{ serviceAccount: { id: number } }>(
    page,
    '/service-accounts',
    { name: account, description: 'Builds the site' },
  );

  await page.goto(`${BASE}/#/admin/groups`);
  await page.getByRole('button', { name: `Manage Robots ${stamp}` }).click();
  const details = page.getByRole('form', { name: `Name and description of Robots ${stamp}` });
  await details.getByLabel('Group name').fill(`Machines ${stamp}`);
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`Machines ${stamp} was saved.`)).toBeVisible();
  await expect(page.getByText(`Members of Machines ${stamp}`)).toBeVisible();

  await page.getByRole('combobox', { name: 'Add a service account' }).selectOption({
    label: account,
  });
  await page.getByRole('button', { name: 'Add the account' }).click();
  await expect(page.getByText(`${account} is in Machines ${stamp} now.`)).toBeVisible();
  const member = page.getByRole('listitem').filter({ hasText: `${account} · ` });
  await expect(member.getByText('Service account', { exact: true })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  await page.goto(`${BASE}/#/admin/service-accounts`);
  await page.getByRole('button', { name: `Change the name and description of ${account}` }).click();
  const change = page.getByRole('form', { name: `Change the name and description of ${account}` });
  await change.getByLabel('Name', { exact: true }).fill(`Builder bot ${stamp}`);
  await change.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`Builder bot ${stamp} was saved.`)).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);

  // Tidy up: the group goes, the account stops.
  await page.request.delete(`${BASE}/api/v1/groups/${group.id}`);
  await page.request.post(`${BASE}/api/v1/service-accounts/${serviceAccount.id}/deactivate`);
});

test('[IAM-010] [IAM-011] a permission and a visibility level go to the people in a user field, by its name', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const stamp = uniqueStamp(testInfo);
  const field = `Reviewer ${stamp}`;
  const made = await post<{ field: { id: number } }>(page, '/fields', {
    name: field,
    type: 'user',
  });
  const policyName = `Reviewed ${stamp}`;
  const { policy } = await post<{ policy: { id: number } }>(page, '/access-policies', {
    name: policyName,
  });
  const levels = `Levels ${stamp}`;
  const visibility = await page.request.post(`${BASE}/api/v1/visibility-policies`, {
    data: { name: levels },
  });
  expect(visibility.status(), await visibility.text()).toBe(201);
  const listed = (
    (await (await page.request.get(`${BASE}/api/v1/visibility-policies`)).json()) as {
      visibilityPolicies: { id: number; name: string }[];
    }
  ).visibilityPolicies;
  const levelPolicy = listed.find((p) => p.name === levels)?.id as number;
  const level = `Inner ${stamp}`;
  await post(page, `/visibility-policies/${levelPolicy}/levels`, { name: level });

  await page.goto(`${BASE}/#/admin/permissions`);
  await page.getByRole('button', { name: `Manage ${policyName}` }).click();
  await page.getByRole('button', { name: `New permission in ${policyName}` }).click();
  const give = page.getByRole('form', { name: `Give a permission in ${policyName}` });
  await give.getByLabel('Permission').selectOption('edit_tickets');
  await give.getByLabel('To').selectOption({ label: 'People in a user field' });
  await give.getByRole('combobox', { name: 'User field' }).selectOption({ label: field });
  await give.getByRole('button', { name: 'Give' }).click();
  await expect(page.getByText(`Edit tickets was given to People in field ${field}.`)).toBeVisible();
  await expect(
    page.getByRole('button', { name: `Remove People in field ${field} from Edit tickets` }),
  ).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  await page.goto(`${BASE}/#/admin/visibility`);
  const add = page.getByRole('form', { name: `Add a member to ${level}` });
  await add.getByLabel('Who').selectOption({ label: 'People in a user field' });
  await add.getByRole('combobox', { name: 'User field' }).selectOption({ label: field });
  await add.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText(`People in field ${field} joined ${level}.`)).toBeVisible();
  await expect(
    page.getByRole('list', { name: `Members of ${level}` }).getByText(`People in field ${field}`),
  ).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);

  // Tidy up: the policies, then the field they named.
  await page.request.delete(`${BASE}/api/v1/access-policies/${policy.id}`);
  await page.request.delete(`${BASE}/api/v1/visibility-policies/${levelPolicy}`);
  await page.request.delete(`${BASE}/api/v1/fields/${made.field.id}`);
});
