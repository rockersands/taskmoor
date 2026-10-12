import { createDb, migrateToLatest } from '@tracksmith/db';
import { buildApp } from './app';
import { loadConfig } from './config';
import { waitForDatabase } from './startup';

const config = loadConfig();
const db = config.databaseUrl
  ? createDb({
      connectionString: config.databaseUrl,
      applicationName: `tracksmith-${config.roles.join('+')}`,
    })
  : undefined;

// The API role owns the schema; workers wait for it (an older worker next to a newer API is
// the rolling-upgrade case of ADR-022).
if (db) {
  await waitForDatabase(db, { log: (msg) => console.log(JSON.stringify({ msg })) });
}
if (db && config.roles.includes('api')) {
  const applied = await migrateToLatest(db);
  if (applied.length > 0) console.log(JSON.stringify({ msg: 'database migrated', applied }));
}

const app = await buildApp({
  ...(db ? { db } : {}),
  version: config.version,
  logLevel: config.logLevel,
  roles: config.roles,
  ...(config.webDir ? { webDir: config.webDir } : {}),
});

const timers: NodeJS.Timeout[] = [];
if (config.roles.includes('worker')) {
  // The queue (ADR-015) moves into the server in M1; until then the role only proves the image
  // and the process model, and says so.
  app.log.info('worker role: no job types registered yet (ADR-015, M1)');
  timers.push(setInterval(() => app.log.debug('worker idle'), 60_000));
}
if (config.roles.includes('realtime')) {
  app.log.info('realtime role: no channels yet (ADR-013, M1-031)');
}

await app.listen({ port: config.port, host: config.host });
app.log.info({ roles: config.roles, version: config.version }, 'listening');

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  for (const t of timers) clearInterval(t);
  await app.close();
  await db?.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
