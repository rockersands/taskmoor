import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { filterWorldOf } from '../import/dc-backup/filters';
import { defaultOptions, generateDcBackup } from '../import/dc-backup/generate';
import { securityOf } from '../import/dc-backup/schemes';
import { buildWorld, type World, walkIssues } from '../import/dc-backup/world';
import { registerImportJobs } from '../import/jobs';

// Made at run time: tests keep no credentials in the repository.
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.128.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

/** Three projects, the first renamed in the source; about one issue in 250 moved. */
const OPTIONS = defaultOptions(1_200, 128, { projects: 3, renamedProjects: 1 });
const SOURCE = { format: 'dc-backup', path: 'links.zip', scope: 'tickets' } as const;

const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script id="taskmoor-config" type="application/json">{}</script>
    <title>Taskmoor</title>
  </head>
  <body><div id="root"></div></body>
</html>
`;

function sessionCookie(header: string | string[] | undefined): string {
  return (
    (
      [header ?? []]
        .flat()
        .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`)) ??
      ''
    ).split(';')[0] ?? ''
  );
}

/**
 * Keys and links from the tracker an import came from (M1-128; IMP-011): `/browse/KEY-123` and
 * the other link patterns redirect to the app's routes in both routing modes; a moved ticket
 * opens by its earlier and its current key, and so does a ticket of a renamed project; old filter,
 * board and dashboard links map through the import's external ids for a person who may see them.
 */
describe('links and keys from the tracker an import came from (M1-128)', () => {
  const database = useMigratedDatabase();
  let hashApp: FastifyInstance;
  let pathApp: FastifyInstance;
  let importDir = '';
  let webDir = '';
  let world: World;
  let cookie = '';

  const as = (options: InjectOptions, session = cookie) =>
    hashApp.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: session },
    });
  const page = (app: FastifyInstance, url: string) =>
    app.inject({ method: 'GET', url, headers: { accept: 'text/html,*/*;q=0.8' } });

  beforeAll(async () => {
    importDir = await mkdtemp(join(tmpdir(), 'taskmoor-links-'));
    webDir = await mkdtemp(join(tmpdir(), 'taskmoor-links-web-'));
    await mkdir(join(webDir, 'assets'));
    await writeFile(join(webDir, 'index.html'), INDEX);
    await writeFile(
      join(webDir, 'version.json'),
      JSON.stringify({ name: 'taskmoor-web', version: 'test', files: [] }),
    );
    await generateDcBackup(OPTIONS, join(importDir, SOURCE.path));
    world = buildWorld(OPTIONS);
    const common = { db: database.db, version: 'test', importDir, webDir };
    hashApp = await buildApp({
      ...common,
      roles: ['api', 'web'],
      webRouting: 'hash',
      publicUrl: 'https://tracker.example.com',
    });
    pathApp = await buildApp({
      ...common,
      roles: ['web'],
      webRouting: 'path',
      publicUrl: 'https://tracker.example.com/tm',
    });
    const runner = new JobRunner(database.db, 'links-test');
    registerImportJobs(runner, database.db, new FieldCatalogs(database.db), { batch: 200 });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'Admin',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .execute();
    cookie = sessionCookie(
      (
        await hashApp.inject({
          method: 'POST',
          url: '/api/v1/session',
          payload: { email: 'admin@example.com', password: PASSWORD },
          remoteAddress: nextAddress(),
        })
      ).headers['set-cookie'],
    );
    const started = await as({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: { name: 'Links', dryRun: false, source: SOURCE },
    });
    expect(started.statusCode, started.body).toBe(202);
    for (let i = 0; i < 1000; i++) {
      if ((await runner.runOnce()) === 0) break;
    }
  }, 600_000);
  afterAll(async () => {
    await hashApp.close();
    await pathApp.close();
    await rm(importDir, { recursive: true, force: true });
    await rm(webDir, { recursive: true, force: true });
  });

  const ticketKey = async (ref: string) => {
    const res = await as({ method: 'GET', url: `/api/v1/tickets/${encodeURIComponent(ref)}` });
    expect(res.statusCode, `${ref}: ${res.body}`).toBe(200);
    return (res.json() as { ticket: { key: string } }).ticket.key;
  };

  it('[IMP-011] redirects /browse/KEY-123 to the ticket in both routing modes', async () => {
    const hash = await page(hashApp, '/browse/abc-42?focusedCommentId=10101&page=x');
    expect(hash.statusCode).toBe(302);
    expect(hash.headers.location).toBe('/#/tickets/ABC-42');
    // Clean URLs under a base path; any client, not only browsers asking for HTML.
    const path = await pathApp.inject({ method: 'GET', url: '/browse/ABC-42' });
    expect(path.statusCode).toBe(302);
    expect(path.headers.location).toBe('/tm/tickets/ABC-42');
    expect((await page(pathApp, '/projects/ABC/issues/ABC-7')).headers.location).toBe(
      '/tm/tickets/ABC-7',
    );
    expect((await page(hashApp, '/browse/ABC')).headers.location).toBe('/#/tracks/ABC');
    // API paths are never taken for links.
    expect((await hashApp.inject({ method: 'GET', url: '/api/browse/ABC-1' })).statusCode).toBe(
      404,
    );
  });

  it('[IMP-011] opens an imported ticket by its key, a moved one by both keys', async () => {
    // Tickets with a visibility level the administrator is not in stay hidden from them.
    const issues = [...walkIssues(world)].filter((i) => securityOf(world, i) === null);
    const plain = issues.find((i) => !i.moved && !i.parent) as (typeof issues)[number];
    expect(await ticketKey(plain.key)).toBe(plain.key);
    const moved = issues.filter((i) => i.moved);
    expect(moved.length).toBeGreaterThan(0);
    for (const issue of moved) {
      const old = `${issue.moved?.project.key}-${issue.moved?.number}`;
      // OLD-5 and NEW-9: the earlier key opens the ticket, which answers with its current key.
      expect(await ticketKey(old)).toBe(issue.key);
      expect(await ticketKey(issue.key)).toBe(issue.key);
      const res = await as({ method: 'GET', url: `/api/v1/tickets/${old}` });
      expect(res.json().redirect).toEqual({ from: old, to: issue.key });
      expect((await page(hashApp, `/browse/${old}`)).headers.location).toBe(`/#/tickets/${old}`);
    }
  });

  it('[IMP-011] keeps a renamed project’s earlier key as an alias of its tickets', async () => {
    const renamed = world.projects.find((p) => p.originalKey && p.originalKey !== p.key);
    expect(renamed).toBeDefined();
    const issue = [...walkIssues(world)].find(
      (i) => i.project === renamed && !i.moved && securityOf(world, i) === null,
    ) as ReturnType<typeof walkIssues> extends Iterable<infer T> ? T : never;
    expect(await ticketKey(`${renamed?.originalKey}-${issue.number}`)).toBe(issue.key);
    // Queries read the earlier key too: the track catalogue keeps every key a track had.
    const search = await as({
      method: 'POST',
      url: '/api/v1/search',
      payload: { q: `key = ${renamed?.originalKey}-${issue.number}` },
    });
    expect(search.statusCode, search.body).toBe(200);
  });

  it('[IMP-011] redirects old filter, board and dashboard links through the external ids', async () => {
    const fw = filterWorldOf(world);
    const filter = fw.filters[0];
    for (const url of [
      `/issues/?filter=${filter?.id}`,
      `/issues?filter=${filter?.id}`,
      `/secure/IssueNavigator.jspa?mode=hide&requestId=${filter?.id}`,
    ]) {
      const res = await page(hashApp, url);
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe(`/#/imported/saved-search/${filter?.id}`);
    }
    expect((await page(pathApp, '/issues/?jql=project%20%3D%20ABC')).headers.location).toBe(
      '/tm/search?q=project+%3D+ABC',
    );
    expect((await page(pathApp, '/secure/RapidBoard.jspa?rapidView=12')).headers.location).toBe(
      '/tm/imported/board/12',
    );
    const dashboard = fw.dashboards[0];
    expect(
      (await page(hashApp, `/secure/Dashboard.jspa?selectPageId=${dashboard?.id}`)).headers
        .location,
    ).toBe(`/#/imported/dashboard/${dashboard?.id}`);

    // The app maps them through the import's external ids, for a person signed in.
    const saved = await as({
      method: 'GET',
      url: `/api/v1/imported-links/saved-search/${filter?.id}`,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const target = await database.db
      .selectFrom('saved_search')
      .select('id')
      .where('name', '=', filter?.name ?? '')
      .executeTakeFirstOrThrow();
    expect(saved.json()).toEqual({
      kind: 'saved-search',
      sourceId: String(filter?.id),
      targetId: target.id,
      route: `#/search?savedSearch=${target.id}`,
    });
    const dash = await as({
      method: 'GET',
      url: `/api/v1/imported-links/dashboard/${dashboard?.id}`,
    });
    expect(dash.statusCode, dash.body).toBe(200);
    expect(dash.json().route).toMatch(/^#\/dashboards\/\d+$/);

    // A board's external id (the board import writes them): mapped the same way.
    const track = await database.db
      .selectFrom('track')
      .select(['id', 'key'])
      .executeTakeFirstOrThrow();
    // A track has one board (ADR-116): this test's board takes the place of the imported one.
    await database.db.deleteFrom('board').where('location_track_id', '=', track.id).execute();
    const board = await as({
      method: 'POST',
      url: '/api/v1/boards',
      payload: {
        name: 'Imported board',
        kind: 'kanban',
        trackId: track.id,
        source: { query: `track = ${track.key} AND type IS NOT EMPTY` },
      },
    });
    expect(board.statusCode, board.body).toBe(201);
    const boardId = board.json().board.id as number;
    await database.db
      .insertInto('import_external_id')
      .values({
        workspace_id: 1,
        import_source: 'dc-backup',
        source_system: 'dc',
        entity_kind: 'board',
        source_id: '12',
        target_id: String(boardId),
        checksum: 'board',
      })
      .execute();
    const mapped = await as({ method: 'GET', url: '/api/v1/imported-links/board/12' });
    expect(mapped.json()).toMatchObject({ targetId: boardId, route: `#/boards/${boardId}` });

    // Nothing imported, a kind it does not know, or nobody signed in: no answer that tells more.
    expect((await as({ method: 'GET', url: '/api/v1/imported-links/board/99' })).statusCode).toBe(
      404,
    );
    expect((await as({ method: 'GET', url: '/api/v1/imported-links/ticket/1' })).statusCode).toBe(
      404,
    );
    expect(
      (await as({ method: 'GET', url: `/api/v1/imported-links/saved-search/${filter?.id}` }, ''))
        .statusCode,
    ).toBe(401);
  });
});
