// The backend serving the built frontend itself (M1-105, single-server mode), once per routing
// mode: hash routing on 4176 and clean URLs on 4177, each with its own database, set up here
// with an administrator, a track, a ticket and a board for routing.spec.ts. Playwright starts it
// after the preview's build, so apps/web/dist is the artefact this run built.
//
// A third instance is the backend of a frontend on another origin (M1-107, cross-origin.spec.ts)
// at api.taskmoor.localhost:8794, which Chromium keeps on this machine. It allows two frontend
// kits that kit-server.ts serves: app.taskmoor.localhost:4181 (a sibling subdomain, same site:
// the backend's cookie) and 127.0.0.1:4182 (another site: OAuth with PKCE, sent back to its root).
//
// A fourth serves the import wizard (M1-097, import-wizard.spec.ts) on 4185, with an imports
// folder of its own and the import job's worker loop; its administrator's password is made per
// run by playwright.config.ts.
// Started with: tsx apps/web/e2e/web-server.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, migrateToLatest } from '@taskmoor/db';
import {
  buildApp,
  FieldCatalogs,
  IMPORT_TASK,
  issueSetupToken,
  JobRunner,
  registerImportJobs,
} from '@taskmoor/server';
import { defaultOptions, generateDcBackup } from '@taskmoor/server/testing';
import { cleanupLeftovers, createDatabase } from '@taskmoor/testkit/pg';
import { startEmbeddedPostgres } from '@taskmoor/testkit/server';
import { buildVersion, type RoutingMode } from '@taskmoor/webconfig';
import { anyLoopback } from './loopback';

export const E2E_WEB_HASH_PORT = 4176;
export const E2E_WEB_PATH_PORT = 4177;
export const E2E_WEB_ADMIN = { email: 'rui@routes.test', password: 'lantern harbour meadow 4521' };
export const E2E_TOPOLOGY_API_PORT = 8794;
export const E2E_TOPOLOGY_API = `http://api.taskmoor.localhost:${E2E_TOPOLOGY_API_PORT}`;
export const E2E_SIBLING_APP = 'http://app.taskmoor.localhost:4181';
export const E2E_CROSS_SITE_APP = 'http://127.0.0.1:4182';
export const E2E_IMPORT_PORT = 4185;
export const E2E_IMPORT_ADMIN = 'iris@imports.test';
export const E2E_IMPORT_BACKUP = fileURLToPath(
  new URL('../../../.cache/e2e/dc-backup-10000-seed97.zip', import.meta.url),
);

const webDir = fileURLToPath(new URL('../dist', import.meta.url));
const external = process.env.TASKMOOR_TEST_DATABASE_URL;
const server = external
  ? { adminUrl: external, stop: async () => {} }
  : await startEmbeddedPostgres({ name: 'e2e-web' });
// This process is the only user of its cluster: what an earlier run left goes first.
if (!external) await cleanupLeftovers(server.adminUrl);

/** One instance: migrated, set up through the API, then listening with the frontend. */
async function instance(
  port: number,
  routing: RoutingMode,
  crossOrigin?: Pick<Parameters<typeof buildApp>[0], 'allowedOrigins' | 'oauthRedirectUris'> & {
    publicUrl: string;
  },
) {
  const database = await createDatabase(server.adminUrl);
  const db = createDb({ connectionString: database.url, maxConnections: 5 });
  await migrateToLatest(db);
  const app = await buildApp({
    db,
    // The version this run's build stamped, as the image pairs them.
    version: buildVersion(process.env),
    roles: ['api', 'realtime', 'web'],
    logLevel: 'warn',
    webDir,
    webRouting: routing,
    publicUrl: `http://localhost:${port}`,
    ...crossOrigin,
  });
  const call = async (url: string, payload: object, cookie = '') => {
    const res = await app.inject({ method: 'POST', url, payload, headers: { cookie } });
    if (res.statusCode !== 201 && res.statusCode !== 200) {
      throw new Error(`web e2e setup: ${url} answered ${res.statusCode} ${res.body}`);
    }
    return res;
  };
  const setup = await call('/api/v1/setup', {
    token: await issueSetupToken(db),
    instanceName: `Routes ${routing}`,
    admin: { name: 'Rui Routes', ...E2E_WEB_ADMIN },
  });
  const cookie =
    [setup.headers['set-cookie'] ?? []]
      .flat()
      .find((c) => c.startsWith('taskmoor_session=') && !c.startsWith('taskmoor_session=;'))
      ?.split(';')[0] ?? '';
  // A fresh install requires a second factor for site administrators (the user's decision of
  // 2026-11-01); these test servers sign in with passwords only, so they turn it off.
  // setup.spec.ts and the fresh-install run (e2e-fresh) cover the default.
  await db.updateTable('two_factor_policy').set({ required: 'none' }).execute();
  const track = await call('/api/v1/tracks', { key: 'RT', name: 'Routes', mode: 'shared' }, cookie);
  await call(
    '/api/v1/tickets',
    { track: 'RT', summary: 'Deep link target', assigneeId: null },
    cookie,
  );
  const board = await call(
    '/api/v1/boards',
    {
      name: 'Routes board',
      kind: 'kanban',
      trackId: track.json().track.id,
      source: { query: 'track = RT' },
    },
    cookie,
  );
  if (!crossOrigin) await importedLeftovers(db, call, cookie, board.json().board.id as number);
  // Names under localhost may resolve to either loopback address: listen on both.
  await app.listen({ port, host: crossOrigin ? anyLoopback() : '127.0.0.1' });
  return { app, db, database };
}

/**
 * What an import from another tracker leaves behind (M1-128, imported-links.spec.ts): ABC-42,
 * NEW-9 that was OLD-5 before it moved, and the import's external ids of a saved filter (10010)
 * and of the board (12).
 */
async function importedLeftovers(
  db: ReturnType<typeof createDb>,
  call: (url: string, payload: object, cookie?: string) => Promise<{ json(): unknown }>,
  cookie: string,
  boardId: number,
) {
  const track = async (key: string, last: number) => {
    const res = (
      await call('/api/v1/tracks', { key, name: `Imported ${key}`, mode: 'shared' }, cookie)
    ).json() as { track: { id: number } };
    await db
      .insertInto('ticket_counter')
      .values({ workspace_id: 1, track_id: res.track.id, last_number: last })
      .onConflict((oc) => oc.column('track_id').doUpdateSet({ last_number: last }))
      .execute();
    return res.track.id;
  };
  await track('ABC', 41);
  await call(
    '/api/v1/tickets',
    { track: 'ABC', summary: 'Imported answer', assigneeId: null },
    cookie,
  );
  const old = await track('OLD', 5);
  await track('NEW', 8);
  const moved = (
    await call(
      '/api/v1/tickets',
      { track: 'NEW', summary: 'Moved before the import', assigneeId: null },
      cookie,
    )
  ).json() as { ticket: { id: number } };
  await db
    .insertInto('ticket_key_history')
    .values({
      workspace_id: 1,
      ticket_id: moved.ticket.id,
      track_id: old,
      number: 5,
      replaced_at: new Date(),
    })
    .execute();
  const saved = (
    await call('/api/v1/saved-searches', { name: 'Imported filter', query: 'track = ABC' }, cookie)
  ).json() as { savedSearch: { id: number } };
  for (const [kind, source, target] of [
    ['saved_search', '10010', saved.savedSearch.id],
    ['board', '12', boardId],
  ] as const) {
    await db
      .insertInto('import_external_id')
      .values({
        workspace_id: 1,
        import_source: 'dc-backup',
        source_system: 'dc',
        entity_kind: kind,
        source_id: source,
        target_id: String(target),
        checksum: 'e2e',
      })
      .execute();
  }
}

// Before 4177, which Playwright waits for: the import wizard's spec needs it and its backup.
const imports = await importInstance();
const instances = [
  // First, so it listens before Playwright sees 4177 and starts the kit server that needs it.
  await instance(E2E_TOPOLOGY_API_PORT, 'hash', {
    publicUrl: E2E_TOPOLOGY_API,
    allowedOrigins: [E2E_SIBLING_APP, E2E_CROSS_SITE_APP],
    oauthRedirectUris: [`${E2E_CROSS_SITE_APP}/`],
  }),
  await instance(E2E_WEB_HASH_PORT, 'hash'),
  await instance(E2E_WEB_PATH_PORT, 'path'),
];

/** The import wizard's instance (M1-097): an imports folder and a worker loop for imports. */
async function importInstance() {
  const database = await createDatabase(server.adminUrl);
  const db = createDb({ connectionString: database.url, maxConnections: 5 });
  await migrateToLatest(db);
  const importDir = mkdtempSync(join(tmpdir(), 'taskmoor-e2e-imports-'));
  // The spec uploads the 10,000-issue backup: made once, kept in .cache/e2e.
  if (!existsSync(E2E_IMPORT_BACKUP)) {
    mkdirSync(dirname(E2E_IMPORT_BACKUP), { recursive: true });
    await generateDcBackup(defaultOptions(10_000, 97), E2E_IMPORT_BACKUP);
  }
  const app = await buildApp({
    db,
    version: buildVersion(process.env),
    roles: ['api', 'web'],
    logLevel: 'warn',
    webDir,
    webRouting: 'hash',
    publicUrl: `http://localhost:${E2E_IMPORT_PORT}`,
    importDir,
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    payload: {
      token: await issueSetupToken(db),
      instanceName: 'Imports',
      admin: {
        name: 'Iris Imports',
        email: E2E_IMPORT_ADMIN,
        password: process.env.TASKMOOR_E2E_IMPORT_PASSWORD as string,
      },
    },
  });
  if (setup.statusCode !== 201 && setup.statusCode !== 200) {
    throw new Error(`import e2e setup answered ${setup.statusCode} ${setup.body}`);
  }
  // A fresh install requires a second factor for site administrators (the user's decision of
  // 2026-11-01); these test servers sign in with passwords only, so they turn it off.
  // setup.spec.ts and the fresh-install run (e2e-fresh) cover the default.
  await db.updateTable('two_factor_policy').set({ required: 'none' }).execute();
  await app.listen({ port: E2E_IMPORT_PORT, host: '127.0.0.1' });
  const runner = new JobRunner(db, 'e2e-imports', { tasks: [IMPORT_TASK] });
  registerImportJobs(runner, db, new FieldCatalogs(db));
  let running = true;
  const loop = (async () => {
    while (running) {
      const ran = await runner.runOnce().catch(() => 0);
      if (ran === 0) await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })();
  return {
    app,
    db,
    database,
    stop: async () => {
      running = false;
      await loop;
      rmSync(importDir, { recursive: true, force: true });
    },
  };
}
instances.push({ app: imports.app, db: imports.db, database: imports.database });

process.stdout.write(
  `e2e frontend servers on ${E2E_WEB_HASH_PORT} and ${E2E_WEB_PATH_PORT}, a cross-origin backend on ${E2E_TOPOLOGY_API_PORT}, imports on ${E2E_IMPORT_PORT}\n`,
);

async function stop(): Promise<void> {
  await imports.stop();
  for (const { app, db, database } of instances) {
    await app.close();
    await db.destroy();
    await database.drop();
  }
  await server.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
