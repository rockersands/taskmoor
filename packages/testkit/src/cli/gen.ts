// pnpm gen --items <n> [--seed <n>] [--fields <n>] [--fields-per-item <n>] [--database <name>]
//          [--database-url <url>] [--force]
//
// Generates a synthetic dataset and loads it into the `gen` schema. Without --database-url it
// uses the embedded "bench" cluster in .cache/pg-test/bench and a database per size
// (bench_1m, bench_10m, ...), kept between runs; a dataset with the same fingerprint is not
// loaded twice unless --force.
import { parseArgs } from 'node:util';
import pg from 'pg';
import {
  createDataset,
  datasetFingerprint,
  loadDataset,
  loadedFingerprint,
  scaleConfig,
} from '../gen';
import { benchDatabaseName, openBenchDatabase } from '../pg/bench';

const { values } = parseArgs({
  options: {
    items: { type: 'string' },
    seed: { type: 'string' },
    fields: { type: 'string' },
    'fields-per-item': { type: 'string' },
    database: { type: 'string' },
    'database-url': { type: 'string' },
    force: { type: 'boolean', default: false },
  },
});

const items = Number(values.items?.replaceAll('_', ''));
if (!Number.isInteger(items) || items < 1) {
  console.error(
    'Usage: pnpm gen --items <n> [--seed <n>] [--fields <n>] [--fields-per-item <n>] [--database <name>] [--database-url <url>] [--force]',
  );
  process.exit(2);
}
const config = scaleConfig(items, {
  ...(values.seed ? { seed: Number(values.seed) } : {}),
  ...(values.fields ? { fields: Number(values.fields) } : {}),
  // Fewer values per ticket with proportionally fewer fields keeps each field as dense as at
  // full size while the side tables shrink: a larger ticket count fits on a smaller disk.
  ...(values['fields-per-item'] ? { fieldsPerItem: Number(values['fields-per-item']) } : {}),
});

const bench = values['database-url']
  ? undefined
  : await openBenchDatabase(values.database ?? benchDatabaseName(items));

try {
  const pool = bench
    ? bench.pool
    : new pg.Pool({ connectionString: values['database-url'], max: 3 });
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
    if (!bench) await pool.end();
  }
} finally {
  await bench?.close();
}
