// pnpm fuzz query|formula [--minutes N] [--seed N]: fuzzes the query parser (M1-034) or the
// formula parser, checker and evaluator (M1-013), and writes the report to
// .verify/fuzz-<target>.json and each failing input to .cache/fuzz/. Exit code 1 when any input
// broke an invariant.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fuzzFormulas } from '../fuzz-formula';
import { fuzzQueryParser } from '../fuzz-query';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--')) ?? 'query';
const value = (name: string) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (target !== 'query' && target !== 'formula') {
  process.stderr.write(`Unknown fuzz target "${target}"; "query" and "formula" exist.\n`);
  process.exit(2);
}

const minutes = Number(value('minutes') ?? 1);
const seed = Number(value('seed') ?? Date.now() % 2_147_483_647);
process.stdout.write(
  `Fuzzing the ${target === 'query' ? 'query parser' : 'formula language'} for ${minutes} min, seed ${seed}\n`,
);
const progress = (r: { seconds: number; inputs: number; failures: unknown[] }) =>
  process.stdout.write(
    `  ${r.seconds}s: ${r.inputs.toLocaleString('en')} inputs, ${r.failures.length} failures\n`,
  );
const report =
  target === 'query'
    ? fuzzQueryParser({ seed, seconds: minutes * 60, onProgress: progress })
    : fuzzFormulas({ seed, seconds: minutes * 60, onProgress: progress });

mkdirSync(join(ROOT, '.verify'), { recursive: true });
writeFileSync(join(ROOT, '.verify', `fuzz-${target}.json`), `${JSON.stringify(report, null, 2)}\n`);
if (report.failures.length > 0) {
  const dir = join(ROOT, '.cache', 'fuzz');
  mkdirSync(dir, { recursive: true });
  report.failures.forEach((f, i) => {
    writeFileSync(join(dir, `${target}-${seed}-${i}.txt`), f.input);
  });
}

const rate = Math.round(report.inputs / Math.max(1, report.seconds));
process.stdout.write(
  `${report.inputs.toLocaleString('en')} inputs in ${report.seconds}s (${rate}/s): ` +
    `${report.valid.toLocaleString('en')} valid, ${report.invalid.toLocaleString('en')} with errors, ` +
    `slowest ${report.slowest.ms} ms, ${report.failures.length} failures\n`,
);
for (const f of report.failures)
  process.stdout.write(`- ${f.problem}\n  input: ${JSON.stringify(f.input).slice(0, 300)}\n`);
if (report.failures.length > 0) process.exitCode = 1;
