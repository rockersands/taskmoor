import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema';

export interface DbOptions {
  connectionString: string;
  /** Maximum pooled connections. */
  maxConnections?: number;
  /** Shown in pg_stat_activity, which helps when several roles share one database. */
  applicationName?: string;
}

/** Creates a pooled Kysely client. Call `db.destroy()` to close the pool. */
export function createDb(options: DbOptions): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? 'tracksmith',
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
