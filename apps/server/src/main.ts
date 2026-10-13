import { createDb, migrateToLatest, poolStats } from '@taskmoor/db';
import { passwordHasher } from '@taskmoor/iam';
import { buildApp } from './app';
import { loadConfig } from './config';
import { buildMetricsServer, createMetrics, queryObserver, startTracing } from './observability';
import { loadPeppers } from './secrets';
import { issueSetupToken, setupLink } from './setup';
import { waitForDatabase } from './startup';

const config = loadConfig();
const startedAt = new Date();
// Observability first (ADR-023), so the database client reports to it from the first query.
const tracing = startTracing({ version: config.version, roles: config.roles });
let readPool: (() => ReturnType<typeof poolStats>) | undefined;
const metrics = createMetrics({
  version: config.version,
  roles: config.roles,
  pool: () => readPool?.(),
  ...(config.dataDir ? { dataDir: config.dataDir } : {}),
});
const db = config.databaseUrl
  ? createDb({
      connectionString: config.databaseUrl,
      applicationName: `taskmoor-${config.roles.join('+')}`,
      onQuery: queryObserver({ metrics, ...(tracing ? { tracer: tracing.tracer } : {}) }),
    })
  : undefined;
if (db) readPool = () => poolStats(db);

// The API role owns the schema; workers wait for it (an older worker next to a newer API is
// the rolling-upgrade case of ADR-022).
if (db) {
  await waitForDatabase(db, { log: (msg) => console.log(JSON.stringify({ msg })) });
}
if (db && config.roles.includes('api')) {
  const applied = await migrateToLatest(db);
  if (applied.length > 0) console.log(JSON.stringify({ msg: 'database migrated', applied }));
  // OPS-001: the installer prints the setup link; the token is shown here and nowhere else.
  const token = await issueSetupToken(db, config.setupToken);
  if (token) {
    console.log(
      JSON.stringify({ msg: 'first-run setup', link: setupLink(config.publicUrl, token) }),
    );
  }
}

const peppers = loadPeppers({ dataDir: config.dataDir, envSecret: config.passwordPepper });
if (!peppers?.active && config.roles.includes('api')) {
  console.log(
    JSON.stringify({
      msg: 'passwords are hashed without a pepper: set TASKMOOR_DATA or TASKMOOR_PASSWORD_PEPPER',
    }),
  );
}

const app = await buildApp({
  passwords: passwordHasher(peppers),
  ...(db ? { db } : {}),
  version: config.version,
  logLevel: config.logLevel,
  roles: config.roles,
  secureCookies: config.secureCookies,
  publicUrl: config.publicUrl,
  ...(config.trustedProxies ? { trustedProxies: config.trustedProxies } : {}),
  ...(config.webDir ? { webDir: config.webDir } : {}),
  metrics,
  ...(tracing ? { tracer: tracing.tracer } : {}),
  ...(config.dataDir ? { dataDir: config.dataDir } : {}),
  startedAt,
});
const metricsServer = config.metricsPort > 0 ? await buildMetricsServer(metrics) : undefined;

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
if (metricsServer) {
  await metricsServer.listen({ port: config.metricsPort, host: config.metricsHost });
  app.log.info({ port: config.metricsPort }, 'metrics listening');
}
if (tracing) app.log.info('tracing to the configured OTLP endpoint');

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  for (const t of timers) clearInterval(t);
  await app.close();
  await metricsServer?.close();
  await tracing?.shutdown();
  await db?.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
