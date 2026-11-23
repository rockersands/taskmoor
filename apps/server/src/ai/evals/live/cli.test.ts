import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeProviderServer } from '@taskmoor/ai/testing';
import { testPgAdminUrl } from '@taskmoor/testkit/pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECKS } from './plan';
import type { LiveSummary, NotRun } from './results';

/**
 * `pnpm ai:live` as a whole (T-333; IAM-020): the real command and its real children (the
 * Vitest live files and the eval CLI), pointed at the fake provider with a made-up key. The key
 * must not appear in anything the command prints or keeps, the summary must hold every check,
 * a failing check must fail the command, and without a key and a terminal, or on Ctrl+C, it must
 * say so and stop with exit code 2.
 */

// Made up for this file: not a key, and not shaped like one. Never in a fixture.
const KEY = 'not-a-key-for-tests';
const REJECTED = 'not-a-key-either-for-tests';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const TSX = join(
  dirname(createRequire(join(ROOT, 'package.json')).resolve('tsx/package.json')),
  'dist/cli.mjs',
);
const CLI = 'apps/server/src/ai/evals/live/cli.ts';

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Every file the command wrote, by path. */
  files: Map<string, string>;
  json: string;
  report: string;
  /** After how many seconds the test had to stop the command; null when it ended by itself. */
  stoppedAfter: number | null;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/**
 * The command in a fresh output folder, with only `env` added to a clean environment. stdin is
 * not a terminal, so the command never asks for the key; with `preload`, a module loaded into
 * the command before it starts (to play the person at the question), stdin is a pipe left open.
 * After `limitMs` the test stops the command (and, on Windows, every process it started), so it
 * is never left waiting on a question nobody answers; `stoppedAfter` says when it had to.
 */
function runCommand(
  env: Record<string, string>,
  args: string[] = [],
  { preload, limitMs = 150_000 }: { preload?: string; limitMs?: number } = {},
): Promise<Ran> {
  const out = mkdtempSync(join(tmpdir(), 'ai-live-test-'));
  const json = join(out, '.verify', 'ai-live.json');
  const report = join(out, 'docs', 'ai', 'live-checks.md');
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(VITEST|TASKMOOR_AI_)/.test(name) &&
        // Git Bash's window gets advice of its own (checks.test.ts); these runs are plain.
        name !== 'MSYSTEM' &&
        name !== 'TASKMOOR_TEST_DATABASE_URL',
    ),
  );
  let hooks: Record<string, string> = {};
  if (preload) {
    const file = join(out, 'preload.mjs');
    writeFileSync(file, preload);
    const options = `${base.NODE_OPTIONS ?? ''} --import=${pathToFileURL(file).href}`;
    hooks = { NODE_OPTIONS: options.trim() };
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, CLI, '--json', json, '--report', report, ...args], {
      cwd: ROOT,
      env: { ...base, ...hooks, ...env },
      stdio: [preload ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stoppedAfter: number | null = null;
    const stop = setTimeout(() => {
      stoppedAfter = limitMs / 1000;
      child.kill();
    }, limitMs);
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
    });
    child.on('close', (code) => {
      clearTimeout(stop);
      const files = new Map(filesUnder(out).map((f) => [f, readFileSync(f, 'utf8')]));
      rmSync(out, { recursive: true, force: true });
      resolve({ code, stdout, stderr, files, json, report, stoppedAfter });
    });
  });
}

/** Everything the command printed or kept. */
const everything = (ran: Ran) => [ran.stdout, ran.stderr, ...ran.files.values()].join('\n');

/** The command ended by itself; if the test had to stop it, the failure says so, and where. */
function endedByItself(ran: Ran): void {
  expect(
    ran.stoppedAfter,
    `the test stopped ai:live after ${ran.stoppedAfter} s; its output until then:\n${ran.stdout.slice(-3000)}\n${ran.stderr.slice(-3000)}`,
  ).toBeNull();
}

describe('pnpm ai:live (T-333)', () => {
  const fake = new FakeProviderServer();
  let url = '';

  beforeAll(async () => {
    fake.accepted.add(KEY);
    fake.chunkDelayMs = 0;
    // A model that answers every request quickly; the plain answers carry the key, so the
    // children's raw output holds it (the eval run prints its summaries) and the command must
    // scrub it out.
    fake.answer = (request) => {
      if (request.schema) return JSON.stringify({ query: 'status = Open', explanation: 'Open.' });
      if (request.prompt.includes('WEB-42')) {
        return 'WEB-42: sign-in fails after a password reset; Sam is investigating.';
      }
      return `A short summary that repeats ${KEY} as a careless model might.`;
    };
    url = await fake.start();
  });
  afterAll(() => fake.stop());

  // Each run starts tsx and loads the AI package: slow on a busy machine.
  it('[IAM-020] without a key and a terminal, says how to give one and stops with exit code 2', {
    timeout: 180_000,
  }, async () => {
    const ran = await runCommand({});
    endedByItself(ran);
    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain(
      'ai:live could not run: no API key, and the input is not a terminal, so the command cannot ask for one.',
    );
    expect(ran.stderr).toContain('TASKMOOR_AI_KEY');
    expect(ran.stderr).toContain('Never put the key on the command line');
    const status = JSON.parse(ran.files.get(ran.json) ?? '{}') as NotRun;
    expect(status).toMatchObject({ ran: false, exitCode: 2 });
    expect(ran.files.has(ran.report)).toBe(false);
  });

  it('[IAM-020] stops with exit code 2 when the API refuses the key, and never shows it', {
    timeout: 180_000,
  }, async () => {
    const before = fake.requests.length;
    const ran = await runCommand({ TASKMOOR_AI_KEY: REJECTED }, ['--yes', '--base-url', url]);
    expect(everything(ran)).not.toContain(REJECTED);
    endedByItself(ran);
    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain('the API did not accept the key');
    // Only the free model list was asked for.
    expect(fake.requests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/models',
    ]);
    expect(ran.files.has(ran.report)).toBe(false);
  });

  it('[OPS-020] Ctrl+C at the question stops with exit code 2 and its status, and nothing is spent', {
    timeout: 180_000,
  }, async () => {
    const before = fake.requests.length;
    // The person presses Ctrl+C when asked whether to go on.
    const ctrlC = [
      'const write = process.stderr.write.bind(process.stderr);',
      'process.stderr.write = (chunk, ...rest) => {',
      "  if (String(chunk).includes('Go on? [y/N]')) setImmediate(() => process.emit('SIGINT'));",
      '  return write(chunk, ...rest);',
      '};',
    ].join('\n');
    const ran = await runCommand({ TASKMOOR_AI_KEY: KEY }, ['--base-url', url], { preload: ctrlC });
    endedByItself(ran);
    expect(ran.stderr).toContain('Go on? [y/N]');
    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain(
      'ai:live could not run: stopped with Ctrl+C before anything was spent',
    );
    const status = JSON.parse(ran.files.get(ran.json) ?? '{}') as NotRun;
    expect(status).toMatchObject({
      ran: false,
      exitCode: 2,
      reason: 'stopped with Ctrl+C before anything was spent',
    });
    expect(ran.files.has(ran.report)).toBe(false);
    expect(fake.requests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/models',
    ]);
  });

  it('[IAM-020] [AI-003] [AI-008] [IAM-023] runs every check against the provider, keeps the key out of all it writes, and fails on a failing check', {
    timeout: 900_000,
  }, async () => {
    const ran = await runCommand(
      // The eval run's database on the test server, so it starts no cluster of its own.
      { TASKMOOR_AI_KEY: KEY, TASKMOOR_TEST_DATABASE_URL: testPgAdminUrl() },
      ['--yes', '--base-url', url],
      // The real children run the whole eval set: about 45 s alone, and 150 s within a full run
      // of the server tests, where seeding the eval dataset alone takes a minute. The test's
      // guard stays under its own limit, so a run too slow for it fails as one, by name.
      { limitMs: 840_000 },
    );
    const output = everything(ran);
    expect(output).not.toContain(KEY);
    endedByItself(ran);
    // The key was there to scrub: the eval run printed the fake model's answers. (Every other
    // way out of the command is scrubbed by the same object, tested in checks.test.ts.)
    const evalsLog = ran.files.get(join(dirname(ran.json), 'ai-live', 'evals.log')) ?? '';
    expect(evalsLog).toContain('[key]');
    // The eval run's progress, kept in its log and shown as it came.
    expect(evalsLog).toMatch(/^eval: seeded in \d+ s$/m);
    expect(evalsLog).toMatch(/^eval: injection done in \d+ s$/m);
    expect(ran.stdout).toMatch(/^ {4}query started$/m);

    expect(ran.stdout).toContain('Rough cost:');
    const summary = JSON.parse(ran.files.get(ran.json) ?? '{}') as LiveSummary;
    expect(summary.checks.map((c) => c.id)).toEqual(CHECKS.map((c) => c.id));
    const status = Object.fromEntries(summary.checks.map((c) => [c.id, c.status]));
    // The fake answers everything but reads no cache: M1-074's check fails, the command fails.
    expect(status.smoke).toBe('pass');
    expect(status['cache-read']).toBe('fail');
    expect(status['injection-corpus']).toBe('pass');
    for (const id of ['eval-query', 'eval-duplicates', 'eval-injection']) {
      expect(status[id], id).not.toBe('error');
    }
    expect(status['eval-query']).toBe('fail');
    const check = (id: string) => summary.checks.find((c) => c.id === id);
    // The fake's answers are no verdicts: the judge disagrees with every graded example, so its
    // verdicts do not count and the summaries are not measured.
    expect(status['eval-summary']).toBe('error');
    expect(check('eval-summary')?.measured).toMatch(
      /^\d+\/12 pass both graders, but the judge is not trusted yet: it disagrees with 39 of 39 graded examples$/,
    );
    // Every case holds, but only the summary and the query got answers: the fake's answer does
    // not fit the drafts' and the breakdown's schemas, so those features failed on every case.
    expect(status['eval-injection']).toBe('fail');
    expect(check('eval-injection')?.measured).toBe(
      '40/40 cases hold; the model answered 80 of 160 requests',
    );
    expect(check('eval-injection')?.details).toEqual([
      'answered per feature: summary 40/40, query 40/40, drafts 0/40, breakdown 0/40',
      'drafts got no answer from the model for any case',
      'breakdown got no answer from the model for any case',
    ]);
    expect(summary).toMatchObject({ ran: true, ok: false, exitCode: 1, model: 'claude-opus-5-5' });
    expect(ran.code).toBe(1);
    expect(summary.tasks.find((t) => t.task === 'M1-073')?.done).toBe(true);
    expect(summary.tasks.find((t) => t.task === 'M1-074')?.done).toBe(false);
    expect(summary.tasks.find((t) => t.task === 'M1-079')?.done).toBe(false);

    const report = ran.files.get(ran.report) ?? '';
    for (const c of CHECKS) expect(report).toContain(`| ${c.title} | ${c.task} |`);
    expect(report).toContain('- M1-074: not yet (cache-read fail).');
    // The cache test's failure by its kind; its message stays in the step's log.
    expect(report).toContain('(an expectation was not met)');
    expect(report).toContain('the messages are in ');
    expect(report).not.toContain('expected 0 to be greater than 0');
    expect(ran.stdout).toContain('What the coordinator records in docs/plan/progress.csv:');
    // No request header and no prompt is kept.
    expect(output.toLowerCase()).not.toContain('x-api-key:');
    expect(report).not.toContain('Summarise WEB-42');
  });
});
