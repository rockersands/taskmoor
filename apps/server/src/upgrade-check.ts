import { existsSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Database, migrationStatus } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';

export type CheckState = 'ok' | 'warn' | 'block';

export interface UpgradeCheck {
  name: string;
  state: CheckState;
  detail: string;
}

export interface UpgradeCheckOptions {
  /** The data directory (files, backups); disk space is measured there when it exists. */
  dataDir?: string;
  /** A backup older than this is a warning (OPS-006 wants a recent one before upgrading). */
  backupMaxAgeHours?: number;
  now?: Date;
}

const MIN_SERVER_VERSION = 160000;

/**
 * The pre-upgrade check (OPS-006, M0-029): run before starting a newer release. Blocks on a
 * database that is unreachable, too old, or migrated by a newer release; warns when disk or
 * backups look short. The install kits run it as `node cli.mjs check-upgrade`.
 */
export async function checkUpgrade(
  db: Kysely<Database>,
  options: UpgradeCheckOptions = {},
): Promise<UpgradeCheck[]> {
  const checks: UpgradeCheck[] = [];
  const now = options.now ?? new Date();

  let versionNumber = 0;
  try {
    const { rows } = await sql<{ num: string; version: string }>`
      SELECT current_setting('server_version_num') AS num, version() AS version`.execute(db);
    versionNumber = Number(rows[0]?.num ?? 0);
    checks.push({ name: 'database', state: 'ok', detail: rows[0]?.version ?? 'reachable' });
  } catch (error) {
    checks.push({
      name: 'database',
      state: 'block',
      detail: `not reachable: ${error instanceof Error ? error.message : String(error)}`,
    });
    return checks;
  }

  checks.push(
    versionNumber >= MIN_SERVER_VERSION
      ? { name: 'postgres-version', state: 'ok', detail: `${versionNumber} (16 or newer needed)` }
      : {
          name: 'postgres-version',
          state: 'block',
          detail: `${versionNumber} is older than PostgreSQL 16 (ADR-006)`,
        },
  );

  const status = await migrationStatus(db);
  if (status.unknown.length > 0) {
    checks.push({
      name: 'migrations',
      state: 'block',
      detail: `applied by a newer release and unknown here: ${status.unknown.join(', ')} (forward-only, ADR-022: restore a backup or use that release)`,
    });
  } else if (status.pending.length > 0) {
    checks.push({
      name: 'migrations',
      state: 'ok',
      detail: `${status.pending.length} to apply: ${status.pending.join(', ')}`,
    });
  } else {
    checks.push({ name: 'migrations', state: 'ok', detail: 'up to date' });
  }

  if (options.dataDir && existsSync(options.dataDir)) {
    const { rows } = await sql<{ size: string }>`
      SELECT pg_database_size(current_database()) AS size`.execute(db);
    const dbSize = Number(rows[0]?.size ?? 0);
    const stat = statfsSync(options.dataDir);
    const free = Number(stat.bavail) * Number(stat.bsize);
    const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
    checks.push(
      free < dbSize
        ? {
            name: 'disk-space',
            state: 'block',
            detail: `${mb(free)} free, database is ${mb(dbSize)}: a migration that rewrites a table cannot complete`,
          }
        : free < 2 * dbSize
          ? {
              name: 'disk-space',
              state: 'warn',
              detail: `${mb(free)} free for a ${mb(dbSize)} database; keep twice the database size free during upgrades`,
            }
          : { name: 'disk-space', state: 'ok', detail: `${mb(free)} free, database ${mb(dbSize)}` },
    );

    const marker = join(options.dataDir, 'backups', 'last');
    const maxAgeMs = (options.backupMaxAgeHours ?? 24) * 3_600_000;
    if (!existsSync(marker)) {
      checks.push({
        name: 'backup',
        state: 'warn',
        detail: 'no backup recorded (backups/last); take one before upgrading',
      });
    } else {
      const age = now.getTime() - statSync(marker).mtimeMs;
      checks.push(
        age > maxAgeMs
          ? {
              name: 'backup',
              state: 'warn',
              detail: `last backup ${Math.round(age / 3_600_000)} h ago; take a fresh one before upgrading`,
            }
          : {
              name: 'backup',
              state: 'ok',
              detail: `last backup ${Math.round(age / 60_000)} min ago`,
            },
      );
    }
  } else {
    checks.push({
      name: 'disk-space',
      state: 'warn',
      detail: 'no data directory given (TASKMOOR_DATA); disk and backup age not checked',
    });
  }
  return checks;
}

export function formatChecks(checks: readonly UpgradeCheck[]): string {
  const mark = { ok: 'ok   ', warn: 'warn ', block: 'BLOCK' } as const;
  const lines = checks.map((c) => `${mark[c.state]} ${c.name}: ${c.detail}`);
  const blocks = checks.filter((c) => c.state === 'block').length;
  lines.push(
    blocks === 0 ? 'Upgrade can proceed.' : `${blocks} blocking problem(s); do not upgrade yet.`,
  );
  return `${lines.join('\n')}\n`;
}
