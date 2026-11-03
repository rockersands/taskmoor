import { createDb, migrateToLatest, poolStats } from '@taskmoor/db';
import { passwordHasher } from '@taskmoor/iam';
import { rewrapCredentials } from './ai/credentials';
import { importAiEnvironment } from './ai/environment';
import { aiKeyRing } from './ai/keyring';
import { buildApp } from './app';
import { scheduleSweep } from './attachments/cleanup';
import { registerAttachmentJobs } from './attachments/jobs';
import { attachmentStores } from './attachments/stores';
import { registerAuditJobs, scheduleRetention } from './audit/retention';
import { forwardAudit } from './audit/syslog';
import { Authorizer } from './authz/authorizer';
import { backupDirectory, registerBackupJobs, scheduleBackups } from './backups/schedule';
import { registerBulkJobs } from './bulk/jobs';
import { trimBulkOperations } from './bulk/model';
import { loadConfig } from './config';
import { deliverEmail, type MailerOptions } from './email/deliver';
import { effectiveSmtp } from './email/smtp';
import { smtpTransport } from './email/transport';
import {
  EMBEDDING_SUBSCRIBER,
  registerEmbeddingJobs,
  SWEEP_TASK,
  scheduleBootSweeps,
} from './embeddings/jobs';
import { EmbeddingService, embedderFor } from './embeddings/service';
import { EventBus, eventTask, startWorker } from './events/bus';
import { JobRunner } from './events/queue';
import { registerSubscribers } from './events/subscribers';
import { FieldCatalogs } from './fields/catalog';
import { registerFormulaJobs, scheduleFormulaRefresh } from './fields/formula-jobs';
import { registerFieldValueJobs, scheduleFieldValueCheck } from './fields/jobs';
import { registerImportJobs } from './import/jobs';
import { startDirectorySync } from './ldap/scheduler';
import { buildMetricsServer, createMetrics, queryObserver, startTracing } from './observability';
import { outboundGuard } from './outbound/guard';
import { registerEraseJobs } from './privacy/erase';
import { expirePersonalExports, registerPersonalExportJobs } from './privacy/export';
import { trimApiUsage } from './ratelimit/usage';
import { deliverSubscriptions } from './search/subscriptions';
import { loadPeppers } from './secrets';
import { deliverSecurityEmail } from './security/mail';
import { issueSetupToken, setupLink } from './setup';
import { gracefulShutdown } from './shutdown';
import { rollSprintCycles } from './sprints/cycles';
import { waitForDatabase } from './startup';
import { registerChangeLogJobs, scheduleChangeLogTrim } from './sync/jobs';
import { registerTrashJobs, schedulePurge } from './trash/purge';
import {
  githubReleases,
  registerUpdateCheckJobs,
  scheduleUpdateCheck,
  type UpdateCheckConfig,
} from './updates/check';
import { registerWebhookJobs, trimWebhookDeliveries } from './webhooks/deliver';
import { registerWorkflowMigrationJobs } from './workflows/migration';
import { defaultWorkspaceId } from './workspace';

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

// AI provider credentials (M1-075, ADR-098): data keys wrapped by the master key, else the
// pepper. The API role re-wraps what an earlier key wrapped, then moves the environment's AI
// settings in on the first start. Log lines name variables and counts, never a value.
const aiKeys = aiKeyRing({
  masterKey: config.masterKey,
  previousMasterKeys: config.previousMasterKeys,
  peppers,
});
if (db && config.roles.includes('api')) {
  const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));
  const moved = await rewrapCredentials(db, aiKeys.ring);
  if (moved.rewrapped > 0) {
    log({ msg: 'AI credentials re-wrapped under the active key', count: moved.rewrapped });
  }
  if (moved.unreadable > 0) {
    log({
      msg: 'AI credentials are wrapped by a key this server does not have: set TASKMOOR_MASTER_KEY_PREVIOUS',
      count: moved.unreadable,
    });
  }
  await importAiEnvironment(db, aiKeys.ring, config.aiEnvironment, log);
}

// Attachments (M1-016, ADR-040): local disk under TASKMOOR_DATA/files, or an S3 bucket.
const attachments = await attachmentStores(config);
if (config.roles.includes('api') && !attachments.active) {
  console.log(
    JSON.stringify({
      msg: 'attachments are off: set TASKMOOR_DATA, TASKMOOR_FILES_DIR or TASKMOOR_S3_BUCKET',
    }),
  );
}

/**
 * Where browsers download attachments kept in S3 (signed URLs), for the app's content security
 * policy: the public endpoint, the endpoint (with the bucket in front unless path-style), or AWS.
 */
function bucketOrigin(s3: NonNullable<typeof config.storage.s3>): string {
  const endpoint = s3.publicEndpoint ?? s3.endpoint;
  if (!endpoint) return `https://${s3.bucket}.s3.${s3.region}.amazonaws.com`;
  const url = new URL(endpoint);
  return s3.forcePathStyle ? url.origin : `${url.protocol}//${s3.bucket}.${url.host}`;
}

// Embeddings for similar tickets and duplicate suggestions (M1-078, ADR-106): the bundled
// local model by default, no AI key needed. pgvector and its HNSW index are set up where the
// database offers them; otherwise lookups scan exactly.
const embedder = embedderFor(config.embeddings);
const vectorSearch = config.vectorSearch === 'exact' ? ('exact' as const) : undefined;
const embeddings =
  db && embedder
    ? new EmbeddingService(db, embedder, vectorSearch ? { search: vectorSearch } : {})
    : null;
if (embeddings && (config.roles.includes('api') || config.roles.includes('worker'))) {
  const status = await embeddings.prepare();
  console.log(
    JSON.stringify({
      msg:
        status.search === 'pgvector'
          ? 'similar tickets: pgvector with an HNSW index'
          : 'similar tickets: exact scan (no pgvector)',
      model: embedder?.model,
      ...(status.version ? { pgvector: status.version } : {}),
      ...(status.reason ? { reason: status.reason } : {}),
    }),
  );
} else if (!embedder && config.roles.includes('api')) {
  console.log(JSON.stringify({ msg: 'similar tickets are off (TASKMOOR_EMBEDDINGS=off)' }));
}

const app = await buildApp({
  embedder,
  ...(vectorSearch ? { vectorSearch } : {}),
  rateLimits: {},
  ...(config.smtp ? { smtp: config.smtp } : {}),
  passwords: passwordHasher(peppers),
  ...(peppers ? { peppers } : {}),
  aiKeys,
  ...(db ? { db } : {}),
  version: config.version,
  logLevel: config.logLevel,
  roles: config.roles,
  secureCookies: config.secureCookies,
  publicUrl: config.publicUrl,
  allowedOrigins: config.allowedOrigins,
  oauthRedirectUris: config.oauthRedirectUris,
  mediaOrigins: config.storage.s3 ? [bucketOrigin(config.storage.s3)] : [],
  ...(config.instance ? { instance: config.instance } : {}),
  ...(config.trustedProxies ? { trustedProxies: config.trustedProxies } : {}),
  ...(config.webDir ? { webDir: config.webDir, webRouting: config.webRouting } : {}),
  metrics,
  ...(tracing ? { tracer: tracing.tracer } : {}),
  ...(config.dataDir ? { dataDir: config.dataDir } : {}),
  startedAt,
  attachments,
  ...(config.importDir ? { importDir: config.importDir } : {}),
  smtpConfigured: config.smtp !== undefined,
  ...(config.smtpPassword ? { smtpPassword: config.smtpPassword } : {}),
  queryTimeoutMs: config.queryTimeoutMs,
  jiraCompat: config.jiraCompat,
  updateCheck: { environmentOff: !config.updateCheck, command: config.updateCommand },
});
const metricsServer = config.metricsPort > 0 ? await buildMetricsServer(metrics) : undefined;

const timers: NodeJS.Timeout[] = [];
let worker: { stop: () => Promise<void> } | undefined;
if (config.roles.includes('worker') && db) {
  // The domain event bus and job queue (ADR-015, M1-005): relay new events to subscribers'
  // queues and run their jobs.
  const bus = new EventBus(db);
  registerSubscribers(bus, {
    db,
    publicUrl: config.publicUrl,
    ...(embeddings ? { embeddings: embeddings.indexer } : {}),
  });
  const runner = new JobRunner(db, `worker-${process.pid}`);
  bus.attach(runner);
  // Embeddings (M1-078): what events name, and a sweep per workspace the first time a model
  // runs (an upgrade embeds what was there before). With embeddings off, jobs left from
  // before finish without doing anything.
  if (embeddings) {
    registerEmbeddingJobs(runner, db, embeddings.indexer, {
      log: (msg, details) => app.log.info(details, msg),
    });
    void scheduleBootSweeps(db, embeddings.model).catch((error) =>
      app.log.warn({ error }, 'embedding sweep not queued'),
    );
  } else {
    runner.handle(eventTask(EMBEDDING_SUBSCRIBER), async () => {});
    runner.handle(SWEEP_TASK, async () => {});
  }
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
  // Attachments (M1-016): scans and thumbnails of new files, and the storage sweep that
  // deletes the files of deleted attachments (queued by deletions and the purge, and hourly).
  registerAttachmentJobs(runner, db, attachments);
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
  // The change log keeps 30 days unless set otherwise (M1-031, ADR-013).
  registerChangeLogJobs(runner, db);
  // Formula fields (M1-013): roll-ups of parents a write could not take, recomputes after a
  // formula or what it reads changed, and the daily refresh of formulas that read the date.
  registerFormulaJobs(runner, db);
  // Bulk operations (M1-021): each runs ticket by ticket through the ticket routes' checks;
  // clones (M1-124) copy attachments between this process's stores.
  registerBulkJobs(runner, db, new Authorizer(db), new FieldCatalogs(db), {
    stores: attachments,
  });
  // Imports (M1-086): a batch per transaction, resumable from the run's checkpoint.
  registerImportJobs(runner, db, new FieldCatalogs(db), { stores: attachments, peppers });
  // Status migrations after a change of workflow map (M1-028), a batch at a time.
  registerWorkflowMigrationJobs(runner, db, new FieldCatalogs(db));
  // Webhook deliveries (M1-067): one job per sending, retried with backoff.
  registerWebhookJobs(runner, db, { peppers });
  // A person's data (ASVS 8.3.2, ADR-111): downloads into the attachment store, and the names
  // an erasure replaces in other records.
  registerPersonalExportJobs(runner, db, attachments, new Authorizer(db));
  registerEraseJobs(runner, db);
  // The look at the public releases behind the administrators' notice (OPS-026, ADR-117): at
  // most once a day, through the outbound guard; a failure says so only at debug level.
  const updateCheck: UpdateCheckConfig = {
    version: config.version,
    environmentOff: !config.updateCheck,
    command: config.updateCommand,
  };
  registerUpdateCheckJobs(
    runner,
    db,
    githubReleases(outboundGuard().fetch),
    updateCheck,
    (message) => app.log.debug(message),
  );
  const formulaCatalogs = new FieldCatalogs(db);
  const scheduleHousekeeping = () =>
    Promise.all([
      schedulePurge(db),
      scheduleBackups(db),
      scheduleFieldValueCheck(db),
      scheduleChangeLogTrim(db),
      scheduleFormulaRefresh(db, formulaCatalogs),
      trimWebhookDeliveries(db),
      trimBulkOperations(db),
      trimApiUsage(db),
      expirePersonalExports(db),
      defaultWorkspaceId(db).then((ws) => scheduleSweep(db, ws)),
      scheduleUpdateCheck(db, updateCheck),
    ]).catch((error) =>
      app.log.warn(
        { error },
        'trash purge, backup, field value check, change log trim, formula refresh, webhook delivery, bulk operation, API usage or personal download trim, storage sweep or new-version check not queued',
      ),
    );
  void scheduleHousekeeping();
  timers.push(setInterval(scheduleHousekeeping, 5 * 60 * 1000));
  // Auto-rolling cycles (M1-045): every minute, boards with a cycle get their next sprint ready
  // and roll over a sprint that ended. Each board is locked while it rolls, so several workers
  // can run this.
  const cycleCatalogs = new FieldCatalogs(db);
  const rollCycles = () =>
    rollSprintCycles(db, cycleCatalogs)
      .then((run) => {
        if (run.rolled > 0 || run.failed.length > 0) app.log.info({ run }, 'sprint cycles');
      })
      .catch((error) => app.log.warn({ error }, 'sprint cycles not rolled'));
  void rollCycles();
  // Audit records to syslog (M1-085): every ten seconds, what the log gained since the last run.
  const syslogHost = new URL(config.publicUrl).hostname;
  const forwardToSyslog = () =>
    defaultWorkspaceId(db)
      .then((ws) => forwardAudit(db, ws, syslogHost))
      .then((run) => {
        if (run?.error) app.log.warn({ error: run.error }, 'audit records not sent to syslog');
      })
      .catch((error) => app.log.warn({ error }, 'audit forwarding to syslog failed'));
  timers.push(setInterval(forwardToSyslog, 10 * 1000));
  timers.push(setInterval(rollCycles, 60 * 1000));
  // Email notifications (M1-057): every 30 seconds, what is due goes out. Workers lock each
  // person's notifications while sending, so several can run.
  // The SMTP server from TASKMOOR_SMTP_URL, or else the one the setup form saved, read on every
  // run so mail set up after the server started goes out without a restart.
  let mailer: { key: string; options: MailerOptions } | null = null;
  let mailMissing = false;
  const currentMailer = async (): Promise<MailerOptions | null> => {
    const smtp = await effectiveSmtp(db, config.smtp, config.smtpPassword);
    if (!smtp) {
      if (!mailMissing) {
        app.log.info(
          'email notifications wait unsent: set TASKMOOR_SMTP_URL, or the mail settings of the setup form with TASKMOOR_SMTP_PASSWORD when they name a user',
        );
      }
      mailMissing = true;
      return null;
    }
    mailMissing = false;
    const key = JSON.stringify(smtp);
    if (mailer?.key !== key) {
      mailer = {
        key,
        options: { transport: smtpTransport(smtp), from: smtp.from, publicUrl: config.publicUrl },
      };
    }
    return mailer.options;
  };
  const mailAuthorizer = new Authorizer(db);
  const sendEmail = () =>
    currentMailer()
      .then((options) => (options ? deliverEmail(db, mailAuthorizer, options) : null))
      .then((run) => {
        if (run && (run.sent > 0 || run.failed > 0)) app.log.info({ run }, 'notification emails');
      })
      .catch((error) => app.log.warn({ error }, 'notification emails not sent'));
  void sendEmail();
  timers.push(setInterval(sendEmail, 30 * 1000));
  // Security notices and alerts (ADR-109): every 15 seconds, one email each, no batching.
  const sendSecurityEmail = () =>
    currentMailer()
      .then((options) =>
        options
          ? deliverSecurityEmail(db, {
              transport: options.transport,
              from: options.from,
              publicUrl: options.publicUrl,
            })
          : null,
      )
      .then((run) => {
        if (run && (run.sent > 0 || run.failed > 0)) app.log.info({ run }, 'security emails');
      })
      .catch((error) => app.log.warn({ error }, 'security emails not sent'));
  timers.push(setInterval(sendSecurityEmail, 15 * 1000));
  // Search subscriptions (M1-063): each due one runs as each recipient; claimed per run.
  const subscriptionCatalogs = new FieldCatalogs(db);
  const sendSubscriptions = () =>
    currentMailer()
      .then((options) =>
        options ? deliverSubscriptions(db, mailAuthorizer, subscriptionCatalogs, options) : null,
      )
      .then((run) => {
        if (run && run.due > 0) app.log.info({ run }, 'search subscription emails');
      })
      .catch((error) => app.log.warn({ error }, 'search subscription emails not sent'));
  timers.push(setInterval(sendSubscriptions, 60 * 1000));
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
  app.log.info(
    'realtime role: change log positions over /api/v1/sync/socket (M1-032), co-editing at /api/v1/collab (M1-017)',
  );
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
  await embedder?.close();
  await metricsServer?.close();
  await tracing?.shutdown();
  await db?.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
