#!/usr/bin/env node
// pnpm verify: the one command that says whether the repo is healthy.
//
// Runs lint, typecheck and the Vitest suites (and Playwright with --e2e), keeps each step's full
// output in .verify/<step>.log, and prints only a short summary plus the failures that matter.
//
//   pnpm verify                 lint + types + all tests
//   pnpm verify --changed       tests related to uncommitted changes only (--changed=<ref> for a ref)
//   pnpm verify --only=tests    run a subset: lint, types, tests, e2e (comma-separated)
//   pnpm verify --e2e           also run Playwright (desktop and mobile)
//   pnpm verify --ci            CI mode: biome ci, e2e included, golden files never written
//   pnpm verify --update        rewrite golden files (vitest -u)
//   pnpm verify --coverage      collect coverage into .verify/coverage
//   pnpm verify -- <args>       pass the remaining args to vitest (a file filter, --project=db, ...)

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, '.verify');

const argv = process.argv.slice(2);
const dashDash = argv.indexOf('--');
const flags = dashDash === -1 ? argv : argv.slice(0, dashDash);
const passthrough = dashDash === -1 ? [] : argv.slice(dashDash + 1);
const flag = (name) => flags.find((f) => f === `--${name}` || f.startsWith(`--${name}=`));
const flagValue = (name) => flag(name)?.split('=').slice(1).join('=') || undefined;

const ci = Boolean(flag('ci')) || process.env.CI === 'true';
const only = flagValue('only')?.split(',');
const wants = (step) => (only ? only.includes(step) : step !== 'e2e' || ci || Boolean(flag('e2e')));

// Resolve a package's JS entry from a workspace directory and run it with this Node, which avoids
// the .cmd shims on Windows.
const bin = (pkg, path, from = ROOT) =>
  join(
    createRequire(join(from, 'package.json'))
      .resolve(`${pkg}/package.json`)
      .replace(/package\.json$/, ''),
    path,
  );

const steps = [
  {
    id: 'lint',
    cmd: process.execPath,
    args: [
      bin('@biomejs/biome', 'bin/biome'),
      ci ? 'ci' : 'check',
      '--colors=off',
      '--max-diagnostics=30',
      '.',
    ],
    summarize: summarizeLint,
  },
  {
    id: 'types',
    cmd: process.execPath,
    args: [bin('typescript', 'bin/tsc'), '-b', '--pretty', 'false'],
    summarize: summarizeTypes,
  },
  {
    id: 'tests',
    cmd: process.execPath,
    args: [
      bin('vitest', 'vitest.mjs'),
      'run',
      '--reporter=dot',
      `--reporter=${join(ROOT, 'tools', 'verify', 'reporter.mjs')}`,
      ...(flag('changed')
        ? [flagValue('changed') ? `--changed=${flagValue('changed')}` : '--changed']
        : []),
      ...(flag('update') && !ci ? ['--update'] : []),
      ...(flag('coverage') ? ['--coverage'] : []),
      ...passthrough,
    ],
    summarize: summarizeTests,
  },
  {
    id: 'e2e',
    cmd: process.execPath,
    args: () => [
      bin('@playwright/test', 'cli.js', join(ROOT, 'apps', 'web')),
      'test',
      '--reporter=line',
    ],
    cwd: join(ROOT, 'apps', 'web'),
    summarize: summarizeE2e,
  },
].filter((step) => wants(step.id));

mkdirSync(OUT, { recursive: true });
rmSync(join(OUT, 'tests.json'), { force: true });

const started = Date.now();
// Lint, types and unit tests are independent, so they run side by side; e2e runs after them.
const parallel = steps.filter((s) => s.id !== 'e2e');
const results = await Promise.all(parallel.map(runStep));
const e2e = steps.find((s) => s.id === 'e2e');
if (e2e) results.push(await runStep(e2e));

const ok = results.every((r) => r.ok);
const total = seconds(Date.now() - started);

console.log(
  `verify: ${results.map((r) => `${r.id} ${r.ok ? 'ok' : 'FAIL'} ${r.headline}`).join(' | ')}`,
);
for (const r of results.filter((r) => !r.ok)) {
  console.log(`\n--- ${r.id} (${relative(ROOT, r.log)}) ---`);
  console.log(r.details.trimEnd());
}
console.log(`\n${ok ? 'PASS' : 'FAIL'} in ${total}`);

writeFileSync(
  join(OUT, 'summary.json'),
  `${JSON.stringify({ ok, seconds: (Date.now() - started) / 1000, at: new Date().toISOString(), results }, null, 2)}\n`,
);
process.exit(ok ? 0 : 1);

// ---------------------------------------------------------------------------------------------

function runStep(step) {
  const log = join(OUT, `${step.id}.log`);
  const t0 = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      const args = typeof step.args === 'function' ? step.args() : step.args;
      child = spawn(step.cmd, args, {
        cwd: step.cwd ?? ROOT,
        env: { ...process.env, FORCE_COLOR: '0' },
        windowsHide: true,
      });
    } catch (error) {
      resolve(finish(step, log, t0, 1, String(error)));
      return;
    }
    let output = '';
    child.stdout.on('data', (d) => {
      output += d;
    });
    child.stderr.on('data', (d) => {
      output += d;
    });
    child.on('error', (error) => {
      output += `\n${error.stack ?? error}`;
    });
    child.on('close', (code) => resolve(finish(step, log, t0, code ?? 1, output)));
  });
}

function finish(step, log, t0, code, rawOutput) {
  const output = stripAnsi(rawOutput);
  writeFileSync(log, output);
  const time = seconds(Date.now() - t0);
  const { ok = code === 0, headline = '', details = '' } = step.summarize(code, output) ?? {};
  return {
    id: step.id,
    ok: ok && code === 0,
    code,
    time,
    headline: `${headline} (${time})`.trim(),
    details,
    log,
  };
}

function summarizeLint(code, output) {
  if (code === 0) return { headline: '' };
  const found = output.match(/Found (\d+) errors?/);
  return {
    headline: found ? `${found[1]} errors` : '',
    details: tail(output, 60),
  };
}

function summarizeTypes(code, output) {
  const errors = output.split(/\r?\n/).filter((line) => /error TS\d+:/.test(line));
  if (code === 0) return { headline: '' };
  return {
    headline: `${errors.length} errors`,
    details: errors.length
      ? errors.slice(0, 20).join('\n') +
        (errors.length > 20 ? `\n... ${errors.length - 20} more` : '')
      : tail(output, 40),
  };
}

function summarizeTests(code, output) {
  let report;
  try {
    report = JSON.parse(readFileSync(join(OUT, 'tests.json'), 'utf8'));
  } catch {
    return { ok: false, headline: 'no report', details: tail(output, 60) };
  }
  const headline =
    `${report.passed} passed` +
    (report.failed ? `, ${report.failed} failed` : '') +
    (report.skipped ? `, ${report.skipped} skipped` : '');

  const lines = [];
  const explain = (errors) => {
    for (const e of errors) {
      lines.push(indent(firstLines(e.message, 8)));
      if (e.diff) lines.push(indent(firstLines(e.diff, 30)));
      for (const frame of e.frames) lines.push(`      ${frame}`);
    }
  };
  for (const f of report.failures) {
    lines.push(`x ${f.name}  (${f.where})`);
    explain(f.errors);
  }
  for (const f of report.fileErrors) {
    lines.push(`x ${f.file} (failed outside a test: import, hook or syntax error)`);
    explain(f.errors);
  }
  if (report.unhandled?.length) {
    lines.push('x unhandled errors during the run');
    explain(report.unhandled);
  }

  const ran = report.passed + report.failed;
  if (ran === 0 && !flag('changed') && code === 0) {
    return { ok: false, headline: 'no tests ran', details: tail(output, 40) };
  }
  return {
    ok: code === 0 && report.failed === 0,
    headline,
    details: lines.length ? lines.join('\n') : tail(output, 60),
  };
}

function summarizeE2e(code, output) {
  const passed = output.match(/(\d+) passed/);
  const failed = output.match(/(\d+) failed/);
  const headline = [passed && `${passed[1]} passed`, failed && `${failed[1]} failed`]
    .filter(Boolean)
    .join(', ');
  return { headline, details: code === 0 ? '' : tail(output, 80) };
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function stripAnsi(text) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape codes is the point
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

function tail(text, n) {
  return text.trimEnd().split(/\r?\n/).slice(-n).join('\n');
}

function firstLines(text, n) {
  const all = text.split(/\r?\n/);
  return all.slice(0, n).join('\n') + (all.length > n ? '\n...' : '');
}

function indent(text) {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}
