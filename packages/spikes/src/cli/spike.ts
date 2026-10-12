// pnpm spike field-storage --items <n> [--runs <n>] [--rebuild] [--candidates a,b]
// pnpm spike queue [--jobs <n>] [--workers <n>] [--batch <n>] [--no-durable]
// pnpm spike query --items <n> [--runs <n>]
// pnpm spike authz [--users <n>] [--spaces <n>] [--checks <n>] [--openfga]
// pnpm spike authz-overhead --items <n> [--runs <n>]
// pnpm spike xml [--size 5G] [--seed <n>] [--dir <path>]
//
// Runs an architecture spike and writes its results to docs/spikes/data/<name>.json and
// docs/spikes/<name>.md. The field-storage, query and authz-overhead spikes need the dataset
// that `pnpm gen --items <n>` loaded; the queue and authz spikes use their own embedded
// clusters.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadedFingerprint, sizeLabel } from '@tracksmith/testkit/gen';
import { databaseUrl, withAdminClient } from '@tracksmith/testkit/pg';
import {
  benchDatabaseName,
  openBenchDatabase,
  startEmbeddedPostgres,
} from '@tracksmith/testkit/server';
import pg from 'pg';
import {
  renderAuthzReport,
  renderOverheadReport,
  runAuthzSpike,
  runFilterOverhead,
} from '../authz/bench';
import { scaleAuthz } from '../authz/model';
import type { CandidateId } from '../field-storage/candidates';
import { renderReport, runFieldStorageSpike } from '../field-storage/run';
import { renderQueryReport, runQueryBench } from '../query-bench/run';
import { renderQueueReport, runQueueSpike } from '../queue/bench';
import { parseSize, renderXmlReport, runXmlSpike, sizeLabel as xmlSizeLabel } from '../xml/bench';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const USAGE =
  'Usage: pnpm spike field-storage --items <n> [--runs <n>] [--rebuild] [--candidates jsonb,side,eav]\n' +
  '       pnpm spike queue [--jobs <n>] [--workers <n>] [--batch <n>] [--no-durable]\n' +
  '       pnpm spike query --items <n> [--runs <n>]\n' +
  '       pnpm spike authz [--users <n>] [--spaces <n>] [--checks <n>] [--openfga]\n' +
  '       pnpm spike authz-overhead --items <n> [--runs <n>]\n' +
  '       pnpm spike xml [--size 5G] [--seed <n>] [--dir <path>]';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    items: { type: 'string' },
    runs: { type: 'string', default: '20' },
    rebuild: { type: 'boolean', default: false },
    candidates: { type: 'string' },
    jobs: { type: 'string', default: '20000' },
    workers: { type: 'string', default: '8' },
    batch: { type: 'string', default: '25' },
    durable: { type: 'boolean', default: true },
    users: { type: 'string', default: '100000' },
    spaces: { type: 'string', default: '30000' },
    checks: { type: 'string', default: '2000' },
    openfga: { type: 'boolean', default: false },
    size: { type: 'string', default: '5G' },
    seed: { type: 'string', default: '1' },
    dir: { type: 'string' },
  },
});

function writeResults(name: string, json: unknown, markdown: string): void {
  const dataDir = join(ROOT, 'docs', 'spikes', 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, `${name}.json`), `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(join(ROOT, 'docs', 'spikes', `${name}.md`), markdown);
  console.log(`Report: docs/spikes/${name}.md`);
}

const t0 = Date.now();
switch (positionals[0]) {
  case 'field-storage': {
    const items = Number(values.items?.replaceAll('_', ''));
    if (!Number.isInteger(items) || items < 1) {
      console.error(USAGE);
      process.exit(2);
    }
    const bench = await openBenchDatabase(benchDatabaseName(items));
    try {
      if (!(await loadedFingerprint(bench.pool))) {
        console.error(`No dataset in ${bench.name}. Run: pnpm gen --items ${items}`);
        process.exitCode = 1;
        break;
      }
      const result = await runFieldStorageSpike(bench.pool, {
        runs: Number(values.runs),
        rebuild: values.rebuild,
        ...(values.candidates ? { candidates: values.candidates.split(',') as CandidateId[] } : {}),
        log: (m) => console.log(m),
      });
      writeResults(`field-storage-${sizeLabel(items)}`, result, renderReport(result));
    } finally {
      await bench.close();
    }
    break;
  }
  case 'query': {
    const items = Number(values.items?.replaceAll('_', ''));
    if (!Number.isInteger(items) || items < 1) {
      console.error(USAGE);
      process.exit(2);
    }
    const bench = await openBenchDatabase(benchDatabaseName(items));
    try {
      const side = await bench.pool.query("SELECT to_regclass('fs_side.item') IS NOT NULL AS ok");
      if (!side.rows[0]?.ok) {
        console.error(
          `No side schema in ${bench.name}. Run: pnpm spike field-storage --items ${items}`,
        );
        process.exitCode = 1;
        break;
      }
      const result = await runQueryBench(bench.pool, {
        runs: Number(values.runs),
        log: (m) => console.log(m),
      });
      writeResults(`query-compiler-${sizeLabel(items)}`, result, renderQueryReport(result));
    } finally {
      await bench.close();
    }
    break;
  }
  case 'queue': {
    // Real deployments fsync; the throughput target must hold with it on.
    const settings = values.durable
      ? { fsync: 'on', synchronous_commit: 'on', full_page_writes: 'on' }
      : {};
    const server = await startEmbeddedPostgres({ name: 'queue', settings });
    try {
      await withAdminClient(server.adminUrl, async (client) => {
        const { rowCount } = await client.query(
          "SELECT 1 FROM pg_database WHERE datname = 'queue'",
        );
        if (!rowCount) await client.query('CREATE DATABASE queue');
      });
      const workers = Number(values.workers);
      const pool = new pg.Pool({
        connectionString: databaseUrl(server.adminUrl, 'queue'),
        max: workers + 4,
      });
      try {
        const result = await runQueueSpike(pool, {
          jobs: Number(values.jobs),
          workers,
          batch: Number(values.batch),
          durable: values.durable,
          log: (m) => console.log(m),
        });
        writeResults('queue', result, renderQueueReport(result));
      } finally {
        await pool.end();
      }
    } finally {
      await server.stop();
    }
    break;
  }
  case 'authz': {
    const server = await startEmbeddedPostgres({ name: 'authz' });
    try {
      await withAdminClient(server.adminUrl, async (client) => {
        for (const name of ['authz', 'openfga']) {
          const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
            name,
          ]);
          if (!rowCount) await client.query(`CREATE DATABASE ${name}`);
        }
      });
      const pool = new pg.Pool({ connectionString: databaseUrl(server.adminUrl, 'authz'), max: 4 });
      try {
        const result = await runAuthzSpike(pool, {
          config: scaleAuthz(Number(values.users), Number(values.spaces)),
          checks: Number(values.checks),
          listUsers: 50,
          ...(values.openfga
            ? { openFgaDatastore: `${databaseUrl(server.adminUrl, 'openfga')}?sslmode=disable` }
            : {}),
          log: (m) => console.log(m),
        });
        writeResults('authz', result, renderAuthzReport(result));
      } finally {
        await pool.end();
      }
    } finally {
      await server.stop();
    }
    break;
  }
  case 'authz-overhead': {
    const items = Number(values.items?.replaceAll('_', ''));
    if (!Number.isInteger(items) || items < 1) {
      console.error(USAGE);
      process.exit(2);
    }
    const bench = await openBenchDatabase(benchDatabaseName(items));
    try {
      const result = await runFilterOverhead(bench.pool, {
        runs: Number(values.runs),
        log: (m) => console.log(m),
      });
      writeResults(`authz-overhead-${sizeLabel(items)}`, result, renderOverheadReport(result));
    } finally {
      await bench.close();
    }
    break;
  }
  case 'xml': {
    const bytes = parseSize(values.size);
    const result = await runXmlSpike({
      bytes,
      seed: Number(values.seed),
      ...(values.dir ? { dir: values.dir } : {}),
      log: (m) => console.log(m),
    });
    writeResults(`xml-${xmlSizeLabel(bytes)}`, result, renderXmlReport(result));
    break;
  }
  default:
    console.error(USAGE);
    process.exit(2);
}
console.log(`Done in ${((Date.now() - t0) / 60_000).toFixed(1)} min.`);
