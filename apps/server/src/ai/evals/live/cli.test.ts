import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeProviderServer } from '@taskmoor/ai/testing';
import { testPgAdminUrl } from '@taskmoor/testkit/pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECKS } from './plan';
import type { LiveSummary, NotRun } from './results';

/**
 * `pnpm ai:live` as a whole (T-333; IAM-020): the real command and its real children (the
 * Vitest live files and the eval CLI), pointed at the fake provider with a made-up key. The key
 * must not appear in anything the command prints or keeps, the summary must hold every check,
 * a failing check must fail the command, and without a key and a terminal it must say so and
 * stop with exit code 2.
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
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** The command in a fresh output folder, with only `env` added to a clean environment. */
function runCommand(env: Record<string, string>, args: string[] = []): Promise<Ran> {
  const out = mkdtempSync(join(tmpdir(), 'ai-live-test-'));
  const json = join(out, '.verify', 'ai-live.json');
  const report = join(out, 'docs', 'ai', 'live-checks.md');
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(VITEST|TASKMOOR_AI_)/.test(name) && name !== 'TASKMOOR_TEST_DATABASE_URL',
    ),
  );
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [TSX, CLI, '--json', json, '--report', report, ...args],
      // stdin is not a terminal: the command can never ask.
      { cwd: ROOT, env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
    });
    child.on('close', (code) => {
      const files = new Map(filesUnder(out).map((f) => [f, readFileSync(f, 'utf8')]));
      rmSync(out, { recursive: true, force: true });
      resolve({ code, stdout, stderr, files, json, report });
    });
  });
}

/** Everything the command printed or kept. */
const everything = (ran: Ran) => [ran.stdout, ran.stderr, ...ran.files.values()].join('\n');

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
    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain('ai:live could not run: no API key');
    expect(ran.stderr).toContain('TASKMOOR_AI_KEY');
    expect(ran.stderr).toContain('never put it on the command line');
    const status = JSON.parse(ran.files.get(ran.json) ?? '{}') as NotRun;
    expect(status).toMatchObject({ ran: false, exitCode: 2 });
    expect(ran.files.has(ran.report)).toBe(false);
  });

  it('[IAM-020] stops with exit code 2 when the API refuses the key, and never shows it', {
    timeout: 180_000,
  }, async () => {
    const before = fake.requests.length;
    const ran = await runCommand({ TASKMOOR_AI_KEY: REJECTED }, ['--yes', '--base-url', url]);
    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain('the API did not accept the key');
    // Only the free model list was asked for.
    expect(fake.requests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/models',
    ]);
    expect(everything(ran)).not.toContain(REJECTED);
    expect(ran.files.has(ran.report)).toBe(false);
  });

  it('[IAM-020] [AI-003] [AI-008] [IAM-023] runs every check against the provider, keeps the key out of all it writes, and fails on a failing check', {
    timeout: 900_000,
  }, async () => {
    const ran = await runCommand(
      // The eval run's database on the test server, so it starts no cluster of its own.
      { TASKMOOR_AI_KEY: KEY, TASKMOOR_TEST_DATABASE_URL: testPgAdminUrl() },
      ['--yes', '--base-url', url],
    );
    const output = everything(ran);
    expect(output).not.toContain(KEY);
    // The key was there to scrub: the eval run printed the fake model's answers.
    expect(ran.files.get(join(dirname(ran.json), 'ai-live', 'evals.log'))).toContain('[key]');

    expect(ran.stdout).toContain('Rough cost:');
    const summary = JSON.parse(ran.files.get(ran.json) ?? '{}') as LiveSummary;
    expect(summary.checks.map((c) => c.id)).toEqual(CHECKS.map((c) => c.id));
    const status = Object.fromEntries(summary.checks.map((c) => [c.id, c.status]));
    // The fake answers everything but reads no cache: M1-074's check fails, the command fails.
    expect(status.smoke).toBe('pass');
    expect(status['cache-read']).toBe('fail');
    expect(status['injection-corpus']).toBe('pass');
    for (const id of ['eval-query', 'eval-summary', 'eval-duplicates', 'eval-injection']) {
      expect(status[id], id).not.toBe('error');
    }
    expect(status['eval-query']).toBe('fail');
    // Every case got the summary's answer at least; the structured features fail on the fake.
    expect(status['eval-injection']).toBe('pass');
    expect(summary.checks.find((c) => c.id === 'eval-injection')?.measured).toMatch(
      /^40\/40 cases hold; the model answered \d+ of 160 requests$/,
    );
    expect(summary).toMatchObject({ ran: true, ok: false, exitCode: 1, model: 'claude-opus-5-5' });
    expect(ran.code).toBe(1);
    expect(summary.tasks.find((t) => t.task === 'M1-073')?.done).toBe(true);
    expect(summary.tasks.find((t) => t.task === 'M1-074')?.done).toBe(false);

    const report = ran.files.get(ran.report) ?? '';
    for (const c of CHECKS) expect(report).toContain(`| ${c.title} | ${c.task} |`);
    expect(report).toContain('- M1-074: not yet (cache-read fail).');
    expect(ran.stdout).toContain('What the coordinator records in docs/plan/progress.csv:');
    // No request header and no prompt is kept.
    expect(output.toLowerCase()).not.toContain('x-api-key:');
    expect(report).not.toContain('Summarise WEB-42');
  });
});
