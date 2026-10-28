// The backend for the end-to-end suite: a Postgres with its own database, migrated,
// the API on a fixed port with a fixed setup token, and a fake OpenID Connect provider for the
// single sign-on tests. Playwright starts it as a web server and the Vite preview proxies /api
// to it. Started with: tsx apps/web/e2e/api-server.ts
import { createDb, migrateToLatest } from '@taskmoor/db';
import { buildApp, issueSetupToken } from '@taskmoor/server';
import { FakeIdp } from '@taskmoor/server/testing';
import { createDatabase } from '@taskmoor/testkit/pg';
import { startEmbeddedPostgres } from '@taskmoor/testkit/server';

export const E2E_API_PORT = 8787;
export const E2E_SETUP_TOKEN = 'e2e-setup-token-0123456789';
export const E2E_IDP_PORT = 8788;

// Always signs in the same synthetic person; the tests register it as a provider first.
const idp = new FakeIdp('taskmoor-e2e', 'e2e-client-secret-0123456789');
await idp.start(E2E_IDP_PORT);
idp.person = { sub: 'e2e-sam', email: 'sam@sso.test', name: 'Sam Rivera' };

// An embedded cluster of its own, unless TASKMOOR_TEST_DATABASE_URL names a server, as for the
// unit tests (CI's service container; containers running as root, where initdb refuses).
const external = process.env.TASKMOOR_TEST_DATABASE_URL;
const server = external
  ? { adminUrl: external, stop: async () => {} }
  : await startEmbeddedPostgres({ name: 'e2e' });
const database = await createDatabase(server.adminUrl);
const db = createDb({ connectionString: database.url, maxConnections: 5 });
await migrateToLatest(db);
await issueSetupToken(db, E2E_SETUP_TOKEN);

const app = await buildApp({
  db,
  version: 'e2e',
  roles: ['api'],
  logLevel: 'warn',
  publicUrl: 'http://localhost:4173',
});
await app.listen({ port: E2E_API_PORT, host: '127.0.0.1' });
process.stdout.write(`e2e API listening on http://127.0.0.1:${E2E_API_PORT}\n`);

async function stop(): Promise<void> {
  await app.close();
  await idp.stop();
  await db.destroy();
  await database.drop();
  await server.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
