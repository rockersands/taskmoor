// The backend for the end-to-end suite: an embedded Postgres with its own database, migrated,
// and the API on a fixed port with a fixed setup token. Playwright starts it as a web server
// and the Vite preview proxies /api to it. Started with: tsx apps/web/e2e/api-server.ts
import { createDb, migrateToLatest } from '@taskmoor/db';
import { buildApp, issueSetupToken } from '@taskmoor/server';
import { createDatabase } from '@taskmoor/testkit/pg';
import { startEmbeddedPostgres } from '@taskmoor/testkit/server';

export const E2E_API_PORT = 8787;
export const E2E_SETUP_TOKEN = 'e2e-setup-token-0123456789';

const server = await startEmbeddedPostgres({ name: 'e2e' });
const database = await createDatabase(server.adminUrl);
const db = createDb({ connectionString: database.url, maxConnections: 5 });
await migrateToLatest(db);
await issueSetupToken(db, E2E_SETUP_TOKEN);

const app = await buildApp({ db, version: 'e2e', roles: ['api'], logLevel: 'warn' });
await app.listen({ port: E2E_API_PORT, host: '127.0.0.1' });
process.stdout.write(`e2e API listening on http://127.0.0.1:${E2E_API_PORT}\n`);

async function stop(): Promise<void> {
  await app.close();
  await db.destroy();
  await database.drop();
  await server.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
