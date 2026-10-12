// pnpm spike <name> --items <n> [--runs <n>] [--rebuild] [--candidates a,b]
//
// Runs an architecture spike against the bench database that `pnpm gen --items <n>` loaded and
// writes its results to docs/spikes/data/<name>-<size>.json and docs/spikes/<name>-<size>.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadedFingerprint, sizeLabel } from '@tracksmith/testkit/gen';
import { benchDatabaseName, openBenchDatabase } from '@tracksmith/testkit/server';
import type { CandidateId } from '../field-storage/candidates';
import { renderReport, runFieldStorageSpike } from '../field-storage/run';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    items: { type: 'string' },
    runs: { type: 'string', default: '20' },
    rebuild: { type: 'boolean', default: false },
    candidates: { type: 'string' },
  },
});

const name = positionals[0];
const items = Number(values.items?.replaceAll('_', ''));
if (name !== 'field-storage' || !Number.isInteger(items) || items < 1) {
  console.error(
    'Usage: pnpm spike field-storage --items <n> [--runs <n>] [--rebuild] [--candidates jsonb,side,eav]',
  );
  process.exit(2);
}

const bench = await openBenchDatabase(benchDatabaseName(items));
try {
  if (!(await loadedFingerprint(bench.pool))) {
    console.error(`No dataset in ${bench.name}. Run: pnpm gen --items ${items}`);
    process.exit(1);
  }
  const t0 = Date.now();
  const result = await runFieldStorageSpike(bench.pool, {
    runs: Number(values.runs),
    rebuild: values.rebuild,
    ...(values.candidates ? { candidates: values.candidates.split(',') as CandidateId[] } : {}),
    log: (m) => console.log(m),
  });
  const label = sizeLabel(items);
  const dataDir = join(ROOT, 'docs', 'spikes', 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, `${name}-${label}.json`), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(ROOT, 'docs', 'spikes', `${name}-${label}.md`), renderReport(result));
  console.log(
    `\nDone in ${((Date.now() - t0) / 60_000).toFixed(1)} min. Report: docs/spikes/${name}-${label}.md`,
  );
} finally {
  await bench.close();
}
