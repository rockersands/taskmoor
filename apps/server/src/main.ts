import { createDb, migrateToLatest, poolStats } from '@taskmoor/db';
import { passwordHasher } from '@taskmoor/iam';
import { buildApp } from './app';
import { registerAuditJobs, scheduleRetention } from './audit/retention';
import { backupDirectory, registerBackupJobs, scheduleBackups } from './backups/schedule';
import { loadConfig } from './config';
import { EventBus, startWorker } from './events/bus';
import { JobRunner } from './events/queue';
import { registerSubscribers } from './events/subscribers';
import { registerFieldValueJobs, scheduleFieldValueCheck } from './fields/jobs';
import { startDirectorySync } from './ldap/scheduler';
import { buildMetricsServer, createMetrics, queryObserver, startTracing } from './observability';
import { loadPeppers } from './secrets';
import { issueSetupToken, setupLink } from './setup';
import { gracefulShutdown } from './shutdown';
import { waitForDatabase } from './startup';
import { registerTrashJobs, schedulePurge } from './trash/purge';

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
      // A dropped idle connection is replaced on the next statement; it is worth a log line.
      onIdleError: (error) =>
        console.warn(
          JSON.stringify({ msg: 'idle database connection failed', error: error.message }),
        ),
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
  ...(peppers ? { peppers } : {}),
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
let worker: { stop: () => Promise<void> } | undefined;
if (config.roles.includes('worker') && db) {
  // The domain event bus and job queue (ADR-015, M1-005): relay new events to subscribers'
  // queues and run their jobs.
  const bus = new EventBus(db);
  registerSubscribers(bus, { db });
  const runner = new JobRunner(db, `worker-${process.pid}`);
  bus.attach(runner);
  // Audit retention (M1-003): one run a day across all workers, keyed by the date; it also
  // makes next month's partition ahead.
  registerAuditJobs(runner, db, (blocked) =>
    app.log.error({ blocked }, 'audit retention stopped: a range to drop does not verify'),
  );
  const scheduleAudit = () =>
    scheduleRetention(db).catch((error) => app.log.warn({ error }, 'audit retention not queued'));
  void scheduleAudit();
  timers.push(setInterval(scheduleAudit, 60 * 60 * 1000));
  // The trash purge (M1-101): one run an hour across all workers, keyed by the hour.
  registerTrashJobs(runner, db, (report) => app.log.info({ report }, 'trash purged'));
  // Scheduled backups and their weekly verification (M1-101): checked every five minutes,
  // queued once per scheduled time across all workers.
  const backupDir = backupDirectory(config);
  registerBackupJobs(runner, db, {
    databaseUrl: config.databaseUrl as string,
    backupDir,
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
    version: config.version,
    config: {
      PUBLIC_URL: config.publicUrl,
      TASKMOOR_ROLE: config.roles.join(','),
      TASKMOOR_VERSION: config.version,
    },
    log: (msg) => app.log.info({ backupDir }, msg),
  });
  // The custom field side tables, checked against the tickets once a day (M1-011, ADR-008).
  registerFieldValueJobs(runner, db, (run) =>
    app.log.warn({ run }, 'custom field side rows repaired'),
  );
  const scheduleHousekeeping = () =>
    Promise.all([schedulePurge(db), scheduleBackups(db), scheduleFieldValueCheck(db)]).catch(
      (error) => app.log.warn({ error }, 'trash purge, backup or field value check not queued'),
    );
  void scheduleHousekeeping();
  timers.push(setInterval(scheduleHousekeeping, 5 * 60 * 1000));
  const events = startWorker({
    bus,
    runner,
    db,
    onError: (error) => app.log.error({ error }, 'worker loop failed'),
  });
  // LDAP and Active Directory syncs (M1-082): queued by schedule or an administrator.
  const directories = startDirectorySync(db, {
    worker: `worker-${process.pid}`,
    peppers,
    log: (msg, details) => app.log.warn(details, msg),
  });
  worker = {
    stop: async () => {
      await Promise.all([events.stop(), directories.stop()]);
    },
  };
  app.log.info('worker role: relaying events, running jobs and directory syncs');
}
if (config.roles.includes('realtime')) {
  app.log.info('realtime role: no channels yet (ADR-013, M1-031)');
}

const closeApp = gracefulShutdown(app);
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
  await worker?.stop();
  await closeApp(config.shutdownDrainMs);
  await metricsServer?.close();
  await tracing?.shutdown();
  await db?.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
