import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { uniqueKey, uniqueStamp } from './unique';

/**
 * Inviting people into a track (IAM-027, IAM-028, IAM-030): a site administrator lets a track's
 * administrators invite; a manager who is no site administrator finds the track in Administration,
 * invites an address with a link to copy (this backend has no mail server, and says so); the
 * invited person chooses a password, lands in that track with that role and sees no other. They
 * use the attachments database (preview 4174), whose site administrator the API server made, on
 * a policy of their own, so no other test sees the permission.
 *
 * Where a site sends email only site administrators copy links (T-053). This backend sends none,
 * so the server's own rule is proven in invitations.test.ts; here the list's answer is changed to
 * that of a site with email, to see what the manager's page does with it.
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
  test.setTimeout(90_000);
  const stamp = uniqueStamp(testInfo);
  const key = uniqueKey('I', testInfo);
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
  await page.goto(`${BASE}/#/admin`);
  await page.getByRole('link', { name: 'Tracks you run' }).first().click();
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

  // The manager invites. Same address as before, so a reload reads the page again.
  await page.reload();
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
  await page.reload();
  await expect(page.getByText('Guest Person: Viewers')).toBeVisible();
  await page.getByRole('button', { name: 'Remove Guest Person from Viewers' }).click();
  // Said in the place of the row taken away (T-248), and told to a screen reader.
  await expect(
    page
      .getByRole('region', { name: 'Who holds which role' })
      .getByRole('listitem')
      .filter({ hasText: 'Guest Person no longer holds Viewers.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Guest Person no longer holds Viewers.' }),
  ).toHaveCount(1);
  await expect(page.getByText('No invitations are waiting.')).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);

  // With no mail server anyone who invites may copy links: the answer says so (T-053).
  const list = await (await api.get(`${BASE}/api/v1/tracks/${made.track.id}/invitations`)).json();
  expect(list).toMatchObject({ emailAvailable: false, canCopyLinks: true });

  // Where the site sends email, a manager's invitations go by email: no link to copy.
  const later = `later.${stamp}@invite.test`.toLowerCase();
  await ok(
    api.post(`${BASE}/api/v1/tracks/${made.track.id}/invitations`, {
      data: { addresses: [later], roleId: roleId('Viewers'), delivery: 'link' },
    }),
  );
  await page.route(`**/api/v1/tracks/${made.track.id}/invitations`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const answer = await route.fetch();
    await route.fulfill({
      response: answer,
      json: { ...(await answer.json()), emailAvailable: true, canCopyLinks: false },
    });
  });
  await page.reload();
  const byEmail =
    'Your invitations go by email: on a site that sends email, only site administrators copy links.';
  await expect(page.getByText(byEmail)).toBeVisible();
  await expect(page.getByRole('button', { name: `Send again to ${later}` })).toBeVisible();
  await expect(page.getByRole('button', { name: `Make a new link for ${later}` })).toHaveCount(0);
  await page.getByRole('button', { name: 'Invite people' }).click();
  const emailOnly = page.getByRole('dialog', { name: `Invite people to ${key}` });
  await expect(emailOnly.getByText(byEmail)).toBeVisible();
  await expect(emailOnly.getByRole('radio')).toHaveCount(0);
  await expect(emailOnly.getByRole('button', { name: 'Send invitations' })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await emailOnly.getByRole('button', { name: 'Cancel' }).click();
  await page.unroute(`**/api/v1/tracks/${made.track.id}/invitations`);

  // In Spanish, whose words run longer, the dialog still fits the screen (ADR-033; T-249).
  await page.goto(`${BASE}/?locale=es${new URL(page.url()).hash}`);
  await page.getByRole('button', { name: 'Invitar personas' }).click();
  const spanish = page.getByRole('dialog', { name: `Invitar personas a ${key}` });
  await spanish.getByLabel('Rol').selectOption({ label: 'Viewers' });
  await expect(spanish.getByRole('button', { name: 'Crear enlaces' })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
});
