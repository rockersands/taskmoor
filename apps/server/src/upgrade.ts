import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  compareSchema,
  type Database,
  EXPECTED_SCHEMA,
  knownMigrations,
  MigrationError,
  type MigrationSet,
  type MigrationStatus,
  migrateToLatest,
  migrationStatus,
  type Release,
  type SchemaSnapshot,
  segmentPlan,
  migrations as shipped,
  snapshotSchema,
  upgradePath,
} from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import {
  type BackupManifest,
  backup,
  backupSize,
  countRows,
  redactSecrets,
  restore,
} from './backup';
import { BackupBusyError, message, STALE_RUN_MS } from './backups/runs';
import { type BackupWorkerState, recordedBackup } from './backups/schedule';
import { formatChecks, migrationChecks, serverChecks, type UpgradeCheck } from './upgrade-check';

/**
 * The upgrade command (M1-102, OPS-006; ADR-022 "Implementation (M1-102)"): one command takes
 * a database from any supported earlier release to this build, with no manual step per
 * version.
 *
 * 1. **Pre-flight**, read-only: database reachable and PostgreSQL 16+, no other upgrade
 *    running (an advisory lock), no unknown or out-of-order migrations, the upgrade path rule
 *    (`releases.ts`), room for the backup, other Taskmoor processes, and the plan with rough
 *    time estimates. A blocking finding stops here; a dry run always stops here.
 * 2. **Backup**: a full backup through the backup path (`backup.ts`) into
 *    `<backup dir>/pre-upgrade-<time>`, recorded in the backup log as a manual backup with
 *    `purpose: 'pre-upgrade'`, so scheduled retention never deletes it. It waits for a running
 *    backup to finish. A fresh, empty database needs none.
 * 3. **Migrations**: all pending ordinary migrations in one transaction (`migrate.ts`); online
 *    ones each alone, outside it.
 * 4. **Verification** before the commit: nothing pending, and every table, column and index of
 *    the reviewed schema (`EXPECTED_SCHEMA`) present as reviewed.
 * 5. **Rollback** on any failure. While nothing has committed, the transaction rolls back;
 *    the migration list and schema are then compared with what they were. Once something has
 *    committed (an online migration), the objects the upgrade created are dropped and the
 *    pre-upgrade backup is restored in place, then checked like the restore drill. The backup
 *    is kept either way, and the outcome lands in its backup log entry.
 */
export type UpgradeOutcome =
  /** Nothing to apply. */
  | 'up-to-date'
  /** A dry run: checks and plan only. */
  | 'planned'
  /** A pre-flight check blocks; nothing was written. */
  | 'blocked'
  | 'upgraded'
  /** The upgrade failed before changing the database (the backup could not be taken). */
  | 'failed'
  /** The upgrade failed and its transaction rolled back: the database is as before. */
  | 'rolled-back'
  /** The upgrade failed after a commit; the pre-upgrade backup was restored. */
  | 'restored'
  /** The upgrade failed and putting the database back failed too: it needs attention. */
  | 'rollback-failed';

export interface PlannedMigration {
  name: string;
  /** Runs outside a transaction (ADR-022). */
  online: boolean;
  /** Existing tables the migration changes, with their size now. */
  tables: { table: string; bytes: number }[];
  /** Rough: those tables' size at ESTIMATE_BYTES_PER_SECOND; 0 means under a second. */
  estimateSeconds: number;
}

export interface Verification {
  ok: boolean;
  pending: string[];
  /** Reviewed tables, columns and indexes the database lacks or holds in another shape. */
  missing: string[];
  /** What the database holds beyond the reviewed schema (reported, never a failure). */
  extra: string[];
}

export interface UpgradeReport {
  outcome: UpgradeOutcome;
  /** This build's version. */
  version: string;
  from: { migration: string | null; release: string | null };
  to: { migration: string | null };
  checks: UpgradeCheck[];
  plan: PlannedMigration[];
  /** Migrations applied and kept. */
  applied: string[];
  backup: { path: string; runId: string | null; sizeBytes: number } | null;
  rollback: 'transaction' | 'restore' | null;
  failedMigration: string | null;
  /** What went wrong, passwords removed. */
  error: string | null;
  verification: Verification | null;
  seconds: { preflight: number; backup: number; migrate: number; rollback: number; total: number };
}

export interface UpgradeOptions {
  databaseUrl: string;
  /** The data directory: its files and password keyring go into the backup. */
  dataDir?: string | undefined;
  /** Where the pre-upgrade backup goes (`backupDirectory()`); null when there is none. */
  backupRoot: string | null;
  /**
   * Why there is no `backupRoot` (`backupWorkerState()`): `off` when `TASKMOOR_BACKUP_DIR` is
   * `off`, so the check gives that reason instead of asking for a directory.
   */
  backupDeclined?: Exclude<BackupWorkerState, 'ready'> | undefined;
  /** This build's version, for the report and the backup manifest. */
  version: string;
  /** Non-secret settings kept in the backup. */
  config?: Record<string, string>;
  /** Pre-flight and plan only; nothing is written. */
  dryRun?: boolean;
  /**
   * No pre-upgrade backup (a database provider keeps them): a failure is rolled back by the
   * transaction alone, and a plan with online migrations is refused.
   */
  noBackup?: boolean;
  /**
   * Run by an image at start: a target whose last attempt failed is not tried again, so a
   * restarting container never takes backup after backup. A run by hand always tries.
   */
  unattended?: boolean;
  /** How long to wait for a running backup to finish (default an hour). */
  backupWaitMs?: number;
  log?: (message: string) => void;
  now?: () => Date;
  // Test seams: another migration set (earlier releases, injected failures), another release
  // list, another expected schema (null skips the schema comparison).
  migrations?: MigrationSet;
  releases?: readonly Release[];
  expectedSchema?: SchemaSnapshot | null;
}

/** Rough throughput for the dry run's estimates: a table rewritten or indexed at 50 MB/s. */
export const ESTIMATE_BYTES_PER_SECOND = 50e6;
/** What a failed upgrade leaves in the backup directory, for unattended runs to read. */
export const FAILED_MARKER = 'upgrade-failed.json';
const UPGRADE_LOCK = 'taskmoor:upgrade';

class VerificationError extends Error {
  readonly verification: Verification;
  constructor(verification: Verification) {
    super(
      verification.pending.length > 0
        ? `still pending after the upgrade: ${verification.pending.join(', ')}`
        : `the upgraded schema differs from the reviewed one in ${verification.missing.length} place(s), first: ${verification.missing[0]}`,
    );
    this.verification = verification;
  }
}

const seconds = (ms: number) => Math.round(ms / 100) / 10;
const size = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export async function upgrade(
  db: Kysely<Database>,
  options: UpgradeOptions,
): Promise<UpgradeReport> {
  const started = performance.now();
  const set = options.migrations ?? shipped;
  const known = knownMigrations(set);
  const report: UpgradeReport = {
    outcome: 'blocked',
    version: options.version,
    from: { migration: null, release: null },
    to: { migration: known[known.length - 1] ?? null },
    checks: [],
    plan: [],
    applied: [],
    backup: null,
    rollback: null,
    failedMigration: null,
    error: null,
    verification: null,
    seconds: { preflight: 0, backup: 0, migrate: 0, rollback: 0, total: 0 },
  };
  report.checks = await serverChecks(db);
  if (report.checks.some((c) => c.state === 'block')) {
    report.seconds.preflight = report.seconds.total = seconds(performance.now() - started);
    return report;
  }
  // The lock lives on one pinned connection for the whole run; the work uses the pool.
  await db.connection().execute(async (lockConnection) => {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT pg_try_advisory_lock(hashtext(${UPGRADE_LOCK})) AS ok`.execute(lockConnection);
    const locked = rows[0]?.ok === true;
    try {
      await run(db, options, set, report, locked, started);
    } finally {
      if (locked) {
        await sql`SELECT pg_advisory_unlock(hashtext(${UPGRADE_LOCK}))`
          .execute(lockConnection)
          .catch(() => {});
      }
    }
  });
  report.seconds.total = seconds(performance.now() - started);
  return report;
}

async function run(
  db: Kysely<Database>,
  options: UpgradeOptions,
  set: MigrationSet,
  report: UpgradeReport,
  locked: boolean,
  started: number,
): Promise<void> {
  const log = options.log ?? (() => {});
  const latest = report.to.migration;

  // 1. Pre-flight
  report.checks.push(
    locked
      ? { name: 'upgrade-lock', state: 'ok', detail: 'no other upgrade is running' }
      : {
          name: 'upgrade-lock',
          state: 'block',
          detail: 'another upgrade of this database is running; wait for it to finish',
        },
  );
  const before = await migrationStatus(db, set);
  const lastApplied = before.applied[before.applied.length - 1] ?? null;
  report.from = {
    migration: lastApplied,
    release:
      latest === null
        ? null
        : (upgradePath(lastApplied, latest, options.releases).from?.version ?? null),
  };
  report.checks.push(
    ...migrationChecks(before, {
      latest,
      ...(options.releases ? { releases: options.releases } : {}),
    }),
  );
  const pending = before.pending;
  const fresh = before.applied.length === 0;
  const segments = segmentPlan(pending, set);
  const online = segments.filter((s) => s.online).flatMap((s) => s.names);
  if (pending.length > 0 && !fresh) {
    report.checks.push(...(await backupChecks(db, options, online)));
    report.checks.push(await processCheck(db, online));
    if (options.unattended) {
      const previous = previousAttempt(options.backupRoot, latest);
      if (previous) report.checks.push(previous);
    }
  }
  report.plan = await planMigrations(db, pending, set);
  report.seconds.preflight = seconds(performance.now() - started);
  const blocked = report.checks.some((c) => c.state === 'block');
  // An image runs this at every start: when there is nothing to do, the outcome line is enough.
  if (pending.length > 0 || blocked || options.dryRun) log(formatChecks(report.checks).trimEnd());
  if (pending.length > 0) log(formatPlan(report.plan, segments.length).trimEnd());

  if (blocked) return;
  if (pending.length === 0) {
    report.outcome = 'up-to-date';
    return;
  }
  if (options.dryRun) {
    report.outcome = 'planned';
    return;
  }

  // 2. Backup
  const backupStarted = performance.now();
  let taken: TakenBackup | null = null;
  if (!fresh && !options.noBackup) {
    try {
      taken = await takeBackup(db, options, { from: lastApplied, to: latest });
    } catch (error) {
      report.outcome = 'failed';
      report.error = redactSecrets(message(error));
      report.seconds.backup = seconds(performance.now() - backupStarted);
      log(`the pre-upgrade backup failed; nothing was changed: ${report.error}`);
      return;
    }
    report.backup = { path: taken.path, runId: taken.runId, sizeBytes: taken.sizeBytes };
    log(`backup: ${taken.path} (${size(taken.sizeBytes)})`);
  }
  report.seconds.backup = seconds(performance.now() - backupStarted);

  // 3. and 4. Migrations, verified before the commit
  const schemaBefore = await snapshotSchema(db);
  const objectsBefore = await inventory(db);
  const expected =
    options.expectedSchema === undefined
      ? set === shipped
        ? EXPECTED_SCHEMA
        : null
      : options.expectedSchema;
  const verify = async (conn: Kysely<unknown>) => {
    report.verification = await verifySchema(conn, set, expected);
    if (!report.verification.ok) throw new VerificationError(report.verification);
  };
  const lastOnline = segments[segments.length - 1]?.online === true;
  const migrateStarted = performance.now();
  log(
    `applying ${pending.length} migration(s)${segments.length === 1 ? ' in one transaction' : ` in ${segments.length} steps`}`,
  );
  let failed = false;
  let failure: unknown;
  try {
    report.applied = await migrateToLatest(db, {
      migrations: set,
      onApplied: (name, ms) => log(`  ${name} ${seconds(ms)} s`),
      ...(lastOnline ? {} : { beforeCommit: verify }),
    });
    if (lastOnline) await verify(db as unknown as Kysely<unknown>);
  } catch (error) {
    failed = true;
    failure = error;
  }
  report.seconds.migrate = seconds(performance.now() - migrateStarted);
  if (!failed) {
    report.outcome = 'upgraded';
    const extra = report.verification?.extra.length ?? 0;
    log(
      `upgraded to ${latest}; schema verified${extra ? ` (${extra} object(s) of your own beyond the reviewed schema left as they are)` : ''}`,
    );
    clearFailure(options.backupRoot);
    await recordOutcome(db, report, taken, log);
    return;
  }
  report.error = redactSecrets(message(failure));
  report.failedMigration = failure instanceof MigrationError ? failure.migration : null;
  report.applied = [];
  log(`the upgrade failed: ${report.error}`);

  // 5. Rollback
  const rollbackStarted = performance.now();
  // Only a migration error says for sure what committed; anything else is treated as durable.
  const durable =
    !(failure instanceof MigrationError) || failure.committed.length > 0 || failure.partial;
  try {
    if (!durable && (await unchanged(db, set, before, schemaBefore))) {
      report.outcome = 'rolled-back';
      report.rollback = 'transaction';
      log('rolled back: the transaction left the database exactly as it was');
    } else if (taken) {
      log(`restoring the pre-upgrade backup ${taken.path}`);
      const dropped = await dropNewObjects(db, objectsBefore);
      if (dropped.length > 0) log(`dropped what the upgrade created: ${dropped.join(', ')}`);
      await restore(db, taken.path, { databaseUrl: options.databaseUrl, log });
      const problems = await restoredProblems(db, set, taken.manifest, schemaBefore);
      if (problems.length > 0) throw new Error(`the restored database differs: ${problems[0]}`);
      report.outcome = 'restored';
      report.rollback = 'restore';
      log('restored: the database is as the pre-upgrade backup holds it');
    } else if (fresh) {
      // An install: the database was empty, so dropping what the run created restores it.
      await dropNewObjects(db, objectsBefore);
      if (!(await unchanged(db, set, before, schemaBefore))) {
        throw new Error('the database is not empty again');
      }
      report.outcome = 'restored';
      report.rollback = 'restore';
      log('the database was empty before the install; it is empty again');
    } else {
      throw new Error('the database changed and there is no pre-upgrade backup to restore');
    }
  } catch (error) {
    report.outcome = 'rollback-failed';
    report.error = `${report.error}; rollback failed: ${redactSecrets(message(error))}`;
    log(
      taken
        ? `ROLLBACK FAILED: keep every Taskmoor process stopped and restore the backup by hand: node cli.mjs restore ${taken.path} --yes`
        : 'ROLLBACK FAILED: keep every Taskmoor process stopped and restore your latest backup',
    );
  }
  report.seconds.rollback = seconds(performance.now() - rollbackStarted);
  recordFailure(options.backupRoot, report);
  await recordOutcome(db, report, taken, log);
}

// Pre-flight

async function hasBackupLog(db: Kysely<Database>): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`
    SELECT to_regclass('public.backup_run') IS NOT NULL AS ok`.execute(db);
  return rows[0]?.ok === true;
}

/** Free bytes where `path` is, or would be once created. */
function freeBytes(path: string): number {
  let dir = resolve(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const stat = statfsSync(dir);
  return Number(stat.bavail) * Number(stat.bsize);
}

function directoryBytes(path: string | undefined): number {
  if (!path || !existsSync(path)) return 0;
  try {
    return backupSize(path);
  } catch {
    return 0;
  }
}

async function backupChecks(
  db: Kysely<Database>,
  options: UpgradeOptions,
  online: readonly string[],
): Promise<UpgradeCheck[]> {
  if (options.noBackup) {
    return [
      online.length > 0
        ? {
            name: 'backup',
            state: 'block',
            detail: `online migrations (${online.join(', ')}) can only be rolled back from a backup; run without --no-backup`,
          }
        : {
            name: 'backup',
            state: 'warn',
            detail:
              'no pre-upgrade backup (--no-backup): a failure is rolled back by the transaction alone',
          },
    ];
  }
  if (!options.backupRoot) {
    return [
      {
        name: 'backup',
        state: 'block',
        // With TASKMOOR_BACKUP_DIR=off the data directory may well be set: the reason is the
        // one scheduled backups give, not a variable to set that already is.
        detail:
          options.backupDeclined === 'off'
            ? 'backups are off on this process (TASKMOOR_BACKUP_DIR=off): run the upgrade with TASKMOOR_BACKUP_DIR set to a directory, or pass --no-backup when the database provider keeps backups'
            : 'no backup directory: set TASKMOOR_DATA or TASKMOOR_BACKUP_DIR, or pass --no-backup when the database provider keeps backups',
      },
    ];
  }
  const checks: UpgradeCheck[] = [];
  const logged = await hasBackupLog(db);
  const running = logged
    ? await db
        .selectFrom('backup_run')
        .select(['kind', 'started_at'])
        .where('state', '=', 'running')
        .where('kind', '!=', 'drill')
        .where('heartbeat_at', '>', new Date(Date.now() - STALE_RUN_MS))
        .executeTakeFirst()
    : undefined;
  checks.push(
    running
      ? {
          name: 'backup',
          state: 'warn',
          detail: `a ${running.kind} backup started at ${running.started_at.toISOString()} is running; the upgrade waits for it, then backs up to ${options.backupRoot}`,
        }
      : {
          name: 'backup',
          state: 'ok',
          detail: `a full backup goes to ${join(options.backupRoot, 'pre-upgrade-<time>')} first and is kept`,
        },
  );

  // The last backup's size is the best guess; without one, the database and files as they are.
  const last = logged
    ? await db
        .selectFrom('backup_run')
        .select('size_bytes')
        .where('state', '=', 'succeeded')
        .where('kind', '!=', 'drill')
        .where('size_bytes', 'is not', null)
        .orderBy('started_at', 'desc')
        .limit(1)
        .executeTakeFirst()
    : undefined;
  let need: number;
  let basis: string;
  if (last?.size_bytes) {
    need = Math.ceil(Number(last.size_bytes) * 1.2);
    basis = 'the last backup and a fifth more';
  } else {
    const { rows } = await sql<{ size: string }>`
      SELECT pg_database_size(current_database()) AS size`.execute(db);
    need =
      Number(rows[0]?.size ?? 0) +
      directoryBytes(options.dataDir && join(options.dataDir, 'files'));
    basis = 'the database and files as they are';
  }
  const free = freeBytes(options.backupRoot);
  const detail = `${size(free)} free for the backup, which needs about ${size(need)} (${basis})`;
  checks.push(
    free < need
      ? { name: 'backup-space', state: 'block', detail }
      : free < 2 * need
        ? { name: 'backup-space', state: 'warn', detail: `${detail}; little room is left after it` }
        : { name: 'backup-space', state: 'ok', detail },
  );
  return checks;
}

/** Other Taskmoor processes on this database (the server names its connections taskmoor-<roles>). */
async function processCheck(
  db: Kysely<Database>,
  online: readonly string[],
): Promise<UpgradeCheck> {
  const { rows } = await sql<{ name: string; n: number }>`
    SELECT application_name AS name, count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid()
       AND application_name LIKE 'taskmoor-%' AND application_name <> 'taskmoor-cli'
     GROUP BY application_name ORDER BY application_name`.execute(db);
  if (rows.length === 0) {
    return { name: 'processes', state: 'ok', detail: 'no other Taskmoor process is connected' };
  }
  const who = rows.map((r) => `${r.name} (${r.n})`).join(', ');
  return online.length > 0
    ? {
        name: 'processes',
        state: 'block',
        detail: `${who} connected: stop them first; this plan has online migrations, whose rollback restores the backup and would undo what they write meanwhile`,
      }
    : {
        name: 'processes',
        state: 'warn',
        detail: `${who} connected: they keep running the old version, which may not work with the new schema; stop them first and start the new version afterwards`,
      };
}

interface FailedAttempt {
  target: string | null;
  version: string;
  at: string;
  outcome: UpgradeOutcome;
  error: string | null;
}

function previousAttempt(root: string | null, target: string | null): UpgradeCheck | null {
  if (!root) return null;
  const path = join(root, FAILED_MARKER);
  if (!existsSync(path)) return null;
  let attempt: FailedAttempt;
  try {
    attempt = JSON.parse(readFileSync(path, 'utf8')) as FailedAttempt;
  } catch {
    return null;
  }
  if (attempt.target !== target) return null;
  return {
    name: 'previous-attempt',
    state: 'block',
    detail: `the upgrade to ${target} (${attempt.version}) failed at ${attempt.at} and was ${attempt.outcome}: ${attempt.error ?? 'see the backup log'}. It is not retried at start: start the previous release again, or retry by hand with node cli.mjs upgrade`,
  };
}

function recordFailure(root: string | null, report: UpgradeReport): void {
  if (!root || !existsSync(root)) return;
  const attempt: FailedAttempt = {
    target: report.to.migration,
    version: report.version,
    at: new Date().toISOString(),
    outcome: report.outcome,
    error: report.error,
  };
  writeFileSync(join(root, FAILED_MARKER), `${JSON.stringify(attempt, null, 2)}\n`);
}

function clearFailure(root: string | null): void {
  if (root) rmSync(join(root, FAILED_MARKER), { force: true });
}

// The plan

/**
 * The existing tables a migration's code changes (altered, written, indexed): a rough reading of
 * its SQL for the dry run's estimates, never used to decide anything.
 */
export function touchedTables(source: string, existing: Iterable<string>): string[] {
  const out: string[] = [];
  for (const table of existing) {
    const name = table.replace(/[^a-z0-9_]/gi, '');
    const pattern = new RegExp(
      `(?:ALTER TABLE|UPDATE|INSERT INTO|DELETE FROM|TRUNCATE|CLUSTER|\\bON|alterTable\\(|updateTable\\(|insertInto\\(|deleteFrom\\()\\s*(?:IF EXISTS\\s+)?(?:ONLY\\s+)?(?:public\\.)?["'\`]?${name}(?![a-z0-9_])`,
    );
    if (pattern.test(source)) out.push(table);
  }
  return out.sort();
}

async function planMigrations(
  db: Kysely<Database>,
  pending: readonly string[],
  set: MigrationSet,
): Promise<PlannedMigration[]> {
  if (pending.length === 0) return [];
  const { rows } = await sql<{ name: string; bytes: string }>`
    SELECT c.relname AS name,
           CASE WHEN c.relkind = 'p'
                THEN (SELECT coalesce(sum(pg_total_relation_size(t.relid)), 0)
                        FROM pg_partition_tree(c.oid) t)
                ELSE pg_total_relation_size(c.oid) END AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`.execute(db);
  const sizes = new Map(rows.map((r) => [r.name, Number(r.bytes)]));
  return pending.map((name) => {
    const migration = set[name];
    const tables = touchedTables(migration?.up.toString() ?? '', sizes.keys()).map((table) => ({
      table,
      bytes: sizes.get(table) ?? 0,
    }));
    const bytes = tables.reduce((n, t) => n + t.bytes, 0);
    return {
      name,
      online: migration?.online === true,
      tables,
      estimateSeconds: Math.floor(bytes / ESTIMATE_BYTES_PER_SECOND),
    };
  });
}

export function formatPlan(plan: readonly PlannedMigration[], steps: number): string {
  const total = plan.reduce((n, p) => n + p.estimateSeconds, 0);
  const lines = [
    `Plan: ${plan.length} migration(s) in ${steps === 1 ? 'one transaction' : `${steps} steps`}, ${total < 1 ? 'under a second' : `about ${total} s`} in all (rough, from the size of the tables each changes):`,
  ];
  const width = Math.max(...plan.map((p) => p.name.length));
  for (const p of plan) {
    const bytes = p.tables.reduce((n, t) => n + t.bytes, 0);
    const changes =
      p.tables.length === 0
        ? 'new tables only'
        : `changes ${p.tables.map((t) => t.table).join(', ')} (${size(bytes)})`;
    const time = p.estimateSeconds < 1 ? 'under 1 s' : `about ${p.estimateSeconds} s`;
    lines.push(`  ${p.name.padEnd(width)}  ${p.online ? 'online, ' : ''}${changes}: ${time}`);
  }
  return `${lines.join('\n')}\n`;
}

// Backup

interface TakenBackup {
  path: string;
  runId: string | null;
  sizeBytes: number;
  manifest: BackupManifest;
  startedAt: Date;
}

async function takeBackup(
  db: Kysely<Database>,
  options: UpgradeOptions,
  upgrade: { from: string | null; to: string | null },
): Promise<TakenBackup> {
  const root = options.backupRoot as string;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const now = options.now?.() ?? new Date();
  const out = join(root, `pre-upgrade-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  const target = {
    databaseUrl: options.databaseUrl,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    version: options.version,
    ...(options.config ? { config: options.config } : {}),
    ...(options.log ? { log: options.log } : {}),
  };
  const startedAt = new Date();
  try {
    if (!(await hasBackupLog(db))) {
      // A database from before the backup log (M1-101): recorded once the upgrade created it.
      const manifest = await backup(db, out, target);
      return { path: out, runId: null, sizeBytes: backupSize(out), manifest, startedAt };
    }
    const deadline = Date.now() + (options.backupWaitMs ?? 60 * 60_000);
    for (;;) {
      try {
        const taken = await recordedBackup(db, 'manual', out, target, {
          details: { purpose: 'pre-upgrade', from: upgrade.from, to: upgrade.to },
        });
        return { path: out, ...taken, startedAt };
      } catch (error) {
        const wait = deadline - Date.now();
        if (!(error instanceof BackupBusyError) || wait <= 0) throw error;
        options.log?.('another backup is running; waiting for it to finish');
        await new Promise((r) => setTimeout(r, Math.min(5_000, wait)));
      }
    }
  } catch (error) {
    // Half a backup is no backup; this directory is the upgrade's own.
    rmSync(out, { recursive: true, force: true });
    throw error;
  }
}

/** The outcome, in the pre-upgrade backup's log entry (created now for a database before it). */
async function recordOutcome(
  db: Kysely<Database>,
  report: UpgradeReport,
  taken: TakenBackup | null,
  log: (message: string) => void,
): Promise<void> {
  if (!taken) return;
  const outcome = {
    outcome: report.outcome,
    from: report.from,
    to: report.to,
    version: report.version,
    applied: report.applied.length,
    failedMigration: report.failedMigration,
    rollback: report.rollback,
    error: report.error,
    seconds: report.seconds,
  };
  try {
    if (!(await hasBackupLog(db))) return;
    if (taken.runId) {
      await sql`
        UPDATE backup_run SET details = details || jsonb_build_object('upgrade', ${JSON.stringify(outcome)}::jsonb)
         WHERE id = ${taken.runId}`.execute(db);
    } else {
      const row = await db
        .insertInto('backup_run')
        .values({
          kind: 'manual',
          state: 'succeeded',
          started_at: taken.startedAt,
          finished_at: new Date(),
          path: taken.path,
          size_bytes: String(taken.sizeBytes),
          details: JSON.stringify({
            purpose: 'pre-upgrade',
            migrations: taken.manifest.migrations.length,
            upgrade: outcome,
          }),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      taken.runId = String(row.id);
      if (report.backup) report.backup.runId = taken.runId;
    }
  } catch (error) {
    log(`the backup log could not record the outcome: ${redactSecrets(message(error))}`);
  }
}

// Verification and rollback

async function verifySchema(
  db: Kysely<unknown>,
  set: MigrationSet,
  expected: SchemaSnapshot | null,
): Promise<Verification> {
  const status = await migrationStatus(db, set);
  const diff = expected
    ? compareSchema(await snapshotSchema(db), expected)
    : { missing: [], extra: [] };
  return {
    ok: status.pending.length === 0 && status.unknown.length === 0 && diff.missing.length === 0,
    pending: status.pending,
    missing: diff.missing.slice(0, 50),
    extra: diff.extra.slice(0, 50),
  };
}

/** Same migrations and schema as before the upgrade. */
async function unchanged(
  db: Kysely<Database>,
  set: MigrationSet,
  before: MigrationStatus,
  schemaBefore: SchemaSnapshot,
): Promise<boolean> {
  const now = await migrationStatus(db, set);
  const diff = compareSchema(await snapshotSchema(db), schemaBefore);
  return sameList(now.applied, before.applied) && diff.missing.length + diff.extra.length === 0;
}

/** After a restore: migrations as the backup's, schema as before, every table's rows as backed up. */
async function restoredProblems(
  db: Kysely<Database>,
  set: MigrationSet,
  manifest: BackupManifest,
  schemaBefore: SchemaSnapshot,
): Promise<string[]> {
  const problems: string[] = [];
  const status = await migrationStatus(db, set);
  if (!sameList(status.applied, manifest.migrations)) {
    problems.push(`migrations ${status.applied.join(', ')} instead of the backup's`);
  }
  const diff = compareSchema(await snapshotSchema(db), schemaBefore);
  for (const entry of diff.missing) problems.push(`missing ${entry}`);
  for (const entry of diff.extra) problems.push(`left over ${entry}`);
  if (manifest.rowCounts) {
    const counts = await countRows(db);
    for (const table of new Set([...Object.keys(manifest.rowCounts), ...Object.keys(counts)])) {
      if (manifest.rowCounts[table] !== counts[table]) {
        problems.push(
          `${table}: ${counts[table] ?? 'no'} rows, the backup holds ${manifest.rowCounts[table] ?? 'none'}`,
        );
      }
    }
  }
  return problems;
}

interface DbObject {
  /** Quoted, schema-qualified name (functions with their argument types; a constraint's own). */
  name: string;
  /** The DROP statement's object type; CONSTRAINT for a foreign key. */
  type: string;
  /** For a constraint: its table, quoted and schema-qualified. */
  table?: string | null;
}

/**
 * The objects outside the system schemas that a restore must not find left over: relations,
 * routines, types, extensions, schemas (extension members excluded) and foreign keys. Indexes,
 * triggers, other constraints and columns go with their tables, which the restore drops and
 * recreates; a new foreign key on a table the backup holds would block that drop.
 */
async function inventory(db: Kysely<Database>): Promise<DbObject[]> {
  const { rows } = await sql<DbObject>`
    WITH ext AS (SELECT objid FROM pg_depend WHERE deptype = 'e')
    SELECT format('%I.%I', n.nspname, c.relname) AS name,
           CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                          WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE'
                          ELSE 'TABLE' END AS type,
           NULL::text AS "table"
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
       AND c.oid NOT IN (SELECT objid FROM ext)
    UNION ALL
    SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
           CASE p.prokind WHEN 'a' THEN 'AGGREGATE' ELSE 'ROUTINE' END, NULL
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
       AND p.oid NOT IN (SELECT objid FROM ext)
    UNION ALL
    SELECT format('%I.%I', n.nspname, t.typname),
           CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, NULL
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
       AND (t.typtype IN ('e', 'd', 'r', 'm')
            OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c'))
       AND t.oid NOT IN (SELECT objid FROM ext)
    UNION ALL
    SELECT quote_ident(extname), 'EXTENSION', NULL FROM pg_extension WHERE extname <> 'plpgsql'
    UNION ALL
    SELECT quote_ident(nspname), 'SCHEMA', NULL FROM pg_namespace
     WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_'
    UNION ALL
    -- Foreign keys: one added to a table the backup holds depends on that table's keys, so the
    -- restore could not drop them (0064 put one on user_session).
    SELECT quote_ident(con.conname), 'CONSTRAINT', format('%I.%I', n.nspname, c.relname)
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE con.contype = 'f'
       AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`.execute(db);
  return rows;
}

/**
 * Drops what exists now but did not before the upgrade, so the restore (which drops and
 * recreates only what the backup holds) neither trips over it (a new table referencing an old
 * one blocks the old one's drop) nor leaves it behind. Returns what it dropped.
 */
async function dropNewObjects(
  db: Kysely<Database>,
  before: readonly DbObject[],
): Promise<string[]> {
  const id = (o: DbObject) => `${o.type} ${o.table ? `${o.table}.` : ''}${o.name}`;
  const known = new Set(before.map(id));
  const order = [
    'CONSTRAINT',
    'SCHEMA',
    'TABLE',
    'FOREIGN TABLE',
    'MATERIALIZED VIEW',
    'VIEW',
    'SEQUENCE',
  ];
  const rank = (type: string) => (order.includes(type) ? order.indexOf(type) : order.length);
  const created = (await inventory(db))
    .filter((o) => !known.has(id(o)))
    .sort((a, b) => rank(a.type) - rank(b.type));
  for (const object of created) {
    const drop =
      object.type === 'CONSTRAINT'
        ? `ALTER TABLE IF EXISTS ${object.table} DROP CONSTRAINT IF EXISTS ${object.name}`
        : `DROP ${object.type} IF EXISTS ${object.name} CASCADE`;
    await sql`${sql.raw(drop)}`.execute(db);
  }
  return created.map((o) => `${o.type.toLowerCase()} ${o.table ? `${o.table}.` : ''}${o.name}`);
}

export function upgradeExitCode(outcome: UpgradeOutcome): number {
  if (outcome === 'up-to-date' || outcome === 'planned' || outcome === 'upgraded') return 0;
  return outcome === 'rollback-failed' ? 3 : 1;
}

/** The closing lines of `node cli.mjs upgrade`. */
export function formatOutcome(report: UpgradeReport): string {
  const from = report.from.release
    ? `${report.from.release} (${report.from.migration})`
    : (report.from.migration ?? 'an empty database');
  const total = `${report.seconds.total} s`;
  const kept = report.backup ? ` The pre-upgrade backup is kept at ${report.backup.path}.` : '';
  switch (report.outcome) {
    case 'up-to-date':
      return `Up to date at ${report.to.migration}; nothing to do.\n`;
    case 'planned':
      return `Dry run: ${report.plan.length} migration(s) from ${from} to ${report.to.migration} (${report.version}); nothing was changed.\n`;
    case 'blocked':
      return 'Not upgraded: a check above blocks; nothing was changed.\n';
    case 'upgraded':
      return `Upgraded from ${from} to ${report.to.migration} (${report.version}) in ${total}: backup ${report.seconds.backup} s, migrations ${report.seconds.migrate} s.${kept}\n`;
    case 'failed':
      return `Not upgraded: ${report.error}. Nothing was changed.\n`;
    case 'rolled-back':
      return `Upgrade FAILED${report.failedMigration ? ` in ${report.failedMigration}` : ''}: ${report.error}\nRolled back: the database is exactly as it was before (${from}).${kept}\n`;
    case 'restored':
      return `Upgrade FAILED${report.failedMigration ? ` in ${report.failedMigration}` : ''}: ${report.error}\nRestored the pre-upgrade backup: the database is as it was before (${from}).${kept}\n`;
    case 'rollback-failed':
      return `Upgrade FAILED and the rollback failed too: ${report.error}\nKeep Taskmoor stopped and restore the pre-upgrade backup by hand${report.backup ? `: node cli.mjs restore ${report.backup.path} --yes` : ''}.\n`;
  }
}
