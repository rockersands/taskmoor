import { existsSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Database,
  knownMigrations,
  type MigrationSet,
  type MigrationStatus,
  migrationStatus,
  type Release,
  upgradePath,
} from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import { redactSecrets } from './backup';

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
  /** Published releases, for the upgrade path rule (tests model earlier ones). */
  releases?: readonly Release[];
  /** Another migration set than this build's (tests). */
  migrations?: MigrationSet;
}

const MIN_SERVER_VERSION = 160000;

/** Reachability and server version; a single blocking `database` check when unreachable. */
export async function serverChecks(db: Kysely<Database>): Promise<UpgradeCheck[]> {
  let versionNumber = 0;
  const checks: UpgradeCheck[] = [];
  try {
    const { rows } = await sql<{ num: string; version: string }>`
      SELECT current_setting('server_version_num') AS num, version() AS version`.execute(db);
    versionNumber = Number(rows[0]?.num ?? 0);
    checks.push({ name: 'database', state: 'ok', detail: rows[0]?.version ?? 'reachable' });
  } catch (error) {
    return [
      {
        name: 'database',
        state: 'block',
        detail: `not reachable: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      },
    ];
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
  return checks;
}

/**
 * What the migrations say about an upgrade to this build: unknown migrations (a newer release
 * migrated the database), migrations that would run out of order, and the upgrade path rule
 * (ADR-022: the last three releases in one step, `releases.ts`).
 */
export function migrationChecks(
  status: MigrationStatus,
  options: { latest: string | null; releases?: readonly Release[] },
): UpgradeCheck[] {
  const checks: UpgradeCheck[] = [];
  const lastApplied = status.applied[status.applied.length - 1] ?? null;
  if (status.unknown.length > 0) {
    checks.push({
      name: 'migrations',
      state: 'block',
      detail: `applied by a newer release and unknown here: ${status.unknown.join(', ')} (forward-only, ADR-022: restore a backup or use that release)`,
    });
    return checks;
  }
  if (status.outOfOrder.length > 0) {
    checks.push({
      name: 'migrations',
      state: 'block',
      detail: `${status.outOfOrder.join(', ')} would run after ${lastApplied}, which is applied already; migrations run in name order, so this build cannot upgrade this database (a release must never ship such a migration, ADR-022)`,
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
  if (lastApplied === null || options.latest === null) {
    checks.push({
      name: 'upgrade-path',
      state: 'ok',
      detail: 'empty database: this is an install',
    });
    return checks;
  }
  const path = upgradePath(lastApplied, options.latest, options.releases);
  const at = path.from ? `release ${path.from.version} (${lastApplied})` : lastApplied;
  if (path.supported) {
    checks.push({
      name: 'upgrade-path',
      state: 'ok',
      detail: `from ${at}; ${path.floor ? `supported from ${path.floor.version} on` : 'every earlier release is supported'}`,
    });
  } else {
    const floor = path.floor as Release;
    checks.push({
      name: 'upgrade-path',
      state: 'block',
      detail: `the database is at ${at}; this release upgrades from ${floor.version} (${floor.lastMigration}) or later in one step: upgrade to ${floor.version} first (ADR-022)`,
    });
  }
  return checks;
}

/**
 * The pre-upgrade check (OPS-006, M0-029): run before starting a newer release. Blocks on a
 * database that is unreachable, too old, migrated by a newer release, out of order or too
 * many releases back; warns when disk or backups look short. The Helm chart runs it as a
 * pre-upgrade hook (`node cli.mjs check-upgrade`); the upgrade command runs the same checks
 * and more before it changes anything (`upgrade.ts`).
 */
export async function checkUpgrade(
  db: Kysely<Database>,
  options: UpgradeCheckOptions = {},
): Promise<UpgradeCheck[]> {
  const now = options.now ?? new Date();
  const checks = await serverChecks(db);
  if (checks.some((c) => c.name === 'database' && c.state === 'block')) return checks;

  const known = knownMigrations(options.migrations);
  const status = await migrationStatus(db, options.migrations);
  checks.push(
    ...migrationChecks(status, {
      latest: known[known.length - 1] ?? null,
      ...(options.releases ? { releases: options.releases } : {}),
    }),
  );

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
