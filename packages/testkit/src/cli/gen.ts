// pnpm gen --items <n> [--seed <n>] [--fields <n>] [--database-url <url>] [--force] [--keep]
//
// Generates a synthetic dataset and loads it into the `gen` schema. Without --database-url it
// uses the embedded "bench" cluster in .cache/pg-test/bench (database "bench"), which keeps the
// data between runs; a dataset with the same fingerprint is not loaded twice unless --force.
import { parseArgs } from 'node:util';
import pg from 'pg';
import {
  createDataset,
  datasetFingerprint,
  loadDataset,
  loadedFingerprint,
  scaleConfig,
} from '../gen';
import { databaseUrl, withAdminClient } from '../pg/databases';
import { startEmbeddedPostgres } from '../pg/server';

const { values } = parseArgs({
  options: {
    items: { type: 'string' },
    seed: { type: 'string' },
    fields: { type: 'string' },
    'database-url': { type: 'string' },
    force: { type: 'boolean', default: false },
  },
});

const items = Number(values.items?.replaceAll('_', ''));
if (!Number.isInteger(items) || items < 1) {
  console.error(
    'Usage: pnpm gen --items <n> [--seed <n>] [--fields <n>] [--database-url <url>] [--force]',
  );
  process.exit(2);
}
const config = scaleConfig(items, {
  ...(values.seed ? { seed: Number(values.seed) } : {}),
  ...(values.fields ? { fields: Number(values.fields) } : {}),
});

/** Settings for loading and benchmarking on one machine; data can always be regenerated. */
export const BENCH_SETTINGS = {
  shared_buffers: '1GB',
  maintenance_work_mem: '1GB',
  work_mem: '64MB',
  max_wal_size: '16GB',
  checkpoint_timeout: '30min',
};

const server = values['database-url']
  ? undefined
  : await startEmbeddedPostgres({ name: 'bench', settings: BENCH_SETTINGS });

try {
  let url = values['database-url'];
  if (!url && server) {
    await withAdminClient(server.adminUrl, async (client) => {
      const { rowCount } = await client.query(`SELECT 1 FROM pg_database WHERE datname = 'bench'`);
      if (!rowCount) await client.query('CREATE DATABASE bench');
    });
    url = databaseUrl(server.adminUrl, 'bench');
  }
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  try {
    const fingerprint = datasetFingerprint(config);
    if (!values.force && (await loadedFingerprint(pool)) === fingerprint) {
      console.log(
        `Dataset ${fingerprint} (${items.toLocaleString('en')} items) is already loaded.`,
      );
    } else {
      console.log(
        `Generating ${items.toLocaleString('en')} items, ${config.users} users, ${config.spaces} spaces, ${config.fields} fields (seed ${config.seed})...`,
      );
      const t0 = Date.now();
      const result = await loadDataset(pool, createDataset(config), {
        progressEvery: Math.max(10_000, Math.round(items / 20)),
        onProgress: (n) => {
          const rate = Math.round(n / ((Date.now() - t0) / 1000));
          console.log(`  ${n.toLocaleString('en')} items (${rate.toLocaleString('en')}/s)`);
        },
      });
      console.log(
        `Loaded and verified in ${result.seconds.toFixed(1)}s: ${result.items.toLocaleString('en')} items, ` +
          `${result.history.toLocaleString('en')} history rows, ${result.users} users, ` +
          `${result.spaces} spaces, ${result.fields} fields. Fingerprint ${fingerprint}.`,
      );
    }
  } finally {
    await pool.end();
  }
} finally {
  await server?.stop();
}
