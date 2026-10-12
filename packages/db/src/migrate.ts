import { createHash } from 'node:crypto';
import { type Kysely, type MigrationResult, Migrator } from 'kysely';
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

/** Applies every pending migration and returns the names it applied, in order. */
export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<string[]> {
  const { error, results = [] } = await migrator(db).migrateToLatest();
  if (error) {
    const failed = results.find((r: MigrationResult) => r.status === 'Error');
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Migration ${failed?.migrationName ?? '(unknown)'} failed: ${detail}`, {
      cause: error,
    });
  }
  return results.filter((r) => r.status === 'Success').map((r) => r.migrationName);
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
