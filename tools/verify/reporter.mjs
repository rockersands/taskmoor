// Vitest reporter used by pnpm verify. It writes .verify/tests.json: counts plus, for each
// failure, the message, the expected/actual diff and the stack frames that point into the repo.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, '.verify');

export default class VerifyReporter {
  onTestRunEnd(testModules, unhandledErrors = [], reason) {
    const summary = { reason, passed: 0, failed: 0, skipped: 0, failures: [], fileErrors: [] };

    for (const mod of testModules) {
      const file = rel(mod.moduleId);
      for (const test of mod.children.allTests()) {
        const result = test.result();
        if (result.state === 'passed') summary.passed++;
        else if (result.state === 'failed') {
          summary.failed++;
          summary.failures.push({
            name: test.fullName,
            where: test.location ? `${file}:${test.location.line}` : file,
            errors: (result.errors ?? []).map(describe),
          });
        } else summary.skipped++;
      }
      const errors = mod.errors();
      if (errors.length > 0) summary.fileErrors.push({ file, errors: errors.map(describe) });
    }

    summary.unhandled = unhandledErrors.map(describe);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'tests.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }
}

function describe(error) {
  const frames = String(error?.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .filter((line) => !/node_modules|node:|<anonymous>/.test(line))
    .slice(0, 3)
    .map((line) =>
      line
        .trim()
        .replace(/file:\/\/\/?/, '')
        .replaceAll(ROOT.replaceAll('\\', '/'), ''),
    );
  return {
    message: `${error?.name && error.name !== 'Error' ? `${error.name}: ` : ''}${error?.message ?? String(error)}`,
    diff: error?.diff ?? undefined,
    frames,
  };
}

function rel(path) {
  return relative(ROOT, path).replaceAll('\\', '/');
}
