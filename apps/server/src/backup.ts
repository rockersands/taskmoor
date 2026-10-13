import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { type Database, migrationStatus } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
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

export async function serverMajor(db: Kysely<Database>): Promise<number> {
  const { rows } = await sql<{ server_version_num: string }>`SHOW server_version_num`.execute(db);
  return Math.floor(Number(rows[0]?.server_version_num ?? 0) / 10000);
}

/**
 * Backup and restore (OPS-008, OPS-009, M0-030): the database through pg_dump's custom format,
 * the files directory as a copy, the password keyring (secrets.ts), the non-secret
 * configuration as JSON, and a manifest with checksums so a restore can refuse a damaged
 * archive. The keyring makes a backup as sensitive as the live install: keep it protected. Scheduling, encryption, remote targets
 * and single-track restore come in M1.
 */
export interface BackupManifest {
  version: string;
  createdAt: string;
  migrations: string[];
  /** sha256 per archive entry, keyed by relative path. */
  checksums: Record<string, string>;
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
  await run(pgDump, [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    `--file=${join(out, 'db.dump')}`,
    options.databaseUrl,
  ]);
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

export async function restore(
  db: Kysely<Database>,
  dir: string,
  options: { databaseUrl: string; dataDir?: string; log?: (message: string) => void },
): Promise<BackupManifest> {
  const log = options.log ?? (() => {});
  const manifest = verifyBackup(dir);
  const pgRestore = clientBinary('pg_restore', await serverMajor(db));
  log(
    `restoring the database from ${join(dir, 'db.dump')} (${manifest.createdAt}) with ${pgRestore}`,
  );
  await run(pgRestore, [
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    '--exit-on-error',
    `--dbname=${options.databaseUrl}`,
    join(dir, 'db.dump'),
  ]);
  const files = join(dir, 'files');
  if (options.dataDir && existsSync(files)) {
    log('restoring files');
    cpSync(files, join(options.dataDir, 'files'), { recursive: true });
  }
  // Merge, never replace: this install's own key stays active, the backup's keys verify the
  // restored passwords until sign-in moves them over.
  const keyring = join(dir, PEPPER_FILE);
  if (options.dataDir && existsSync(keyring)) {
    const secrets = readFileSync(keyring, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    const added = mergePepperFile(pepperFile(options.dataDir), secrets);
    log(`password keyring: ${added} key(s) added`);
  }
  log('restore complete');
  return manifest;
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

/** Sizes, for the backup listing. */
export function backupSize(dir: string): number {
  return walk(dir).reduce((n, entry) => n + statSync(join(dir, entry)).size, 0);
}
