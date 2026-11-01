import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';

/**
 * How vectors are searched (M1-078; ADR-106). The tables keep plain `real[]` unit vectors
 * whatever the database offers; where the pgvector extension can be installed, the server adds
 * an HNSW index over `embedding::vector(n)` at start, outside the migrations, so one schema
 * serves both. Without pgvector (the embedded Postgres of tests, a managed server that refuses
 * the extension, the all-in-one image), lookups scan the permitted vectors exactly.
 *
 * - `pgvector`: the extension is installed; lookups order by its cosine distance, through the
 *   HNSW index where the planner takes it, exactly otherwise.
 * - `exact`: no extension; the server reads the permitted vectors a page at a time and keeps
 *   the best (`similar.ts`).
 */
export type VectorSearch = 'pgvector' | 'exact';

type Db = Kysely<Database> | Transaction<Database>;

export interface VectorStatus {
  search: VectorSearch;
  /** The installed pgvector's version, when there is one. */
  version: string | null;
  /** Why lookups scan exactly, for the start-up log. */
  reason?: string;
}

/** The extension's version, or null when it is not installed in this database. */
export async function pgvectorVersion(db: Db): Promise<string | null> {
  const { rows } = await sql<{ extversion: string }>`
    SELECT extversion FROM pg_extension WHERE extname = 'vector'`.execute(db);
  return rows[0]?.extversion ?? null;
}

/** Whether pgvector's version is at least `major.minor`. */
export function versionAtLeast(version: string | null, major: number, minor: number): boolean {
  if (!version) return false;
  const [a = 0, b = 0] = version.split('.').map(Number);
  return a > major || (a === major && b >= minor);
}

/** The HNSW index of one table for vectors of `dimensions`. */
export const indexName = (table: 'ticket_embedding' | 'comment_embedding', dimensions: number) =>
  `${table}_hnsw_${dimensions}`;

/**
 * Installs pgvector when the server offers it and the role may, and gives both tables an HNSW
 * index for vectors of `dimensions` (partial: rows of another length, from a model used before,
 * stay out of it). Idempotent and safe to run from several processes at once. Never throws for
 * a missing or refused extension: it answers `exact` with the reason.
 */
export async function ensureVectorIndex(
  db: Kysely<Database>,
  dimensions: number,
): Promise<VectorStatus> {
  const { rows } = await sql<{ name: string }>`
    SELECT name FROM pg_available_extensions WHERE name = 'vector'`.execute(db);
  if (rows.length === 0) {
    return {
      search: 'exact',
      version: null,
      reason: 'the database server has no pgvector extension',
    };
  }
  try {
    await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('taskmoor_vector_index'))`.execute(trx);
      await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(trx);
      if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 2000) return;
      for (const table of ['ticket_embedding', 'comment_embedding'] as const) {
        await sql`
          CREATE INDEX IF NOT EXISTS ${sql.raw(indexName(table, dimensions))} ON ${sql.table(table)}
            USING hnsw ((embedding::vector(${sql.raw(String(dimensions))})) vector_cosine_ops)
            WHERE cardinality(embedding) = ${sql.raw(String(dimensions))}`.execute(trx);
      }
    });
  } catch (error) {
    const version = await pgvectorVersion(db).catch(() => null);
    return {
      search: version ? 'pgvector' : 'exact',
      version,
      reason: `pgvector could not be set up: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { search: 'pgvector', version: await pgvectorVersion(db) };
}

/** How this database searches now, without changing anything. */
export async function vectorStatus(db: Db): Promise<VectorStatus> {
  const version = await pgvectorVersion(db);
  return version
    ? { search: 'pgvector', version }
    : { search: 'exact', version: null, reason: 'pgvector is not installed in this database' };
}
