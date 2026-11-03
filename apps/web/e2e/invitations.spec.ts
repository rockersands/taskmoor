import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/**
 * Inviting people into a track (IAM-027, IAM-028, IAM-030): a site administrator lets a track's
 * administrators invite; a manager who is no site administrator finds the track under Settings,
 * invites an address with a link to copy (this backend has no mail server, and says so); the
 * invited person chooses a password, lands in that track with that role and sees no other. They
 * use the attachments database (preview 4174), whose site administrator the API server made, on
 * a policy of their own, so no other test sees the permission.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
const PASSWORD = 'ladder violet harbour lantern';

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

async function ok<T>(answer: ReturnType<APIRequestContext['post']>): Promise<T> {
  const res = await answer;
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as T;
}

test('[IAM-027] a manager invites a new person, who lands in that track with that role and no other', async ({
  page,
  browser,
}, testInfo) => {
  const stamp = `${testInfo.project.name.replace(/\W/g, '')}${Date.now()}`;
  const key = `I${stamp
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(-12)}`;
  const api = page.request;

  // A site administrator sets the scene through the API.
  await ok(
    api.post(`${BASE}/api/v1/session`, { data: { email: ADMIN.email, password: ADMIN.password } }),
  );
  const roles = (await (await api.get(`${BASE}/api/v1/roles`)).json()).roles as {
    id: number;
    name: string;
  }[];
  const roleId = (name: string) => roles.find((r) => r.name === name)?.id as number;
  const policies = (await (await api.get(`${BASE}/api/v1/access-policies`)).json()).policies as {
    id: number;
    isDefault: boolean;
  }[];
  const policy = await ok<{ policy: { id: number } }>(
    api.post(`${BASE}/api/v1/access-policies`, {
      data: {
        name: `Invitations ${stamp}`,
        copyFrom: policies.find((p) => p.isDefault)?.id,
      },
    }),
  );
  const made = await ok<{ track: { id: number } }>(
    api.post(`${BASE}/api/v1/tracks`, {
      data: {
        key,
        name: 'Invited work',
        mode: 'shared',
        type: 'business',
        accessPolicyId: policy.policy.id,
      },
    }),
  );
  const managerEmail = `manager.${stamp}@invite.test`.toLowerCase();
  const manager = await ok<{ user: { id: number } }>(
    api.post(`${BASE}/api/v1/users`, {
      data: { email: managerEmail, name: `Manager ${stamp}`, password: PASSWORD },
    }),
  );
  const put = await api.put(
    `${BASE}/api/v1/tracks/${made.track.id}/roles/${roleId('Administrators')}/users/${manager.user.id}`,
  );
  expect(put.status()).toBe(204);
  await api.delete(`${BASE}/api/v1/session`);

  // Inviting is off until a site administrator turns it on.
  await ok(
    api.post(`${BASE}/api/v1/session`, { data: { email: managerEmail, password: PASSWORD } }),
  );
  await page.goto(`${BASE}/#/settings`);
  await page.getByRole('link', { name: 'Tracks you run' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tracks you run' })).toBeVisible();
  await page.getByRole('link', { name: `Manage track ${key}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(key) })).toBeVisible();
  await expect(page.getByText(/Inviting is off for this track/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite people' })).toHaveCount(0);

  // The same browser signs in as the site administrator to give the permission.
  await api.delete(`${BASE}/api/v1/session`);
  await ok(
    api.post(`${BASE}/api/v1/session`, { data: { email: ADMIN.email, password: ADMIN.password } }),
  );
  await ok(
    api.post(`${BASE}/api/v1/access-policies/${policy.policy.id}/grants`, {
      data: { permission: 'invite_people', grantee: 'role', roleId: roleId('Administrators') },
    }),
  );
  await api.delete(`${BASE}/api/v1/session`);
  await ok(
    api.post(`${BASE}/api/v1/session`, { data: { email: managerEmail, password: PASSWORD } }),
  );

  // The manager invites.
  await page.goto(`${BASE}/#/manage/tracks/${made.track.id}`);
  await page.getByRole('button', { name: 'Invite people' }).click();
  const dialog = page.getByRole('dialog', { name: `Invite people to ${key}` });
  await expect(dialog.getByText(/Email is not set up on this site/)).toBeVisible();
  const invited = `guest.${stamp}@invite.test`.toLowerCase();
  await dialog.getByLabel('Email addresses').fill(invited);
  await dialog.getByLabel('Role').selectOption({ label: 'Viewers' });
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await dialog.getByRole('button', { name: 'Make links' }).click();
  const linkBox = dialog.getByRole('textbox', { name: `Link for ${invited}` });
  await expect(linkBox).toHaveValue(/#\/invite\?token=/);
  const link = await linkBox.inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText(invited, { exact: true })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);

  // The invited person, in a browser of their own, takes it up.
  const guest = await browser.newContext({
    viewport: page.viewportSize(),
    baseURL: BASE,
  });
  const guestPage = await guest.newPage();
  await guestPage.goto(new URL(link).hash ? `${BASE}/${new URL(link).hash}` : link);
  await expect(
    guestPage.getByRole('heading', { level: 1, name: new RegExp(`Your invitation to ${key}`) }),
  ).toBeVisible();
  expect(await seriousAxeViolations(guestPage)).toEqual([]);
  expect(await noSidewaysScroll(guestPage)).toBe(true);
  await guestPage.getByLabel('Your name').fill('Guest Person');
  await guestPage.getByLabel('New password', { exact: true }).fill(PASSWORD);
  await guestPage.getByLabel('Confirm new password', { exact: true }).fill(PASSWORD);
  await guestPage.getByRole('button', { name: 'Continue' }).click();
  await expect(guestPage).toHaveURL(new RegExp(`#/tracks/${key}`));

  // That role is in force, in that track only.
  const permissions = await (
    await guest.request.get(`${BASE}/api/v1/me/permissions?trackId=${made.track.id}`)
  ).json();
  expect(permissions.track).toContain('browse_track');
  expect(permissions.track).not.toContain('create_tickets');
  expect(permissions.track).not.toContain('administer_track');
  expect(permissions.global).not.toContain('site_admin');
  const tracks = (await (await guest.request.get(`${BASE}/api/v1/tracks?limit=200`)).json())
    .tracks as { key: string }[];
  expect(tracks.map((t) => t.key)).toEqual([key]);
  // The link is spent.
  const again = await guest.request.post(`${BASE}/api/v1/invitations/inspect`, {
    data: { token: new URL(link.replace('/#/', '/')).searchParams.get('token') },
  });
  expect(again.status()).toBe(404);
  await guest.close();

  // The manager sees the person holding the role, and may take it away.
  await page.goto(`${BASE}/#/manage/tracks/${made.track.id}`);
  await expect(page.getByText('Guest Person: Viewers')).toBeVisible();
  await page.getByRole('button', { name: 'Remove Guest Person from Viewers' }).click();
  await expect(page.getByText('Guest Person no longer holds Viewers.')).toBeVisible();
  await expect(page.getByText('No invitations are waiting.')).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
});
