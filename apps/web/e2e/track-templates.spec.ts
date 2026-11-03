import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * Track templates end to end (M1-054; CORE-002 (1)): the administrator adds a track from each
 * template on the tracks page. Scrum, Kanban, Bug tracking and Business each come with a board
 * that shows a ticket made in the track (a bug for Bug tracking; on the Scrum board's backlog,
 * as no sprint has started); Blank comes with none and its summary opens. No serious axe issue
 * and no sideways page scroll, on a phone too. It uses the attachments database (preview 4174),
 * whose administrator (Ada Attach) the API server made.
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

const TEMPLATES = [
  { id: 'scrum', label: 'Scrum: a board with a backlog and sprints', type: null },
  { id: 'kanban', label: 'Kanban: a board of continuous flow', type: null },
  { id: 'bug-tracking', label: 'Bug tracking: a board of the track’s bugs', type: 'Bug' },
  { id: 'business', label: 'Business: a business track with a board', type: null },
  { id: 'blank', label: 'Blank: a software track, no board', type: null },
] as const;

test('[CORE-002] each template makes a working track', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const stamp = Date.now().toString(36).toUpperCase().slice(-5);
  const project = testInfo.project.name.slice(0, 1).toUpperCase();

  for (const [i, template] of TEMPLATES.entries()) {
    const key = `T${project}${i}${stamp}`;
    const name = `Template ${template.id} ${stamp}`;
    await page.goto(`${BASE}/#/admin/tracks`);
    const form = page.getByRole('form', { name: 'Add a track' });
    await form.getByLabel('Key').fill(key);
    await form.getByLabel('Track name').fill(name);
    await form
      .getByRole('combobox', { name: 'Start from' })
      .selectOption({ label: template.label });
    await form.getByRole('button', { name: 'Add a track' }).click();
    const status = page.getByRole('status').filter({ hasText: key });
    if (template.id === 'blank') {
      await expect(status).toHaveText(`Track ${key} was added.`);
      await expect(page.getByRole('link', { name: `Open the board of ${key}` })).toHaveCount(0);
      await page.goto(`${BASE}/#/tracks/${key}`);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(`(${key})`);
      continue;
    }
    await expect(status).toHaveText(`Track ${key} was added, with its board.`);
    if (i === 0) {
      expect(await seriousAxeViolations(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }

    // A ticket made in the track shows on its board.
    const track = await (await page.request.get(`${BASE}/api/v1/tracks/${key}`)).json();
    const types = await (
      await page.request.get(`${BASE}/api/v1/tracks/${track.track.id}/ticket-types`)
    ).json();
    const typeId = template.type
      ? (types.ticketTypes as { id: number; name: string }[]).find((y) => y.name === template.type)
          ?.id
      : undefined;
    const made = await page.request.post(`${BASE}/api/v1/tickets`, {
      data: { track: key, summary: `First of ${key}`, ...(typeId ? { ticketTypeId: typeId } : {}) },
    });
    expect(made.status(), await made.text()).toBe(201);
    const ticketKey = (await made.json()).ticket.key as string;
    await page.getByRole('link', { name: `Open the board of ${key}` }).click();
    await expect(page).toHaveURL(/#\/boards\/\d+$/);
    if (template.id === 'scrum') {
      await page
        .getByRole('navigation', { name: `Sections of ${key}` })
        .getByRole('link', { name: 'Backlog', exact: true })
        .click();
      const backlog = page.getByRole('region', { name: 'Backlog and sprints' });
      await expect(
        backlog.getByRole('region', { name: 'Backlog', exact: true }).getByRole('link', {
          name: ticketKey,
        }),
      ).toBeVisible();
    } else {
      const board = page.getByRole('region', { name });
      await expect(board.getByRole('link', { name: new RegExp(`^${ticketKey} `) })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});
