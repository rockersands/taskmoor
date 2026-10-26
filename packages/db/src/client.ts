import { Kysely, type LogEvent, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema';

/** One finished statement, for metrics and traces (ADR-023). Parameters are never included. */
export interface QueryEvent {
  sql: string;
  durationMs: number;
  /** Set when the statement failed. */
  error?: unknown;
}

export interface DbOptions {
  connectionString: string;
  /** Maximum pooled connections. */
  maxConnections?: number;
  /** Shown in pg_stat_activity, which helps when several roles share one database. */
  applicationName?: string;
  /** Called after every statement, in the caller's async context, so a trace can parent it. */
  onQuery?: (event: QueryEvent) => void;
}

export interface PoolStats {
  total: number;
  idle: number;
  /** Callers queued for a connection. */
  waiting: number;
  max: number;
}

const pools = new WeakMap<Kysely<Database>, pg.Pool>();

// A date column (a ticket's start and due dates) reads as its `YYYY-MM-DD` text. The driver's
// default makes a Date at local midnight, which shifts the day in every time zone west of UTC.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

/** Creates a pooled Kysely client. Call `db.destroy()` to close the pool. */
export function createDb(options: DbOptions): Kysely<Database> {
  const max = options.maxConnections ?? 10;
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max,
    application_name: options.applicationName ?? 'taskmoor',
  });
  const onQuery = options.onQuery;
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    ...(onQuery
      ? {
          log: (event: LogEvent) => {
            onQuery({
              sql: event.query.sql,
              durationMs: event.queryDurationMillis,
              ...(event.level === 'error' ? { error: event.error } : {}),
            });
          },
        }
      : {}),
  });
  pools.set(db, pool);
  return db;
}

/** Connection counts of a client made by `createDb`, or undefined for any other client. */
export function poolStats(db: Kysely<Database>): PoolStats | undefined {
  const pool = pools.get(db);
  if (!pool) return undefined;
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: pool.options.max ?? 10,
  };
}
