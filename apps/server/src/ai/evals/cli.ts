// pnpm eval <query | summary | duplicates | all> [--candidate <module>] [--json] [--failures=N]
//   [--database-url <admin url>]
//
// The AI eval runner (M1-133; ADR-107). Query and summary seed the eval dataset into a fresh
// database (cloned from the migrated test template) on the test Postgres: TASKMOOR_TEST_DATABASE_URL
// or --database-url when given, otherwise the embedded cluster in .cache/pg-test. The database
// is dropped afterwards. With --candidate, the module's default export (or `candidate`) is
// scored: `{ name, query?, summary?, embed?, rerank? }` (runner.ts). Without one, the references,
// the baselines and the grader self-check run, and the exit code is 1 if any of them is off.
// Progress goes to stderr as the run goes (`eval: query started`, `eval: query done in 12 s`),
// with --json too, whose stdout holds only the JSON: with a model the run takes an hour or more,
// and one that is stopped shows in its output how far it got.
//
// Eval tooling: the server never imports it. It calls no model and needs no key.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createDb } from '@taskmoor/db';
import { migratedTemplate } from '@taskmoor/db/testing';
import { createDatabase, ensureTemplate } from '@taskmoor/testkit/pg';
import { startEmbeddedPostgres } from '@taskmoor/testkit/server';
import { type EvalCandidate, FEATURES, type Feature, formatRun, runEvals } from './runner';
import { type EvalWorld, seedEvalDataset } from './seed';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    candidate: { type: 'string' },
    json: { type: 'boolean', default: false },
    failures: { type: 'string', default: '10' },
    'database-url': { type: 'string' },
  },
});
const which = positionals[0] ?? 'all';
if (which !== 'all' && !FEATURES.includes(which as Feature)) {
  process.stderr.write(
    'Usage: pnpm eval <query | summary | duplicates | all> [--candidate <module>] [--json]\n',
  );
  process.exit(2);
}
const features: Feature[] = which === 'all' ? [...FEATURES] : [which as Feature];
const progress = (line: string) => process.stderr.write(`eval: ${line}\n`);

let candidate: EvalCandidate | undefined;
if (values.candidate) {
  const mod = (await import(pathToFileURL(resolve(process.cwd(), values.candidate)).href)) as {
    default?: EvalCandidate;
    candidate?: EvalCandidate;
  };
  candidate = mod.default ?? mod.candidate;
  if (!candidate) {
    process.stderr.write(`${values.candidate} exports no candidate (default or \`candidate\`)\n`);
    process.exit(2);
  }
  // A candidate that cannot run here (the live one without a key) says why; no score is made.
  if (candidate.unavailable) {
    process.stderr.write(`${candidate.name} cannot run: ${candidate.unavailable}\n`);
    process.exit(2);
  }
}

const cleanup: (() => Promise<void>)[] = [];
let world: EvalWorld | undefined;
const getWorld = async () => {
  if (world) return world;
  let admin = values['database-url'] ?? process.env.TASKMOOR_TEST_DATABASE_URL;
  if (!admin) {
    const server = await startEmbeddedPostgres({ name: 'pg16' });
    cleanup.unshift(() => server.stop());
    admin = server.adminUrl;
  }
  await ensureTemplate(admin, migratedTemplate);
  const created = await createDatabase(admin, { template: migratedTemplate.name });
  cleanup.unshift(() => created.drop());
  const db = createDb({ connectionString: created.url, maxConnections: 5 });
  cleanup.unshift(() => db.destroy());
  const seeding = Date.now();
  progress('seeding the eval dataset (about 30 s)');
  world = await seedEvalDataset(db);
  progress(`seeded in ${Math.round((Date.now() - seeding) / 1000)} s`);
  const seeded = world;
  cleanup.unshift(() => seeded.close());
  return world;
};

try {
  const run = await runEvals({
    features,
    ...(candidate ? { candidate } : {}),
    world: getWorld,
    progress,
  });
  process.stdout.write(
    values.json
      ? `${JSON.stringify(run, null, 2)}\n`
      : formatRun(run, Number(values.failures), candidate?.name),
  );
  if (run.broken.length > 0) process.exitCode = 1;
} finally {
  await candidate?.close?.();
  for (const step of cleanup) await step();
}
