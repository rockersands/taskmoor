import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { uniqueKey, uniqueStamp } from './unique';

/**
 * A local-mode track's own workflow map and visibility policy, and configuration administrators
 * on Visibility policies (T-322; WF-001 (3), IAM-011, IAM-030, IAM-009): a person who is no
 * administrator runs a track with its own configuration. From its Manage page they open its own
 * workflow map, give a type the track's own workflow and save; then its own visibility policies,
 * add one with a level and a member, and make the track use it. A configuration administrator
 * finds Visibility policies in Administration, adds a shared policy with a level and deletes it.
 * No serious axe issue and no sideways scroll, on a desktop and a phone. Every track, person,
 * workflow and policy is the test's own; nothing shared changes. It uses the attachments
 * database (preview 4174), whose site administrator the API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
const PASSWORD = 'harbour lantern ladder violet';

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

/** What reaches past the right of the window, so a failure names it; empty when nothing does. */
const sideways = (page: Page) =>
  page.evaluate(() => {
    if (document.documentElement.scrollWidth <= innerWidth) return [];
    return [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5)
      .filter(
        (el) => ![...el.children].some((c) => c.getBoundingClientRect().right > innerWidth + 0.5),
      )
      .slice(0, 8)
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
  });

async function ok<T>(answer: ReturnType<APIRequestContext['post']>): Promise<T> {
  const res = await answer;
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as T;
}

async function signInAs(api: APIRequestContext, email: string, password: string) {
  await api.delete(`${BASE}/api/v1/session`);
  await ok(api.post(`${BASE}/api/v1/session`, { data: { email, password } }));
}

/**
 * Opens a page of the app afresh: after a change of who is signed in, a hash change alone would
 * keep the session the app read when it loaded.
 */
async function visit(page: Page, hash: string) {
  await page.goto('about:blank');
  await page.goto(`${BASE}/${hash}`);
}

/** A person of the test's own, with a password, made by the site administrator. */
async function person(api: APIRequestContext, email: string, name: string) {
  return (
    await ok<{ user: { id: number } }>(
      api.post(`${BASE}/api/v1/users`, { data: { email, name, password: PASSWORD } }),
    )
  ).user.id;
}

test('[WF-001] [IAM-011] [IAM-030] someone who runs a track changes its own workflow map and visibility policy', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const stamp = uniqueStamp(testInfo);
  const key = uniqueKey('OF', testInfo);
  const api = page.request;

  // A site administrator makes a track with its own configuration, a workflow of its own, and a
  // person who runs only that track.
  await signInAs(api, ADMIN.email, ADMIN.password as string);
  const trackId = (
    await ok<{ track: { id: number } }>(
      api.post(`${BASE}/api/v1/tracks`, {
        data: { key, name: `Own flow ${stamp}`, mode: 'local', type: 'business' },
      }),
    )
  ).track.id;
  const statuses = (
    (await (await api.get(`${BASE}/api/v1/statuses`)).json()) as {
      statuses: { id: number; stage: string }[];
    }
  ).statuses;
  const open = statuses.find((s) => s.stage !== 'closed') as { id: number };
  const closed = statuses.find((s) => s.stage === 'closed') as { id: number };
  const ownFlow = `Runbook flow ${stamp}`;
  await ok(
    api.post(`${BASE}/api/v1/workflows`, {
      data: {
        name: ownFlow,
        trackId,
        definition: {
          initialStatusId: open.id,
          statuses: [{ statusId: open.id }, { statusId: closed.id }],
        },
      },
    }),
  );
  const offered = (
    (await (await api.get(`${BASE}/api/v1/tracks/${trackId}/workflow-map`)).json()) as {
      ticketTypes: { ticketType: { name: string } }[];
    }
  ).ticketTypes;
  const type = offered[0]?.ticketType.name as string;
  const email = `runner.${stamp}@ownflow.test`.toLowerCase();
  const runner = await person(api, email, `Runner ${stamp}`);
  const roles = (await (await api.get(`${BASE}/api/v1/roles`)).json()).roles as {
    id: number;
    name: string;
  }[];
  const administrators = roles.find((r) => r.name === 'Administrators')?.id as number;
  const appointed = await api.put(
    `${BASE}/api/v1/tracks/${trackId}/roles/${administrators}/users/${runner}`,
  );
  expect(appointed.status()).toBe(204);

  // The person signs in. Their track's Manage page leads to its own workflow map.
  await signInAs(api, email, PASSWORD);
  await visit(page, `#/manage/tracks/${trackId}`);
  const own = page.getByRole('region', { name: 'Its own configuration' });
  await own
    .getByRole('link', { name: 'Workflow map: which workflow each of its ticket types follows' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/manage/tracks/${trackId}/workflow-map$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Workflow map' })).toBeVisible();
  const map = page.getByRole('form', { name: `Workflows in ${key} workflows` });
  await map
    .getByRole('combobox', { name: 'Give a type its own workflow' })
    .selectOption({ label: type });
  await map.getByRole('button', { name: 'Add' }).click();
  await map
    .getByRole('combobox', { name: `${type} follows` })
    .selectOption({ label: `${ownFlow} (${key}’s own)` });
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await sideways(page)).toEqual([]);
  await map.getByRole('button', { name: 'Save the map' }).click();
  await expect(page.getByText(`${key} workflows was saved.`)).toBeVisible();
  const saved = (
    (await (await api.get(`${BASE}/api/v1/tracks/${trackId}/workflow-map`)).json()) as {
      ticketTypes: { ticketType: { name: string }; workflow: { name: string } }[];
    }
  ).ticketTypes;
  expect(saved.find((t) => t.ticketType.name === type)?.workflow.name).toBe(ownFlow);

  // Its own visibility policies: none yet, so the track's tickets have no levels.
  await visit(page, `#/manage/tracks/${trackId}`);
  await page
    .getByRole('region', { name: 'Its own configuration' })
    .getByRole('link', { name: 'Visibility policies: which of its tickets only some people see' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/manage/tracks/${trackId}/visibility-policies$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Visibility policies' })).toBeVisible();
  await expect(
    page.getByText(`${key} uses no visibility policy now`, { exact: false }),
  ).toBeVisible();
  const policy = `Incidents ${stamp}`;
  await page.getByRole('button', { name: 'New visibility policy' }).click();
  const add = page.getByRole('form', { name: 'Add a visibility policy' });
  await add.getByLabel('Policy name').fill(policy);
  await add.getByRole('button', { name: 'Add a visibility policy' }).click();
  const panel = page.getByRole('region', { name: policy });
  await expect(panel).toBeVisible();
  const level = panel.getByRole('form', { name: `Add a level to ${policy}` });
  await level.getByLabel('Level name').fill('Major');
  await level.getByRole('button', { name: 'Add a level' }).click();
  await expect(page.getByText('Level Major was added.')).toBeVisible();
  const member = panel.getByRole('form', { name: 'Add a member to Major' });
  await member.getByLabel('Who').selectOption({ label: 'The assignee' });
  await member.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('The assignee joined Major.')).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await sideways(page)).toEqual([]);

  await panel.getByRole('button', { name: `Use this policy for ${key}` }).click();
  await expect(page.getByText(`${key} now uses ${policy}.`)).toBeVisible();
  await expect(page.getByText(`${key} uses ${policy}.`)).toBeVisible();
  const track = (
    (await (await api.get(`${BASE}/api/v1/tracks/${trackId}`)).json()) as {
      track: { visibilityPolicyId: number | null };
    }
  ).track;
  const policies = (
    (await (await api.get(`${BASE}/api/v1/visibility-policies?trackId=${trackId}`)).json()) as {
      visibilityPolicies: { id: number; name: string }[];
    }
  ).visibilityPolicies;
  expect(track.visibilityPolicyId).toBe(policies.find((p) => p.name === policy)?.id);
});

test('[IAM-009] [IAM-011] a configuration administrator finds Visibility policies and manages a shared one', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const stamp = uniqueStamp(testInfo);
  const api = page.request;

  // A site administrator makes a person of the test's own a configuration administrator.
  await signInAs(api, ADMIN.email, ADMIN.password as string);
  const email = `setup.${stamp}@ownflow.test`.toLowerCase();
  const userId = await person(api, email, `Setup ${stamp}`);
  const { grant } = await ok<{ grant: { id: number } }>(
    api.post(`${BASE}/api/v1/global-grants`, {
      data: { permission: 'configuration_admin', grantee: 'user', userId },
    }),
  );

  try {
    await signInAs(api, email, PASSWORD);
    await visit(page, '#/admin');
    // The app reads the session once it has loaded: until then there is neither the overview nor
    // the bar, and isVisible() does not wait for them.
    await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible();
    // On a phone the list of pages is a closed bar first.
    const bar = page.getByText('Administration pages', { exact: true });
    if (await bar.isVisible()) await bar.click();
    const pages = page.getByRole('navigation', { name: 'Administration pages' });
    await pages.getByRole('link', { name: 'Visibility policies' }).click();
    await expect(page).toHaveURL(/#\/admin\/visibility$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Visibility policies' }),
    ).toBeVisible();
    await expect(page.getByText(/^Only site/)).toHaveCount(0);

    const policy = `Legal ${stamp}`;
    await page.getByRole('button', { name: 'New visibility policy' }).click();
    const add = page.getByRole('form', { name: 'Add a visibility policy' });
    await add.getByLabel('Policy name').fill(policy);
    await add.getByRole('button', { name: 'Add a visibility policy' }).click();
    const panel = page.getByRole('region', { name: policy });
    await expect(panel).toBeVisible();
    const level = panel.getByRole('form', { name: `Add a level to ${policy}` });
    await level.getByLabel('Level name').fill('Counsel');
    await level.getByRole('button', { name: 'Add a level' }).click();
    await expect(page.getByText('Level Counsel was added.')).toBeVisible();
    expect(await seriousAxeViolations(page)).toEqual([]);
    expect(await sideways(page)).toEqual([]);

    // Asks first, saying what will happen (D13); no track uses it, so it goes.
    await panel.getByRole('button', { name: `Delete policy ${policy}` }).click();
    await panel
      .getByRole('group', { name: new RegExp(`^Delete ${policy}`) })
      .getByRole('button', { name: `Delete policy ${policy}` })
      .click();
    await expect(page.getByText(`Policy ${policy} was deleted.`)).toBeVisible();
    await expect(page.getByRole('region', { name: policy })).toHaveCount(0);
  } finally {
    await signInAs(api, ADMIN.email, ADMIN.password as string);
    await api.delete(`${BASE}/api/v1/global-grants/${grant.id}`);
  }
});
