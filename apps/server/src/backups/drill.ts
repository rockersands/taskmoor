import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createDb, type Database, migrationStatus } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import {
  type BackupManifest,
  clientBinary,
  countRows,
  pgConnection,
  restoreJobs,
  serverMajor,
  verifyBackup,
} from '../backup';
import { finishRun, message, startRun, withHeartbeat } from './runs';

const run = promisify(execFile);

/**
 * The restore drill (M1-101, OPS-008 (2), ADR-022): proves a backup can be put back, without
 * touching the live database.
 *
 * 1. The backup's checksums are verified (a damaged backup stops here).
 * 2. A scratch database `taskmoor_drill_<time>` is created on the same server and the dump is
 *    restored into it with pg_restore, in parallel (`restoreJobs`).
 * 3. Every table's row count is compared with the counts the backup took from the very
 *    snapshot it dumped (`rowCounts` in the manifest), and the applied migrations with the
 *    manifest's.
 * 4. The scratch database is dropped, whatever happened (unless asked to keep it).
 *
 * It reports the time of each step. The database user needs CREATEDB (the Compose kits' user
 * has it). `node cli.mjs drill` runs it by hand; the scheduler runs it weekly.
 */
export interface DrillReport {
  backup: string;
  createdAt: string;
  version: string;
  scratchDatabase: string;
  seconds: { verify: number; restore: number; check: number; total: number };
  tables: number;
  rows: number;
  /** Tables whose restored row count differs from the backup's (or that one side lacks). */
  mismatches: { table: string; expected: number | null; actual: number | null }[];
  /** False when the backup holds no row counts (taken before M1-101): only the restore ran. */
  countsChecked: boolean;
  migrationsMatch: boolean;
  ok: boolean;
}

const seconds = (ms: number) => Math.round(ms / 100) / 10;

/**
 * The newest backup under `root`: the subdirectory whose manifest says it was made last.
 * Null when there is none.
 */
export function latestBackup(root: string): string | null {
  if (!existsSync(root)) return null;
  let best: { dir: string; at: number } | null = null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(root, entry.name, 'manifest.json');
    if (!existsSync(manifest)) continue;
    try {
      const at = Date.parse(
        (JSON.parse(readFileSync(manifest, 'utf8')) as BackupManifest).createdAt,
      );
      if (!Number.isNaN(at) && (!best || at > best.at)) best = { dir: join(root, entry.name), at };
    } catch {
      // An unreadable manifest is not a backup to drill.
    }
  }
  return best?.dir ?? null;
}

/** The same server and credentials, another database. */
export function scratchUrl(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export interface DrillOptions {
  databaseUrl: string;
  /** The backup directory to restore. */
  dir: string;
  /** Keep the scratch database for a look afterwards (the CLI's --keep). */
  keep?: boolean;
  log?: (message: string) => void;
}

export async function restoreDrill(
  db: Kysely<Database>,
  options: DrillOptions,
): Promise<DrillReport> {
  const log = options.log ?? (() => {});
  const started = Date.now();
  const manifest = verifyBackup(options.dir);
  const verified = Date.now();
  log(`checksums verified: ${options.dir} (${manifest.createdAt})`);

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const name = `taskmoor_drill_${stamp}_${process.pid}`;
  try {
    await sql`CREATE DATABASE ${sql.id(name)} TEMPLATE template0`.execute(db);
  } catch (error) {
    throw new Error(
      `cannot create the scratch database ${name} (the database user needs CREATEDB): ${message(error)}`,
    );
  }
  const url = scratchUrl(options.databaseUrl, name);
  let restoredAt = verified;
  try {
    const pgRestore = clientBinary('pg_restore', await serverMajor(db));
    log(`restoring into ${name} with ${pgRestore} (${restoreJobs()} jobs)`);
    const connection = pgConnection(url);
    await run(
      pgRestore,
      [
        '--no-owner',
        '--no-privileges',
        '--exit-on-error',
        `--jobs=${restoreJobs()}`,
        `--dbname=${connection.url}`,
        join(options.dir, 'db.dump'),
      ],
      { env: connection.env, maxBuffer: 16 * 1024 * 1024 },
    );
    restoredAt = Date.now();
    log(`restored in ${seconds(restoredAt - verified)} s; counting rows`);

    const scratch = createDb({
      connectionString: url,
      maxConnections: 1,
      applicationName: 'taskmoor-drill',
    });
    let counts: Record<string, number>;
    let applied: string[];
    try {
      counts = await countRows(scratch);
      applied = (await migrationStatus(scratch)).applied;
    } finally {
      await scratch.destroy();
    }
    const checkedAt = Date.now();
    const expected = manifest.rowCounts;
    const mismatches: DrillReport['mismatches'] = [];
    if (expected) {
      for (const table of new Set([...Object.keys(expected), ...Object.keys(counts)])) {
        const want = expected[table] ?? null;
        const got = counts[table] ?? null;
        if (want !== got) mismatches.push({ table, expected: want, actual: got });
      }
    }
    const migrationsMatch = JSON.stringify(applied) === JSON.stringify(manifest.migrations);
    const report: DrillReport = {
      backup: options.dir,
      createdAt: manifest.createdAt,
      version: manifest.version,
      scratchDatabase: name,
      seconds: {
        verify: seconds(verified - started),
        restore: seconds(restoredAt - verified),
        check: seconds(checkedAt - restoredAt),
        total: seconds(checkedAt - started),
      },
      tables: Object.keys(counts).length,
      rows: Object.values(counts).reduce((n, c) => n + c, 0),
      mismatches,
      countsChecked: expected !== undefined,
      migrationsMatch,
      ok: mismatches.length === 0 && migrationsMatch,
    };
    return report;
  } finally {
    if (!options.keep) {
      await sql`DROP DATABASE IF EXISTS ${sql.id(name)} WITH (FORCE)`.execute(db);
      log(`dropped ${name}`);
    } else {
      log(`kept ${name}; drop it with: DROP DATABASE ${name}`);
    }
  }
}

/** The drill, recorded in the backup log (kind `drill`); a failed check is a failed run. */
export async function recordedDrill(
  db: Kysely<Database>,
  options: DrillOptions,
  jobId?: string,
  startedAt?: Date,
): Promise<DrillReport> {
  const runId = await startRun(db, 'drill', options.dir, startedAt);
  try {
    const report = await withHeartbeat(db, runId, jobId, () => restoreDrill(db, options));
    await finishRun(db, runId, {
      state: report.ok ? 'succeeded' : 'failed',
      details: {
        backup: report.backup,
        createdAt: report.createdAt,
        seconds: report.seconds,
        tables: report.tables,
        rows: report.rows,
        countsChecked: report.countsChecked,
        mismatches: report.mismatches.slice(0, 20),
        migrationsMatch: report.migrationsMatch,
      },
      ...(report.ok
        ? {}
        : {
            error: report.migrationsMatch
              ? `${report.mismatches.length} table(s) restored with other row counts`
              : 'the restored migrations differ from the backup',
          }),
    });
    return report;
  } catch (error) {
    await finishRun(db, runId, { state: 'failed', error: message(error) });
    throw error;
  }
}
