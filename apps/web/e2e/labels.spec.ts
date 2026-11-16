import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { uniqueKey, uniqueStamp } from './unique';

/**
 * The Labels page (T-322; CORE-017): a site administrator finds three ways of writing one label
 * by how they start, merges two of them into the third on every ticket, after the question that
 * says what changes, and renames another. No serious axe issue, no sideways scroll, and on a phone
 * finger-sized boxes and buttons. They use the attachments database (preview 4174), whose site
 * administrator the API server made.
 *
 * Labels are the site's, shared by every test of the run: this one makes its own track and
 * tickets, and its labels all start with its own stamp, so it finds, merges and renames only
 * labels no other test has, and runs on both projects.
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
  const res = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(res.status()).toBe(200);
}

const fitsWidth = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

async function newTicket(request: APIRequestContext, track: string, labels: string[]) {
  const res = await request.post(`${BASE}/api/v1/tickets`, {
    data: { track, summary: `Labelled ${labels.join(' ')}`, labels },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).ticket.key as string;
}

const labelsOf = async (request: APIRequestContext, key: string) =>
  (await (await request.get(`${BASE}/api/v1/tickets/${key}`)).json()).ticket.labels as string[];

test('[CORE-017] the administrator merges labels into one and renames another', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const stamp = uniqueStamp(testInfo);
  const key = uniqueKey('LB', testInfo);
  const track = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Labels ${stamp}`, mode: 'shared' },
  });
  expect(track.status(), await track.text()).toBe(201);
  const frontEnd = `${stamp}-front-end`;
  const fe = `${stamp}-fe`;
  const frontend = `${stamp}-frontend`;
  const ui = `${stamp}-ui`;
  const one = await newTicket(page.request, key, [frontEnd, ui]);
  const two = await newTicket(page.request, key, [fe]);
  const three = await newTicket(page.request, key, [frontEnd, frontend]);

  await page.goto(`${BASE}/#/admin/labels`);
  await expect(page.getByRole('heading', { level: 1, name: 'Labels' })).toBeVisible();
  const list = page.getByRole('region', { name: 'Labels on this site' });
  const merge = page.getByRole('region', { name: 'Merge or rename' });
  await list.getByLabel('Find labels that start with').fill(stamp);
  const boxes = list.getByRole('checkbox');
  await expect(boxes).toHaveCount(4);
  await expect(list.getByRole('checkbox', { name: frontEnd })).toHaveAccessibleDescription(
    '2 tickets',
  );
  await expect(list.getByRole('checkbox', { name: fe })).toHaveAccessibleDescription('1 ticket');

  // Two ways of writing it go into the third, after the question.
  await list.getByRole('checkbox', { name: frontEnd }).check();
  await list.getByRole('checkbox', { name: fe }).check();
  await merge.getByLabel('They become').fill(frontend);
  await expect(
    merge.getByText(`Ticked: ${frontEnd} (2 tickets) and ${fe} (1 ticket).`),
  ).toBeVisible();
  await merge.getByRole('button', { name: 'Merge', exact: true }).click();
  const question = merge.getByRole('group', {
    name: new RegExp(`^Merge ${frontEnd} and ${fe} into ${frontend}\\?`),
  });
  await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await question.getByRole('button', { name: `Merge into ${frontend}` }).click();
  await expect(
    merge.getByText(`${frontEnd} and ${fe} became ${frontend} on 3 tickets.`),
  ).toBeVisible();
  expect(await labelsOf(page.request, one)).toEqual([frontend, ui]);
  expect(await labelsOf(page.request, two)).toEqual([frontend]);
  expect(await labelsOf(page.request, three)).toEqual([frontend]);
  await expect(boxes).toHaveCount(2);
  await expect(list.getByRole('checkbox', { name: frontend })).toHaveAccessibleDescription(
    '3 tickets',
  );

  // One label and a new word: a rename.
  const renamed = `${stamp}-interface`;
  await list.getByRole('checkbox', { name: ui }).check();
  await merge.getByLabel('They become').fill(renamed);
  await merge.getByRole('button', { name: 'Rename', exact: true }).click();
  await merge.getByRole('button', { name: `Rename ${ui} to ${renamed}` }).click();
  await expect(merge.getByText(`${ui} became ${renamed} on 1 ticket.`)).toBeVisible();
  expect(await labelsOf(page.request, one)).toEqual([frontend, renamed]);
  await expect(list.getByRole('checkbox', { name: renamed })).toBeVisible();
  await expect(list.getByRole('checkbox', { name: ui })).toHaveCount(0);

  expect(await fitsWidth(page)).toBe(true);
  if (testInfo.project.name === 'mobile') {
    await list.getByRole('checkbox', { name: renamed }).check();
    for (const target of [
      list.locator('label.form-field-inline').first(),
      merge.getByRole('button', { name: 'Clear the ticks' }),
    ]) {
      expect((await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await merge.getByLabel('They become').fill(`${stamp}-other`);
    expect(
      (await merge.getByRole('button', { name: 'Rename', exact: true }).boundingBox())?.height ?? 0,
    ).toBeGreaterThanOrEqual(44);
  }
  expect(await seriousAxeViolations(page)).toEqual([]);
});
