import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type APIRequestContext, type Download, expect, type Page, test } from '@playwright/test';
import { cellText, records } from '@taskmoor/server/testing';
import { uniqueRun } from './unique';

/**
 * Copying, linking and downloading a plan end to end (T-089g; PLN-014; ADR-122 stage 8). Ori owns a
 * plan over a track Ori sees and one hidden from Vera, who sees the plan through a share; a third
 * person sees no plan at all. Vera copies it: what is hidden from her stays behind, only counted. A
 * link opens the same view for Vera, sends someone signed out through sign-in and back, and gives
 * nothing to the third. Every file is read: each CSV's rows, and the PNG's signature and size. No
 * serious axe issue and no sideways page scroll, on a phone too. It uses the attachments database
 * (preview 4174), whose administrator (Ada Attach) the API server made.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
// Made for this run: no password is written in the repository.
const PASSWORD = `${randomBytes(18).toString('hex')}-Zy7`;

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
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

async function ok<T>(answer: ReturnType<APIRequestContext['post']>): Promise<T> {
  const res = await answer;
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as T;
}

async function signInAs(api: APIRequestContext, email: string, password: string | undefined) {
  await api.delete(`${BASE}/api/v1/session`);
  await ok(api.post(`${BASE}/api/v1/session`, { data: { email, password } }));
}

/** Opens a page afresh: after a change of who is signed in, a hash change alone would not do. */
async function visit(page: Page, hash: string) {
  await page.goto('about:blank');
  await page.goto(`${BASE}/${hash}`);
}

/** Chooses a file from the view's Download menu, and reads what arrives. */
async function download(page: Page, label: string): Promise<{ file: Download; body: Buffer }> {
  await page.getByRole('button', { name: 'Download' }).click();
  const arriving = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: label }).click();
  const file = await arriving;
  const path = await file.path();
  return { file, body: readFileSync(path) };
}
const firstColumn = (csv: string) =>
  csv
    .trimEnd()
    .split('\r\n')
    .slice(1)
    .map((line) => line.split(',')[0]);

/**
 * A CSV file's rows as the CSV importer reads them, after checking it starts with the UTF-8
 * byte-order mark exactly once (T-252): what Excel on Windows needs, and what an import takes off.
 */
function readBack(body: Buffer): string[][] {
  expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect([...body.subarray(3, 6)]).not.toEqual([0xef, 0xbb, 0xbf]);
  const rows = [...records(body, ',')].map((r) => r.fields.map(cellText));
  expect(rows[0]?.[0]).not.toMatch(/^\uFEFF/);
  return rows;
}

test('[PLN-014] a plan copied, linked and downloaded: hidden work only counted, a link giving no access', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const api = page.request;
  await signInAs(api, ADMIN.email, ADMIN.password);
  const run = uniqueRun(testInfo);
  const person = async (who: string) => {
    const email = `${who}-${run}@share.test`.toLowerCase();
    const id = (
      await ok<{ user: { id: number } }>(
        api.post(`${BASE}/api/v1/users`, {
          data: { email, name: `${who} ${run}`, password: PASSWORD },
        }),
      )
    ).user.id;
    return { id, email };
  };
  const ori = await person('Ori');
  const vera = await person('Vera');
  const nobody = await person('Nora');
  const roles = (await (await api.get(`${BASE}/api/v1/roles`)).json()).roles as {
    id: number;
    name: string;
  }[];
  const members = roles.find((r) => r.name === 'Members')?.id;
  const keys = { open: `PA${run}`, hidden: `PB${run}` };
  const trackOf: Record<string, number> = {};
  for (const [which, key] of Object.entries(keys)) {
    trackOf[which] = (
      await ok<{ track: { id: number } }>(
        api.post(`${BASE}/api/v1/tracks`, {
          data: { key, name: `Track ${key}`, mode: 'shared' },
        }),
      )
    ).track.id;
  }
  const join = async (track: number, user: number) => {
    const res = await api.put(`${BASE}/api/v1/tracks/${track}/roles/${members}/users/${user}`);
    expect(res.status(), await res.text()).toBeLessThan(300);
  };
  await join(trackOf.open as number, ori.id);
  await join(trackOf.hidden as number, ori.id);
  await join(trackOf.open as number, vera.id);
  const ticket = async (track: string, summary: string, data: Record<string, unknown> = {}) =>
    ok<{ ticket: { key: string } }>(
      api.post(`${BASE}/api/v1/tickets`, { data: { track, summary, ...data } }),
    );
  const risky = await ticket(keys.open, '=HYPERLINK("http://example.test")', {
    startDate: '2030-03-04',
    dueDate: '2030-03-12',
  });
  const work = await ticket(keys.open, 'Open work', {
    startDate: '2030-03-05',
    dueDate: '2030-03-20',
  });
  const secret = await ticket(keys.hidden, 'Work hidden from Vera', { dueDate: '2030-03-08' });

  await signInAs(api, ori.email, PASSWORD);
  const plan = (
    await ok<{ plan: { id: number } }>(
      api.post(`${BASE}/api/v1/plans`, {
        data: {
          name: `Shared ${run}`,
          description: 'Comes with the copy',
          sources: [
            { kind: 'track', trackId: trackOf.open },
            { kind: 'track', trackId: trackOf.hidden },
          ],
          shares: [{ scope: 'user', userId: vera.id }],
        },
      }),
    )
  ).plan.id;

  // Vera sees the plan as it may be seen, with its actions on every tab.
  await signInAs(api, vera.email, PASSWORD);
  await visit(page, `#/plans/${plan}/timeline?zoom=months`);
  await expect(page.getByRole('heading', { name: `Shared ${run}`, level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Months' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);

  // Each file holds only what Vera may see.
  const csv = await download(page, 'CSV');
  expect(csv.file.suggestedFilename()).toMatch(/^Shared-.+-timeline-\d{4}-\d{2}-\d{2}\.csv$/);
  const timeline = csv.body.toString('utf8');
  expect(firstColumn(timeline)).toEqual(
    expect.arrayContaining([risky.ticket.key, work.ticket.key]),
  );
  expect(firstColumn(timeline).every((key) => key?.startsWith(keys.open))).toBe(true);
  expect(timeline).not.toContain(secret.ticket.key);
  expect(timeline).not.toContain('hidden from Vera');
  expect(timeline).toContain(`"'=HYPERLINK(""http://example.test"")"`);
  const timelineRows = readBack(csv.body);
  expect(timelineRows[0]?.[0]).toBe('Key');
  expect(timelineRows.slice(1).map((r) => r[0])).toEqual(firstColumn(timeline));
  expect(timelineRows.some((r) => r[1] === '=HYPERLINK("http://example.test")')).toBe(true);

  const image = await download(page, 'Image (PNG)');
  expect(image.file.suggestedFilename()).toMatch(/\.png$/);
  expect([...image.body.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  // The picture's width and height, from the file's header: 1600 wide, drawn at twice the size.
  expect(image.body.readUInt32BE(16)).toBe(3200);
  expect(image.body.readUInt32BE(20)).toBeGreaterThan(200);
  await expect(page.getByText(/^Downloaded Shared-.+\.png/)).toBeVisible();

  await page.getByRole('link', { name: 'List', exact: true }).click();
  await expect(page.getByText(risky.ticket.key).first()).toBeVisible();
  const list = await download(page, 'CSV');
  expect(list.file.suggestedFilename()).toMatch(/^Shared-.+-list-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(list.body.toString('utf8')).not.toContain(secret.ticket.key);
  expect(firstColumn(list.body.toString('utf8'))).toContain(risky.ticket.key);
  expect(readBack(list.body)[0]?.[0]).toBe('key');

  for (const [tab, name] of [
    ['Summary', 'summary'],
    ['Calendar', 'calendar'],
    ['Capacity', 'capacity'],
    ['Releases', 'releases'],
  ] as const) {
    await page.getByRole('link', { name: tab, exact: true }).click();
    const file = await download(page, 'CSV');
    expect(file.file.suggestedFilename()).toContain(`-${name}-`);
    expect(file.body.toString('utf8')).not.toContain(secret.ticket.key);
    expect(file.body.toString('utf8')).not.toContain(keys.hidden);
    expect(readBack(file.body).length, name).toBeGreaterThan(0);
    expect(await noSidewaysScroll(page)).toBe(true);
  }

  // A copy: what is hidden stays behind, counted, and the copy is hers alone.
  await page.getByRole('button', { name: 'Duplicate plan' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Name')).toHaveValue(`Copy of Shared ${run}`);
  await expect(dialog.getByText('1 source hidden from you stays behind.')).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Duplicate' }).click();
  await expect(dialog.getByText('1 source you may not see was left out.')).toBeVisible();
  await dialog.getByRole('link', { name: 'Open the copy' }).click();
  await expect(
    page.getByRole('heading', { name: `Copy of Shared ${run}`, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('Comes with the copy')).toBeVisible();
  const copyId = Number(/\/plans\/(\d+)/.exec(page.url())?.[1]);
  expect(copyId).toBeGreaterThan(plan);
  const copy = (await (await api.get(`${BASE}/api/v1/plans/${copyId}`)).json()).plan;
  expect(copy.sources.map((s: { key: string }) => s.key)).toEqual([keys.open]);
  expect(copy.shares).toEqual([]);

  // A link, as Vera would copy it, in another signed-in person's browser.
  await visit(page, `#/plans/${plan}/timeline?zoom=quarters`);
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
  const link = page.url();
  expect(link).toContain('zoom=quarters');

  // Signed out, sign-in comes back to it.
  const signedOut = await browser.newContext();
  const stranger = await signedOut.newPage();
  await stranger.goto(link);
  await stranger.getByLabel('Email').fill(ori.email);
  await stranger.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await stranger.getByRole('button', { name: 'Sign in' }).click();
  await expect(stranger.getByRole('heading', { name: `Shared ${run}`, level: 1 })).toBeVisible();
  await expect(stranger.getByRole('button', { name: 'Quarters' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Ori, who may see the hidden track, gets more rows from the same link.
  await expect(stranger.getByText(secret.ticket.key).first()).toBeVisible();
  await signedOut.close();

  // Someone without access gets the plan's not-found page, and no file.
  const other = await browser.newContext();
  await other.request.post(`${BASE}/api/v1/session`, {
    data: { email: nobody.email, password: PASSWORD },
  });
  const nora = await other.newPage();
  await nora.goto(link);
  await expect(nora.getByRole('alert')).toContainText(/does not exist|cannot see/);
  await expect(nora.getByText(`Shared ${run}`)).toHaveCount(0);
  const refused = await other.request.get(`${BASE}/api/v1/plans/${plan}/export`);
  expect(refused.status()).toBe(404);
  const notCopied = await other.request.post(`${BASE}/api/v1/plans/${plan}/duplicate`, {
    data: { name: 'Mine now' },
  });
  expect(notCopied.status()).toBe(404);
  await other.close();
});
