import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import { uniqueKey } from './unique';

/**
 * Releases end to end (M1-050; CORE-016): from a track's summary to its releases hub, two
 * releases added with the form, tickets aimed at the first (one closed through its Close
 * transition), the release's page with its tickets by stage, shipping with the open tickets
 * moved to the next release, and the generated notes listing the closed ticket; no serious axe
 * issue and no sideways page scroll, on a phone too. It uses the attachments database
 * (preview 4174), whose administrator (Ada Attach) the API server made.
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

test('[CORE-016] a release planned, shipped with its open tickets moved on, and its notes', async ({
  page,
}, testInfo) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const key = uniqueKey('R', testInfo);
  const track = await page.request.post(`${BASE}/api/v1/tracks`, {
    data: { key, name: `Shop ${key}`, mode: 'shared' },
  });
  expect(track.status(), await track.text()).toBe(201);
  const trackId = (await track.json()).track.id as number;

  // From the track's summary to its releases hub; two releases added with the form.
  await page.goto(`${BASE}/#/tracks/${key}`);
  await page.getByRole('link', { name: 'Releases', exact: true }).click();
  const hub = page.getByRole('region', { name: 'Releases', exact: true });
  await expect(hub).toBeVisible();
  const form = hub.getByRole('form', { name: 'New release' });
  for (const [name, day] of [
    ['1.0', '2030-03-01'],
    ['1.1', '2030-06-01'],
  ] as const) {
    await form.getByRole('textbox', { name: 'Name' }).fill(name);
    await form.getByLabel('Release date').fill(day);
    await form.getByRole('button', { name: 'Add release' }).click();
    await expect(hub.getByRole('link', { name, exact: true })).toBeVisible();
  }
  const listed = await (await page.request.get(`${BASE}/api/v1/tracks/${trackId}/releases`)).json();
  const first = (listed.releases as { id: number; name: string }[]).find((r) => r.name === '1.0');
  expect(first).toBeDefined();

  // Three tickets aimed at 1.0; the first closed through its Close transition.
  const keys: string[] = [];
  for (const summary of ['Pay by card', 'Refunds', 'Gift cards']) {
    const res = await page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: key, summary, targetReleaseIds: [first?.id] },
    });
    expect(res.status(), await res.text()).toBe(201);
    keys.push((await res.json()).ticket.key as string);
  }
  const [closedKey, , lastKey] = keys as [string, string, string];
  const transitions = await (
    await page.request.get(`${BASE}/api/v1/tickets/${keys[0]}/transitions`)
  ).json();
  const close = (transitions.transitions as { id: number; to: { stage: string } }[]).find(
    (x) => x.to.stage === 'closed',
  );
  const reasons = await (await page.request.get(`${BASE}/api/v1/close-reasons`)).json();
  const closed = await page.request.post(`${BASE}/api/v1/tickets/${keys[0]}/transitions`, {
    data: { transitionId: close?.id, fields: { 'close-reason': reasons.closeReasons[0].id } },
  });
  expect(closed.status(), await closed.text()).toBe(200);

  // The release's page: its tickets by stage, each number a search.
  await page.reload();
  await hub.getByRole('link', { name: '1.0', exact: true }).click();
  const release = page.getByRole('region', { name: '1.0', exact: true });
  await expect(release.getByRole('link', { name: 'Closed 1, open the search' })).toBeVisible();
  await expect(release.getByRole('link', { name: 'New 2, open the search' })).toBeVisible();
  await expect(
    release.getByRole('region', { name: 'Tickets' }).getByRole('link', { name: lastKey }),
  ).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Shipped, with the two open tickets moved to 1.1.
  await release.getByRole('button', { name: 'Ship this release…' }).click();
  const shipping = release.getByRole('region', { name: 'Ship 1.0?' });
  await shipping.getByRole('radio', { name: 'Move them to 1.1' }).check();
  await shipping.getByRole('button', { name: 'Ship 1.0' }).click();
  await expect(release.getByRole('status')).toHaveText('1.0 shipped.');
  await expect(release.getByText('Shipped', { exact: true })).toBeVisible();
  const notes = release.getByRole('region', { name: 'Release notes' });
  await expect(notes.getByRole('link', { name: closedKey })).toBeVisible();
  await expect(notes).toContainText('Pay by card');
  await expect(notes).not.toContainText('Refunds');
  expect(await seriousAxeViolations(page)).toEqual([]);

  // Back in the hub: 1.0 shipped, 1.1 holding the two open tickets.
  await page
    .getByRole('navigation', { name: `Sections of ${key}` })
    .getByRole('link', { name: 'Releases' })
    .click();
  const shipped = hub.getByRole('region', { name: 'Shipped' });
  await expect(shipped.getByRole('link', { name: '1.0', exact: true })).toBeVisible();
  const next = hub.getByRole('region', { name: 'Upcoming' }).getByRole('listitem');
  await expect(next).toHaveCount(1);
  await expect(next).toContainText('0 of 2 tickets closed');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
