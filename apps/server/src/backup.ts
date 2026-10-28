import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpus } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { type Database, migrationStatus } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { mergePepperFile, PEPPER_FILE, pepperFile } from './secrets';

const run = promisify(execFile);

/**
 * pg_dump must be at least as new as the server it reads, and pg_restore must not be newer than
 * the server it loads (a newer one emits settings the older server rejects, such as
 * `transaction_timeout` from 17 on). The image ships the client tools of every supported major
 * under /usr/libexec/postgresql<major> (Alpine's layout) and the tools matching the server are
 * chosen; `TASKMOOR_PG_BIN` names another directory to look in first, and otherwise the tools
 * on PATH are used.
 */
export function clientBinary(
  name: 'pg_dump' | 'pg_restore',
  serverMajor: number,
  env: Record<string, string | undefined> = process.env,
): string {
  const dirs = [env.TASKMOOR_PG_BIN, `/usr/libexec/postgresql${serverMajor}`];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const candidate of [join(dir, name), join(dir, `${name}.exe`)]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return name;
}

/**
 * A database URL as the client tools take it: the password moves to PGPASSWORD, so it never
 * shows in the process list or in an error message that quotes the command line.
 */
export function pgConnection(databaseUrl: string): { url: string; env: NodeJS.ProcessEnv } {
  try {
    const url = new URL(databaseUrl);
    if (!url.password) return { url: databaseUrl, env: process.env };
    const password = decodeURIComponent(url.password);
    url.password = '';
    return { url: url.toString(), env: { ...process.env, PGPASSWORD: password } };
  } catch {
    return { url: databaseUrl, env: process.env };
  }
}

/** Removes passwords from connection URLs in a message (errors, logs, the backup log). */
export function redactSecrets(message: string): string {
  return message.replace(/([a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:)[^@\s]*@/gi, '$1***@');
}

/**
 * Tables whose rows a backup leaves out: the backup log describes the backups on this host,
 * so a restore keeps the live one (see `restore`) instead of rolling it back.
 */
export const NOT_BACKED_UP = ['backup_run'] as const;

export async function serverMajor(db: Kysely<Database>): Promise<number> {
  const { rows } = await sql<{ server_version_num: string }>`SHOW server_version_num`.execute(db);
  return Math.floor(Number(rows[0]?.server_version_num ?? 0) / 10000);
}

/**
 * Backup and restore (OPS-008, OPS-009, M0-030): the database through pg_dump's custom format,
 * the files directory as a copy, the password keyring (secrets.ts), the non-secret
 * configuration as JSON, and a manifest with checksums so a restore can refuse a damaged
 * archive. The keyring makes a backup as sensitive as the live install: keep it protected.
 * Scheduling, retention and the restore drill are in `backups/` (M1-101); encryption, remote
 * targets and single-track restore come later.
 */
export interface BackupManifest {
  version: string;
  createdAt: string;
  migrations: string[];
  /** sha256 per archive entry, keyed by relative path. */
  checksums: Record<string, string>;
  /**
   * Rows per table in the very snapshot the dump holds (since M1-101), so a restore drill can
   * prove every row came back. Older backups have none.
   */
  rowCounts?: Record<string, number>;
}

export interface BackupOptions {
  databaseUrl: string;
  /** The instance's data directory; its `files` subfolder is included when present. */
  dataDir?: string;
  version: string;
  /** Non-secret settings worth keeping next to the data (PUBLIC_URL, roles). */
  config?: Record<string, string>;
  log?: (message: string) => void;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, base));
    else out.push(relative(base, path).replaceAll('\\', '/'));
  }
  return out.sort();
}

export async function backup(
  db: Kysely<Database>,
  out: string,
  options: BackupOptions,
): Promise<BackupManifest> {
  const log = options.log ?? (() => {});
  mkdirSync(out, { recursive: true });
  const pgDump = clientBinary('pg_dump', await serverMajor(db));
  log(`dumping the database to ${join(out, 'db.dump')} with ${pgDump}`);
  // The row counts and the dump read one snapshot: pg_dump joins the one this transaction
  // exports, which stays open until the dump is done.
  const rowCounts = await db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const { rows } = await sql<{ snapshot: string }>`
        SELECT pg_export_snapshot() AS snapshot`.execute(trx);
      const counts = await countRows(trx);
      const connection = pgConnection(options.databaseUrl);
      await run(
        pgDump,
        [
          '--format=custom',
          '--no-owner',
          '--no-privileges',
          `--snapshot=${rows[0]?.snapshot}`,
          ...NOT_BACKED_UP.map((t) => `--exclude-table-data=${t}`),
          `--file=${join(out, 'db.dump')}`,
          connection.url,
        ],
        { env: connection.env },
      );
      return counts;
    });
  const files = options.dataDir ? join(options.dataDir, 'files') : undefined;
  if (files && existsSync(files)) {
    log('copying files');
    cpSync(files, join(out, 'files'), { recursive: true });
  }
  const keyring = options.dataDir ? pepperFile(options.dataDir) : undefined;
  if (keyring && existsSync(keyring)) {
    log('copying the password keyring');
    mkdirSync(join(out, 'secrets'), { recursive: true });
    copyFileSync(keyring, join(out, PEPPER_FILE));
    // Same permissions as the dump next to it: whoever restores (often another user, after a
    // copy between hosts) must read the whole directory, which is protected as one unit.
    chmodSync(join(out, PEPPER_FILE), 0o644);
  }
  writeFileSync(join(out, 'config.json'), `${JSON.stringify(options.config ?? {}, null, 2)}\n`);
  const checksums: Record<string, string> = {};
  for (const entry of walk(out)) {
    if (entry === 'manifest.json') continue;
    checksums[entry] = sha256File(join(out, entry));
  }
  const manifest: BackupManifest = {
    version: options.version,
    createdAt: new Date().toISOString(),
    migrations: (await migrationStatus(db)).applied,
    checksums,
    rowCounts,
  };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (options.dataDir) {
    mkdirSync(join(options.dataDir, 'backups'), { recursive: true });
    writeFileSync(join(options.dataDir, 'backups', 'last'), `${out}\n`);
  }
  log(`backup complete: ${Object.keys(checksums).length} entries`);
  return manifest;
}

/** Every checksum in the manifest must match, or the archive is not restored. */
export function verifyBackup(dir: string): BackupManifest {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) throw new Error(`${dir} has no manifest.json`);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as BackupManifest;
  const bad = Object.entries(manifest.checksums).filter(
    ([entry, sum]) => !existsSync(join(dir, entry)) || sha256File(join(dir, entry)) !== sum,
  );
  if (bad.length > 0) {
    throw new Error(`backup is damaged, checksums differ: ${bad.map(([e]) => e).join(', ')}`);
  }
  return manifest;
}

/** Parallel restore workers: pg_restore loads tables and builds indexes side by side. */
export function restoreJobs(): number {
  return Math.max(1, Math.min(4, cpus().length));
}

/**
 * Rows per table of the public schema that a backup holds (partitioned tables counted whole,
 * the tables of NOT_BACKED_UP left out).
 */
export async function countRows(
  db: Kysely<Database> | Transaction<Database>,
): Promise<Record<string, number>> {
  const { rows } = await sql<{ name: string }>`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND NOT (c.relname = ANY(${[...NOT_BACKED_UP]}::text[]))
     ORDER BY c.relname`.execute(db);
  const out: Record<string, number> = {};
  for (const { name } of rows) {
    const { rows: n } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM ${sql.table(name)}`.execute(db);
    out[name] = Number(n[0]?.n ?? 0);
  }
  return out;
}

export async function restore(
  db: Kysely<Database>,
  dir: string,
  options: { databaseUrl: string; dataDir?: string; log?: (message: string) => void },
): Promise<BackupManifest> {
  const log = options.log ?? (() => {});
  const manifest = verifyBackup(dir);
  // Read the keyring before anything changes: an unreadable one stops the restore here.
  const keyring = join(dir, PEPPER_FILE);
  const keyringSecrets = existsSync(keyring)
    ? readFileSync(keyring, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    : [];
  const pgRestore = clientBinary('pg_restore', await serverMajor(db));
  log(
    `restoring the database from ${join(dir, 'db.dump')} (${manifest.createdAt}) with ${pgRestore}`,
  );
  // The live backup log stays: it describes the backups on this host, which the restore does
  // not bring back or remove.
  const backupLog = await readBackupLog(db);
  // pg_restore --clean drops each partition's constraints before the parent's, which Postgres
  // refuses ("cannot drop inherited constraint"). Partitioned tables go first, with their
  // partitions; the restore's own drops for them then find nothing (--if-exists).
  await dropPartitionedTables(db);
  const connection = pgConnection(options.databaseUrl);
  await run(
    pgRestore,
    [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      `--jobs=${restoreJobs()}`,
      `--dbname=${connection.url}`,
      join(dir, 'db.dump'),
    ],
    { env: connection.env },
  );
  if (backupLog) await writeBackupLog(db, backupLog);
  const files = join(dir, 'files');
  if (options.dataDir && existsSync(files)) {
    log('restoring files');
    cpSync(files, join(options.dataDir, 'files'), { recursive: true });
  }
  // Merge, never replace: this install's own key stays active, the backup's keys verify the
  // restored passwords until sign-in moves them over.
  if (options.dataDir && keyringSecrets.length > 0) {
    const added = mergePepperFile(pepperFile(options.dataDir), keyringSecrets);
    log(`password keyring: ${added} key(s) added`);
  }
  log('restore complete');
  return manifest;
}

type BackupLogRow = Record<string, unknown>;

/** The backup log's rows, or null when the table does not exist (a database before M1-101). */
async function readBackupLog(db: Kysely<Database>): Promise<BackupLogRow[] | null> {
  const { rows } = await sql<{ ok: boolean }>`
    SELECT to_regclass('public.backup_run') IS NOT NULL AS ok`.execute(db);
  if (!rows[0]?.ok) return null;
  const { rows: log } = await sql<BackupLogRow>`SELECT * FROM backup_run ORDER BY id`.execute(db);
  return log;
}

/** Puts the live backup log back after a restore (when the restored schema has the table). */
async function writeBackupLog(db: Kysely<Database>, log: BackupLogRow[]): Promise<void> {
  const { rows } = await sql<{ ok: boolean }>`
    SELECT to_regclass('public.backup_run') IS NOT NULL AS ok`.execute(db);
  if (!rows[0]?.ok) return;
  await db.transaction().execute(async (trx) => {
    await sql`DELETE FROM backup_run`.execute(trx);
    if (log.length > 0) {
      await sql`
        INSERT INTO backup_run
        SELECT * FROM jsonb_populate_recordset(NULL::backup_run, ${JSON.stringify(log)}::jsonb)`.execute(
        trx,
      );
    }
    await sql`
      SELECT setval(pg_get_serial_sequence('backup_run', 'id'),
                    greatest((SELECT max(id) FROM backup_run), 1))`.execute(trx);
  });
}

/** Drops every top-level partitioned table outside the system schemas, partitions included. */
async function dropPartitionedTables(db: Kysely<Database>): Promise<void> {
  const { rows } = await sql<{ name: string }>`
    SELECT format('%I.%I', n.nspname, c.relname) AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'p' AND NOT c.relispartition
       AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`.execute(db);
  for (const { name } of rows) {
    await sql`DROP TABLE IF EXISTS ${sql.raw(name)} CASCADE`.execute(db);
  }
}

/**
 * One checksum per table over its rows in a stable order, for restore drills: equal before
 * and after means nothing was lost or changed.
 */
export async function tableChecksums(db: Kysely<Database>): Promise<Record<string, string>> {
  const { rows } = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name NOT IN ('schema_migration_lock')
       AND NOT (table_name = ANY(${[...NOT_BACKED_UP]}::text[]))
     ORDER BY table_name`.execute(db);
  const out: Record<string, string> = {};
  for (const { table_name } of rows) {
    const { rows: sums } = await sql<{ n: string; sum: string | null }>`
      SELECT count(*) AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS sum
        FROM ${sql.table(table_name)} t`.execute(db);
    out[table_name] = `${sums[0]?.n ?? 0}:${sums[0]?.sum ?? 'empty'}`;
  }
  return out;
}

/**
 * Waits until every event is published and no ready job is left (at most a minute), so a
 * checksum taken afterwards does not change under the worker's feet.
 */
export async function waitForIdleQueue(db: Kysely<Database>, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await sql<{ busy: string }>`
      SELECT (SELECT count(*) FROM domain_event WHERE published_at IS NULL)
           + (SELECT count(*) FROM job WHERE done_at IS NULL AND run_at <= now()) AS busy`.execute(
      db,
    );
    if (Number(rows[0]?.busy ?? 0) === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Sizes, for the backup listing. */
export function backupSize(dir: string): number {
  return walk(dir).reduce((n, entry) => n + statSync(join(dir, entry)).size, 0);
}
