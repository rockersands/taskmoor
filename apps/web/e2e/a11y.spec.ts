import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';

/**
 * The accessibility sweep (M1-115; NFR-005 (1)): every page of the app, with data in it,
 * checked by axe against WCAG 2.1 A and AA. No serious or critical violation may remain, on a
 * desktop and on a phone. It uses the attachments database (preview 4174), whose administrator
 * (Ada Attach) the API server made, and makes its own track, tickets, board, sprint, release,
 * saved search and dashboard.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
async function violations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            context: Document,
            options: unknown,
          ) => Promise<{
            violations: {
              id: string;
              impact?: string | null;
              nodes: { target: unknown[] }[];
            }[];
          }>;
        };
      }
    ).axe;
    const { violations: found } = await axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return found
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} at ${JSON.stringify(v.nodes.slice(0, 2).map((n) => n.target))}`);
  });
}

test('[NFR-005] every page passes axe at WCAG 2.1 AA', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  // Keys sort after the shared ATT track, which other specs expect to be first.
  const key = `Z${testInfo.project.name.slice(0, 1).toUpperCase()}${testInfo.workerIndex.toString(36).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const post = async (url: string, data: unknown) => {
    const res = await page.request.post(`${BASE}${url}`, { data });
    expect(res.status(), `${url}: ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  const track = (await post('/api/v1/tracks', { key, name: `Access ${key}`, mode: 'shared' }))
    .track;
  const first = (
    await post('/api/v1/tickets?format=markdown', {
      track: key,
      summary: 'A ticket with words',
      description: 'Some **rich** text and a [link](https://example.com).',
      dueDate: '2030-01-10',
      startDate: '2030-01-03',
    })
  ).ticket;
  await post('/api/v1/tickets', { track: key, summary: 'Another ticket' });
  await post(`/api/v1/tickets/${first.key}/comments?format=markdown`, { body: 'A comment.' });
  const board = (
    await post('/api/v1/boards', {
      name: `Access ${key}`,
      kind: 'scrum',
      trackId: track.id,
      source: { query: `track = ${key}` },
    })
  ).board;
  const sprint = (await post(`/api/v1/boards/${board.id}/sprints`, {})).sprint;
  await post(`/api/v1/sprints/${sprint.id}/tickets`, { tickets: [first.id] });
  await post(`/api/v1/sprints/${sprint.id}/start`, { endAt: '2030-02-01T09:00:00Z' });
  const release = (
    await post(`/api/v1/tracks/${track.id}/releases`, { name: '1.0', releaseDate: '2030-03-01' })
  ).release;
  await post('/api/v1/saved-searches', { name: `Access ${key}`, query: `track = ${key}` });
  const dashboard = (
    await post('/api/v1/dashboards', {
      name: `Access ${key}`,
      layout: 'two',
      widgets: [
        { kind: 'introduction', column: 0, config: { text: 'Welcome' } },
        { kind: 'pie', column: 1, config: { query: `track = ${key}`, field: 'status' } },
      ],
    })
  ).dashboard;

  const pages: [string, string][] = [
    ['home', '#/home'],
    ['inbox', '#/inbox'],
    ['search', `#/search?q=${encodeURIComponent(`track = ${key}`)}`],
    ['ticket', `#/tickets/${first.key}`],
    ['create', '#/create'],
    ['boards', '#/boards'],
    ['board', `#/boards/${board.id}`],
    ['board settings', `#/boards/${board.id}/settings`],
    ['backlog', `#/boards/${board.id}/backlog`],
    ['board reports', `#/boards/${board.id}/reports/cumulative-flow`],
    ['sprint report', `#/boards/${board.id}/sprints/${sprint.id}/report`],
    ['dashboards', '#/dashboards'],
    ['dashboard', `#/dashboards/${dashboard.id}`],
    ['track summary', `#/tracks/${key}`],
    ['releases', `#/tracks/${key}/releases`],
    ['release', `#/releases/${release.id}`],
    ['timeline', `#/tracks/${key}/timeline`],
    ['list', `#/tracks/${key}/list`],
    ['calendar', `#/tracks/${key}/calendar`],
    ['settings', '#/settings'],
    ['account', '#/account'],
    ['admin system', '#/admin/system'],
    ['admin tokens', '#/admin/tokens'],
    ['admin service accounts', '#/admin/service-accounts'],
    ['admin security', '#/admin/security'],
    ['admin identity providers', '#/admin/identity-providers'],
    ['admin trash', '#/admin/trash'],
    ['admin mcp', '#/admin/mcp'],
    ['admin api usage', '#/admin/api-usage'],
    ['admin directories', '#/admin/directories'],
    ['admin workflows', '#/admin/workflows'],
    ['admin users', '#/admin/users'],
    ['admin groups', '#/admin/groups'],
    ['admin tracks', '#/admin/tracks'],
    ['admin workflow maps', '#/admin/workflow-maps'],
    ['admin fields', '#/admin/fields'],
    ['admin permissions', '#/admin/permissions'],
    ['admin configuration sets', '#/admin/configuration-sets'],
    ['admin guardrails', '#/admin/guardrails'],
  ];
  const found: string[] = [];
  for (const [name, hash] of pages) {
    await page.goto(`${BASE}/${hash}`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    // Let data arrive: the page settles when nothing says it is loading.
    await expect(page.getByText(/^Loading/)).toHaveCount(0);
    for (const v of await violations(page)) found.push(`${name}: ${v}`);
  }
  expect(found).toEqual([]);
});
