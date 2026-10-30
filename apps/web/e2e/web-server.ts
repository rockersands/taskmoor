// The backend serving the built frontend itself (M1-105, single-server mode), once per routing
// mode: hash routing on 4176 and clean URLs on 4177, each with its own database, set up here
// with an administrator, a track, a ticket and a board for routing.spec.ts. Playwright starts it
// after the preview's build, so apps/web/dist is the artefact this run built.
//
// A third instance is the backend of a frontend on another origin (M1-107, cross-origin.spec.ts)
// at api.taskmoor.localhost:8794, which Chromium keeps on this machine. It allows two frontend
// kits that kit-server.ts serves: app.taskmoor.localhost:4181 (a sibling subdomain, same site:
// the backend's cookie) and 127.0.0.1:4182 (another site: OAuth with PKCE, sent back to its root).
// Started with: tsx apps/web/e2e/web-server.ts
import { fileURLToPath } from 'node:url';
import { createDb, migrateToLatest } from '@taskmoor/db';
import { buildApp, issueSetupToken } from '@taskmoor/server';
import { createDatabase } from '@taskmoor/testkit/pg';
import { startEmbeddedPostgres } from '@taskmoor/testkit/server';
import { buildVersion, type RoutingMode } from '@taskmoor/webconfig';

export const E2E_WEB_HASH_PORT = 4176;
export const E2E_WEB_PATH_PORT = 4177;
export const E2E_WEB_ADMIN = { email: 'rui@routes.test', password: 'lantern harbour meadow 4521' };
export const E2E_TOPOLOGY_API_PORT = 8794;
export const E2E_TOPOLOGY_API = `http://api.taskmoor.localhost:${E2E_TOPOLOGY_API_PORT}`;
export const E2E_SIBLING_APP = 'http://app.taskmoor.localhost:4181';
export const E2E_CROSS_SITE_APP = 'http://127.0.0.1:4182';

const webDir = fileURLToPath(new URL('../dist', import.meta.url));
const external = process.env.TASKMOOR_TEST_DATABASE_URL;
const server = external
  ? { adminUrl: external, stop: async () => {} }
  : await startEmbeddedPostgres({ name: 'e2e-web' });

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
  const track = await call('/api/v1/tracks', { key: 'RT', name: 'Routes', mode: 'shared' }, cookie);
  await call(
    '/api/v1/tickets',
    { track: 'RT', summary: 'Deep link target', assigneeId: null },
    cookie,
  );
  await call(
    '/api/v1/boards',
    {
      name: 'Routes board',
      kind: 'kanban',
      trackId: track.json().track.id,
      source: { query: 'track = RT' },
    },
    cookie,
  );
  // Names under localhost may resolve to either loopback address: listen on both.
  await app.listen({ port, host: crossOrigin ? '::' : '127.0.0.1' });
  return { app, db, database };
}

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
process.stdout.write(
  `e2e frontend servers on ${E2E_WEB_HASH_PORT} and ${E2E_WEB_PATH_PORT}, a cross-origin backend on ${E2E_TOPOLOGY_API_PORT}\n`,
);

async function stop(): Promise<void> {
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
