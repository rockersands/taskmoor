import { createHash } from 'node:crypto';
import { type Kysely, type MigrationResult, Migrator, sql } from 'kysely';
import type { MigrationSet, TaskmoorMigration } from './migration';
import { migrations as shipped } from './migrations';

export type { MigrationSet, TaskmoorMigration } from './migration';

export const MIGRATION_TABLE = 'schema_migration';
export const MIGRATION_LOCK_TABLE = 'schema_migration_lock';

/**
 * One migration run at a time per database, across all of its transactions (a session-level
 * advisory lock; Kysely's own lock lasts one transaction only).
 */
const MIGRATE_LOCK = 'taskmoor:migrate';

export interface MigrateOptions {
  /**
   * Another migration set than the one this build ships: the upgrade harness models earlier
   * releases with it, and tests inject failing migrations (nothing of the kind ships).
   */
  migrations?: MigrationSet;
  /**
   * Runs inside the last transaction after its migrations and before the commit (the upgrade
   * verifies the schema there); throwing rolls that transaction back.
   */
  beforeCommit?: (db: Kysely<unknown>) => Promise<void>;
  /** Called after each migration's `up` with its duration in milliseconds. */
  onApplied?: (name: string, ms: number) => void;
}

/**
 * Pending migrations in the order they run: consecutive ordinary migrations share one
 * transaction; an online migration runs alone, outside any transaction.
 */
export interface Segment {
  online: boolean;
  names: string[];
}

/**
 * A migration run that failed. `committed` names the migrations that stay applied (earlier
 * segments); `partial` is true when the failing migration ran outside a transaction, so some
 * of its statements may have stuck. With neither, the database is exactly as before the run.
 */
export class MigrationError extends Error {
  readonly migration: string | null;
  readonly committed: readonly string[];
  readonly partial: boolean;
  constructor(
    message: string,
    details: { migration: string | null; committed: readonly string[]; partial: boolean },
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'MigrationError';
    this.migration = details.migration;
    this.committed = details.committed;
    this.partial = details.partial;
  }
}

function migrator(db: Kysely<unknown>, set: MigrationSet): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => set },
    migrationTableName: MIGRATION_TABLE,
    migrationLockTableName: MIGRATION_LOCK_TABLE,
    // runPending opens and closes the transactions itself.
    disableTransactions: true,
  });
}

function failedName(results: readonly MigrationResult[]): string | null {
  return results.find((r) => r.status === 'Error')?.migrationName ?? null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The set with each `up` timed. */
function timed(set: MigrationSet, onApplied?: (name: string, ms: number) => void): MigrationSet {
  if (!onApplied) return set;
  const out: Record<string, TaskmoorMigration> = {};
  for (const [name, migration] of Object.entries(set)) {
    out[name] = {
      ...migration,
      up: async (db) => {
        const started = performance.now();
        await migration.up(db);
        onApplied(name, performance.now() - started);
      },
    };
  }
  return out;
}

/** Splits pending migrations into the segments they run in (see `Segment`). */
export function segmentPlan(pending: readonly string[], set: MigrationSet = shipped): Segment[] {
  const segments: Segment[] = [];
  for (const name of pending) {
    const online = set[name]?.online === true;
    const last = segments[segments.length - 1];
    if (!online && last && !last.online) last.names.push(name);
    else segments.push({ online, names: [name] });
  }
  return segments;
}

/**
 * Applies pending migrations (all, or up to and including `target`) on one connection that
 * holds the migration lock throughout:
 *
 * - **Ordinary migrations run together in one transaction** (a segment), with their
 *   bookkeeping rows and `beforeCommit`. A failure rolls the whole segment back, so an upgrade
 *   across several releases lands either on the new schema or exactly where it started, never
 *   in between. PostgreSQL's DDL is transactional; only sequence values taken by a rolled-back
 *   insert stay taken.
 * - **Online migrations run alone without a transaction**, each statement committing on its
 *   own. They split the plan into segments; a failure after a committed segment, or inside an
 *   online migration, leaves the database changed, and the upgrade command restores its
 *   pre-upgrade backup (ADR-022).
 */
async function runPending<DB>(
  db: Kysely<DB>,
  target: string | null,
  options: MigrateOptions,
): Promise<string[]> {
  const set = options.migrations ?? shipped;
  if (target !== null && !(target in set)) throw new Error(`Unknown migration ${target}`);
  return db.connection().execute(async (conn) => {
    const pinned = conn as unknown as Kysely<unknown>;
    await sql`SELECT pg_advisory_lock(hashtext(${MIGRATE_LOCK}))`.execute(pinned);
    try {
      const status = await migrationStatus(pinned, set);
      const pending = status.pending.filter((name) => target === null || name <= target);
      const segments = segmentPlan(pending, set);
      const run = timed(set, options.onApplied);
      const committed: string[] = [];
      for (const [index, segment] of segments.entries()) {
        const last = segment.names[segment.names.length - 1] as string;
        if (segment.online) {
          const { error, results = [] } = await migrator(pinned, run).migrateTo(last);
          if (error) {
            const migration = failedName(results) ?? last;
            throw new MigrationError(
              `Migration ${migration} failed: ${messageOf(error)}`,
              { migration, committed: [...committed], partial: true },
              error,
            );
          }
        } else {
          await sql`BEGIN`.execute(pinned);
          try {
            const { error, results = [] } = await migrator(pinned, run).migrateTo(last);
            if (error) {
              const migration = failedName(results);
              throw new MigrationError(
                `Migration ${migration ?? '(none)'} failed: ${messageOf(error)}`,
                { migration, committed: [...committed], partial: false },
                error,
              );
            }
            if (index === segments.length - 1 && options.beforeCommit) {
              await options.beforeCommit(pinned);
            }
            await sql`COMMIT`.execute(pinned);
          } catch (error) {
            await sql`ROLLBACK`.execute(pinned).catch(() => {});
            if (error instanceof MigrationError) throw error;
            throw new MigrationError(
              `Migrations ${segment.names[0]} to ${last} were rolled back: ${messageOf(error)}`,
              { migration: null, committed: [...committed], partial: false },
              error,
            );
          }
        }
        committed.push(...segment.names);
      }
      return committed;
    } finally {
      // A connection that died took its session lock with it.
      await sql`SELECT pg_advisory_unlock(hashtext(${MIGRATE_LOCK}))`
        .execute(pinned)
        .catch(() => {});
    }
  });
}

/** Applies every pending migration and returns the names it applied, in order. */
export async function migrateToLatest<DB>(
  db: Kysely<DB>,
  options: MigrateOptions = {},
): Promise<string[]> {
  return runPending(db, null, options);
}

/** Applies migrations up to and including `name`; the upgrade harness starts releases here. */
export async function migrateTo<DB>(
  db: Kysely<DB>,
  name: string,
  options: MigrateOptions = {},
): Promise<string[]> {
  return runPending(db, name, options);
}

/** Every migration name a set (by default this build's) holds, in the order they run. */
export function knownMigrations(set: MigrationSet = shipped): string[] {
  return Object.keys(set).sort();
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
  /** Applied by a newer release and unknown here. */
  unknown: string[];
  /**
   * Pending migrations that sort before one already applied: the runner refuses to apply them
   * out of order, so an upgrade check treats them as a blocker.
   */
  outOfOrder: string[];
}

/**
 * What the database has against what the code ships: pending ones run on the next start;
 * unknown ones mean the database was migrated by a newer release, which forward-only
 * migrations cannot take back (ADR-022), so an upgrade check treats them as a blocker.
 */
export async function migrationStatus<DB>(
  db: Kysely<DB>,
  set: MigrationSet = shipped,
): Promise<MigrationStatus> {
  const exists = await sql<{ ok: boolean }>`
    SELECT to_regclass(${MIGRATION_TABLE}) IS NOT NULL AS ok`.execute(db);
  const known = knownMigrations(set);
  if (!exists.rows[0]?.ok) return { applied: [], pending: known, unknown: [], outOfOrder: [] };
  const rows = await sql<{ name: string }>`
    SELECT name FROM ${sql.table(MIGRATION_TABLE)} ORDER BY name`.execute(db);
  const applied = rows.rows.map((r) => r.name);
  const pending = known.filter((n) => !applied.includes(n));
  const lastApplied = applied[applied.length - 1];
  return {
    applied,
    pending,
    unknown: applied.filter((n) => !known.includes(n)),
    outOfOrder: lastApplied ? pending.filter((n) => n < lastApplied) : [],
  };
}

/**
 * Hash of the migration names and code. Test templates are keyed by it, so changing any
 * migration rebuilds the migrated template on the next run.
 */
export function migrationsFingerprint(): string {
  const hash = createHash('sha256');
  for (const [name, migration] of Object.entries(shipped)) {
    hash.update(name);
    hash.update(migration.up.toString());
  }
  return hash.digest('hex');
}
