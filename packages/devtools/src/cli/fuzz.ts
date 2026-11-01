// pnpm fuzz <target>|all [--minutes N] [--seed N] [--hang-seconds N]: fuzzes a parser of
// untrusted input and writes the report to .verify/fuzz-<target>.json and each failing input to
// .cache/fuzz/. Exit code 1 when any input broke an invariant (a crash, a hang, a slow input or
// a broken property). `query` and `formula` are the M1-034 and M1-013 fuzzers; the rest are
// M1-118's (ADR-104), each run in a watched worker so a hang is caught and reported.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FuzzReport } from '@taskmoor/testkit/fuzz';
import { runWatched } from '@taskmoor/testkit/fuzz-run';
import { FUZZ_TARGET_FILES } from '../fuzz/registry';
import { fuzzFormulas } from '../fuzz-formula';
import { fuzzQueryParser } from '../fuzz-query';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const args = process.argv.slice(2);
const value = (name: string) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flags = new Set(['--minutes', '--seed', '--hang-seconds']);
const named = args.filter((a, i) => !a.startsWith('--') && !flags.has(args[i - 1] ?? ''));
const wanted = named[0] ?? 'query';
const names = wanted === 'all' ? Object.keys(FUZZ_TARGET_FILES) : [wanted];
for (const name of names) {
  if (!FUZZ_TARGET_FILES[name]) {
    process.stderr.write(
      `Unknown fuzz target "${name}"; these exist: ${Object.keys(FUZZ_TARGET_FILES).join(', ')}, all.\n`,
    );
    process.exit(2);
  }
}

const minutes = Number(value('minutes') ?? 1);
const seed = Number(value('seed') ?? Date.now() % 2_147_483_647);
const hangSeconds = Number(value('hang-seconds') ?? 30);

interface Summary {
  inputs: number;
  seconds: number;
  failures: { input: string; problem: string }[];
  line: string;
  report: unknown;
}

const progress = (r: { seconds: number; inputs: number; failures: unknown[] }) =>
  process.stdout.write(
    `  ${Math.round(r.seconds)}s: ${r.inputs.toLocaleString('en')} inputs, ${r.failures.length} failures\n`,
  );

async function run(name: string): Promise<Summary> {
  const seconds = minutes * 60;
  if (name === 'query' || name === 'formula') {
    const r =
      name === 'query'
        ? fuzzQueryParser({ seed, seconds, onProgress: progress })
        : fuzzFormulas({ seed, seconds, onProgress: progress });
    const rate = Math.round(r.inputs / Math.max(1, r.seconds));
    return {
      inputs: r.inputs,
      seconds: r.seconds,
      failures: r.failures,
      line: `${r.valid.toLocaleString('en')} valid, ${r.invalid.toLocaleString('en')} with errors, slowest ${r.slowest.ms} ms, ${rate}/s`,
      report: r,
    };
  }
  const file = FUZZ_TARGET_FILES[name] as { module: string };
  const r: FuzzReport = await runWatched({
    module: join(ROOT, file.module),
    target: name,
    seed,
    seconds,
    hangSeconds,
    onProgress: progress,
  });
  const outcomes = Object.entries(r.outcomes)
    .map(([k, n]) => `${n.toLocaleString('en')} ${k}`)
    .join(', ');
  return {
    inputs: r.inputs,
    seconds: r.seconds,
    failures: r.failures,
    line: `${outcomes}; slowest ${r.slowest.ms} ms, ${r.perSecond.toLocaleString('en')}/s`,
    report: r,
  };
}

let failed = false;
for (const name of names) {
  process.stdout.write(
    `Fuzzing ${FUZZ_TARGET_FILES[name]?.what} (${name}) for ${minutes} min, seed ${seed}\n`,
  );
  const result = await run(name);
  mkdirSync(join(ROOT, '.verify'), { recursive: true });
  writeFileSync(
    join(ROOT, '.verify', `fuzz-${name}.json`),
    `${JSON.stringify(result.report, null, 2)}\n`,
  );
  if (result.failures.length > 0) {
    failed = true;
    const dir = join(ROOT, '.cache', 'fuzz');
    mkdirSync(dir, { recursive: true });
    result.failures.forEach((f, i) => {
      writeFileSync(join(dir, `${name}-${seed}-${i}.txt`), f.input);
    });
  }
  process.stdout.write(
    `${result.inputs.toLocaleString('en')} inputs in ${Math.round(result.seconds)}s: ${result.line}, ${result.failures.length} failures\n`,
  );
  for (const f of result.failures) {
    process.stdout.write(`- ${f.problem}\n  input: ${JSON.stringify(f.input).slice(0, 300)}\n`);
  }
}
if (failed) process.exitCode = 1;
