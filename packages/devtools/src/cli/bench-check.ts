// pnpm bench:check [--results <dir>] [--baseline <dir>] [--size <label>] [--tolerance <ratio>]
//                  [--no-tests] [--e2e]
//
// Checks spike results against the performance budgets and against a baseline directory for
// regressions over the tolerance (default 20%). Exit code 1 on any problem, so a nightly job
// fails loudly. Sized spikes (query-compiler-1m.json) are chosen by --size, else the largest.
//
// Then it runs the tests that hold speed limits (`expectWithinBudget`) with the limits
// enforced (TASKMOOR_ENFORCE_BUDGETS=1); the routine gate only measures them. --e2e adds the
// end-to-end specs that hold one; --no-tests skips this part.

import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  checkBudgets,
  checkRegressions,
  formatBenchReport,
  loadResults,
  resultSizes,
} from '../bench';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const { values } = parseArgs({
  options: {
    results: { type: 'string', default: join(ROOT, 'docs', 'spikes', 'data') },
    baseline: { type: 'string', default: join(ROOT, 'docs', 'spikes', 'baseline') },
    size: { type: 'string' },
    tolerance: { type: 'string', default: '0.2' },
    'no-tests': { type: 'boolean', default: false },
    e2e: { type: 'boolean', default: false },
  },
});

const results = loadResults(values.results, values.size);
// The baseline is read at the sizes the results have, so a 10M run is never judged against 200k.
const baseline = loadResults(values.baseline, resultSizes(values.results, values.size));
const problems = [
  ...checkBudgets(results),
  ...checkRegressions(results, baseline, Number(values.tolerance)),
];
const compared = Object.keys(baseline).filter((k) => k in results);
const note =
  compared.length === 0
    ? `No baseline in ${values.baseline}; budgets only.`
    : `Compared with the baseline in ${values.baseline} (${compared.join(', ')}); tolerance ${Math.round(Number(values.tolerance) * 100)}%.`;
process.stdout.write(formatBenchReport(results, problems, note));
if (problems.length > 0) process.exitCode = 1;

/** Tracked files under the patterns that call the budget helper. */
const holding = (...patterns: string[]) =>
  execFileSync('git', ['grep', '-l', 'expectWithinBudget', '--', ...patterns], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
const enforced = { ...process.env, TASKMOOR_ENFORCE_BUDGETS: '1' };

if (!values['no-tests']) {
  const files = holding('*.test.ts', '*.test.tsx', '*.stories.tsx');
  process.stdout.write(`\nSpeed limits in ${files.length} test files, enforced:\n`);
  const run = spawnSync(
    process.execPath,
    [join(ROOT, 'tools', 'verify', 'verify.mjs'), '--only=tests', '--', ...files],
    { cwd: ROOT, env: enforced, stdio: 'inherit' },
  );
  if (run.status !== 0) process.exitCode = 1;
}
if (values.e2e) {
  const web = join(ROOT, 'apps', 'web');
  const specs = holding('apps/web/e2e/*.spec.ts').map((f) => f.replace(/^apps\/web\//, ''));
  process.stdout.write(`\nSpeed limits in ${specs.length} end-to-end specs, enforced:\n`);
  const cli = createRequire(join(web, 'package.json')).resolve('@playwright/test/cli');
  const run = spawnSync(process.execPath, [cli, 'test', '--reporter=line', ...specs], {
    cwd: web,
    env: enforced,
    stdio: 'inherit',
  });
  if (run.status !== 0) process.exitCode = 1;
}
