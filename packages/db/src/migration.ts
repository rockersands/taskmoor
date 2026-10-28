import type { Migration } from 'kysely';

/**
 * A migration as Taskmoor writes them: Kysely's `up` (forward-only, no `down`), plus `online`
 * for the rare one that cannot run inside a transaction, such as an index built
 * `CONCURRENTLY` on a large table (ADR-022). Declare it with `export const online = true;`.
 */
export interface TaskmoorMigration extends Migration {
  online?: boolean;
}

/** Migrations by name; they run in name order. */
export type MigrationSet = Readonly<Record<string, TaskmoorMigration>>;
