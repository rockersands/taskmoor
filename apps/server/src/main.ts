import { createDb, migrateToLatest } from '@tracksmith/db';
import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const db = createDb({ connectionString: config.databaseUrl, applicationName: 'tracksmith-api' });

const applied = await migrateToLatest(db);
const app = await buildApp({ db, version: config.version, logLevel: config.logLevel });
if (applied.length > 0) app.log.info({ applied }, 'database migrated');

await app.listen({ port: config.port, host: config.host });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
