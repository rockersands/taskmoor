import { createHash } from 'node:crypto';
import { type Kysely, type MigrationResult, Migrator, sql } from 'kysely';
import { migrations } from './migrations';

export const MIGRATION_TABLE = 'schema_migration';
export const MIGRATION_LOCK_TABLE = 'schema_migration_lock';

function migrator<DB>(db: Kysely<DB>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
    migrationTableName: MIGRATION_TABLE,
    migrationLockTableName: MIGRATION_LOCK_TABLE,
  });
}

function failure(error: unknown, results: readonly MigrationResult[]): Error {
  const failed = results.find((r) => r.status === 'Error');
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Migration ${failed?.migrationName ?? '(unknown)'} failed: ${detail}`, {
    cause: error,
  });
}

/** Applies every pending migration and returns the names it applied, in order. */
export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<string[]> {
  const { error, results = [] } = await migrator(db).migrateToLatest();
  if (error) throw failure(error, results);
  return results.filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

/** Applies migrations up to and including `name`; the upgrade harness starts releases here. */
export async function migrateTo<DB>(db: Kysely<DB>, name: string): Promise<string[]> {
  if (!(name in migrations)) throw new Error(`Unknown migration ${name}`);
  const { error, results = [] } = await migrator(db).migrateTo(name);
  if (error) throw failure(error, results);
  return results.filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

/** Every migration name this build knows, in order. */
export function knownMigrations(): string[] {
  return Object.keys(migrations);
}

/**
 * What the database has against what the code ships: pending ones run on the next start;
 * unknown ones mean the database was migrated by a newer release, which forward-only
 * migrations cannot take back (ADR-022), so an upgrade check treats them as a blocker.
 */
export async function migrationStatus<DB>(
  db: Kysely<DB>,
): Promise<{ applied: string[]; pending: string[]; unknown: string[] }> {
  const exists = await sql<{ ok: boolean }>`
    SELECT to_regclass(${MIGRATION_TABLE}) IS NOT NULL AS ok`.execute(db);
  const known = knownMigrations();
  if (!exists.rows[0]?.ok) return { applied: [], pending: known, unknown: [] };
  const rows = await sql<{ name: string }>`
    SELECT name FROM ${sql.table(MIGRATION_TABLE)} ORDER BY name`.execute(db);
  const applied = rows.rows.map((r) => r.name);
  return {
    applied,
    pending: known.filter((n) => !applied.includes(n)),
    unknown: applied.filter((n) => !known.includes(n)),
  };
}

/**
 * Hash of the migration names and code. Test templates are keyed by it, so changing any
 * migration rebuilds the migrated template on the next run.
 */
export function migrationsFingerprint(): string {
  const hash = createHash('sha256');
  for (const [name, migration] of Object.entries(migrations)) {
    hash.update(name);
    hash.update(migration.up.toString());
  }
  return hash.digest('hex');
}
