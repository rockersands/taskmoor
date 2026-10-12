// pnpm bench:check [--results <dir>] [--baseline <dir>] [--size <label>] [--tolerance <ratio>]
//
// Checks spike results against the performance budgets and against a baseline directory for
// regressions over the tolerance (default 20%). Exit code 1 on any problem, so a nightly job
// fails loudly. Sized spikes (query-compiler-1m.json) are chosen by --size, else the largest.

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
