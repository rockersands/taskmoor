import pg from 'pg';
import { sizeLabel } from '../gen/model';
import { databaseUrl, withAdminClient } from './databases';
import { type PgServer, startEmbeddedPostgres } from './server';

export { startEmbeddedPostgres } from './server';

/** Settings for loading and benchmarking on one machine; the data can always be regenerated. */
export const BENCH_SETTINGS = {
  shared_buffers: '1GB',
  maintenance_work_mem: '1GB',
  work_mem: '64MB',
  max_wal_size: '16GB',
  checkpoint_timeout: '30min',
  max_parallel_workers_per_gather: 0,
};

export interface BenchDatabase {
  server: PgServer;
  name: string;
  url: string;
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Name of the bench database that holds a dataset of `items` items. */
export function benchDatabaseName(items: number): string {
  return `bench_${sizeLabel(items)}`;
}

/**
 * Starts the persistent embedded "bench" cluster (.cache/pg-test/bench) and opens a pool on the
 * named database, creating it on first use. While another process (a long load, say) owns the
 * cluster, this one connects to the same running server, so the datasets are shared.
 */
export async function openBenchDatabase(
  name: string,
  options: { maxConnections?: number } = {},
): Promise<BenchDatabase> {
  const server = await startEmbeddedPostgres({
    name: 'bench',
    settings: BENCH_SETTINGS,
    shared: true,
  });
  try {
    await withAdminClient(server.adminUrl, async (client) => {
      const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        name,
      ]);
      if (!rowCount) await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
    });
  } catch (error) {
    await server.stop();
    throw error;
  }
  const url = databaseUrl(server.adminUrl, name);
  const pool = new pg.Pool({ connectionString: url, max: options.maxConnections ?? 4 });
  return {
    server,
    name,
    url,
    pool,
    close: async () => {
      await pool.end();
      await server.stop();
    },
  };
}
