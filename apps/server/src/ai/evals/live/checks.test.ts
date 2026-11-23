import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { DEFAULT_MODEL, LIST_PRICES } from '@taskmoor/ai';
import { INJECTION_CASES } from '@taskmoor/ai/testing';
import { describe, expect, it } from 'vitest';
import { INJECTION_FEATURES, type InjectionFeature } from '../injection-eval';
import { THRESHOLDS } from '../runner';
import { ScrubbedIo } from './io';
import { askHidden, askYesNo, keyFromEnvironment, noKeyReason, plausibleKey } from './key';
import { CHECKS, corpusSizes, describePlan, estimate } from './plan';
import {
  type CheckResult,
  evalChecks,
  failureKind,
  injectionCheck,
  renderConsole,
  renderMarkdown,
  type StepOutput,
  smokeChecks,
  summarize,
  verdicts,
} from './results';
import { childEnvironment } from './run';
import { KEY_MARK, keyScrubber, LineScrubber, PART_OF_KEY_LINE } from './scrub';

/**
 * The parts of `pnpm ai:live` (T-333) that need no child and no model: the key's scrubbing
 * (IAM-020), the plan and its cost, and how children's reports become checks, a summary and the
 * backlog items it closes (M1-073, M1-074, M1-079). The whole command runs in cli.test.ts.
 */

// Made up for this file: not a key, and not shaped like one.
const KEY = 'not-a-key-for-tests';

/** A terminal for `askHidden`: what is typed goes in, what is shown is kept, raw mode noted. */
function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    raw: [] as boolean[],
    setRawMode(on: boolean) {
      this.raw.push(on);
      return this;
    },
  });
  const output = new PassThrough();
  let shown = '';
  output.on('data', (d: Buffer) => {
    shown += d.toString('utf8');
  });
  return { input, output, shown: () => shown };
}

describe('ai:live keeps the key out of what it prints and keeps (T-333)', () => {
  it('[IAM-020] asks for the key without showing it: nothing typed or pasted is echoed', async () => {
    const t = terminal();
    const asked = askHidden('Key: ', t.input as unknown as NodeJS.ReadStream, t.output);
    // Typed with a slip, then a paste between the markers a terminal may send, then Enter.
    t.input.write('not-a-kex\u007fy');
    t.input.write(`\u001b[200~-for-tests\u001b[201~\r`);
    expect(await asked).toBe(KEY);
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.shown()).toBe('Key: \n');
    expect(t.input.raw).toEqual([true, false]);

    const stopped = terminal();
    const none = askHidden('Key: ', stopped.input as unknown as NodeJS.ReadStream, stopped.output);
    stopped.input.write('abc\u0003');
    expect(await none).toBeNull();
  });

  it('[OPS-020] goes on only after a "y", and an answer that never comes is a no', async () => {
    const answer = async (typed: string | null) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const asked = askYesNo('Go on? ', input, output);
      if (typed === null) input.end();
      else input.write(typed);
      return asked;
    };
    expect(await answer('y\n')).toBe(true);
    expect(await answer('Yes\r\n')).toBe(true);
    expect(await answer('\n')).toBe(false);
    expect(await answer('no\n')).toBe(false);
    expect(await answer(null)).toBe(false);
  });

  it('[IAM-020] replaces the key, as written and as JSON escapes it, with a mark', () => {
    const scrub = keyScrubber(KEY);
    expect(scrub(`x-api-key ${KEY} and again ${KEY}`)).toBe(
      `x-api-key ${KEY_MARK} and again ${KEY_MARK}`,
    );
    const odd = 'odd"key\\with-quotes';
    expect(keyScrubber(odd)(JSON.stringify({ k: odd }))).toBe(`{"k":"${KEY_MARK}"}`);
  });

  it('[IAM-020] drops a line that still holds 16 characters of the key, a key cut short', () => {
    const scrub = keyScrubber(KEY);
    expect(scrub(`first line\nkey starts ${KEY.slice(0, 16)}...\nlast line`)).toBe(
      `first line\n${PART_OF_KEY_LINE}\nlast line`,
    );
    // A shorter piece is not enough to tell.
    expect(scrub(`the word ${KEY.slice(0, 9)}`)).toBe(`the word ${KEY.slice(0, 9)}`);
  });

  it('[IAM-020] catches a key that arrives split across chunks of a stream', () => {
    const lines: string[] = [];
    const stream = new LineScrubber(keyScrubber(KEY), (line) => lines.push(line));
    const text = `starting\r\nsent ${KEY} to the provider\nno newline at the end ${KEY}`;
    for (let i = 0; i < text.length; i += 3) stream.push(text.slice(i, i + 3));
    stream.end();
    expect(lines).toEqual([
      'starting',
      `sent ${KEY_MARK} to the provider`,
      `no newline at the end ${KEY_MARK}`,
    ]);
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('[IAM-020] gives each child exactly the key variables it is handed, and no Vitest state', () => {
    const env = childEnvironment(
      {
        PATH: '/bin',
        TASKMOOR_AI_KEY: 'a',
        TASKMOOR_AI_TEST_KEY: 'b',
        TASKMOOR_AI_EVAL_KEY: 'c',
        TASKMOOR_AI_EVAL_MODEL: 'claude-haiku-5-5',
        VITEST_WORKER_ID: '3',
        TASKMOOR_TEST_DATABASE_URL: 'postgres://localhost/x',
      },
      { TASKMOOR_AI_TEST_KEY: KEY, TASKMOOR_AI_TEST_BASE_URL: undefined },
    );
    expect(env).toEqual({
      PATH: '/bin',
      TASKMOOR_AI_TEST_KEY: KEY,
      TASKMOOR_TEST_DATABASE_URL: 'postgres://localhost/x',
      FORCE_COLOR: '0',
    });
  });

  it('[AI-001] takes the key from TASKMOOR_AI_KEY first, then the older variables', () => {
    expect(keyFromEnvironment({ TASKMOOR_AI_TEST_KEY: 'b', TASKMOOR_AI_EVAL_KEY: 'c' })).toEqual({
      key: 'b',
      from: 'TASKMOOR_AI_TEST_KEY',
      skipped: null,
    });
    expect(keyFromEnvironment({ TASKMOOR_AI_KEY: ' a ', TASKMOOR_AI_TEST_KEY: 'b' }).key).toBe('a');
    // The server's own key for another provider is not an Anthropic key.
    const bedrock = keyFromEnvironment({
      TASKMOOR_AI_PROVIDER: 'bedrock',
      TASKMOOR_AI_KEY: 'a',
      TASKMOOR_AI_EVAL_KEY: 'c',
    });
    expect(bedrock.key).toBe('c');
    expect(bedrock.skipped).toContain('bedrock');
    expect(keyFromEnvironment({}).key).toBeNull();
    expect(plausibleKey(KEY)).toBe(true);
    expect(plausibleKey('short')).toBe(false);
    expect(plausibleKey('has a space inside')).toBe(false);
  });

  it('[IAM-020] without a terminal, says how to give the key without typing it into a command', () => {
    const plain = noKeyReason({}, 'linux');
    expect(plain).toContain('the input is not a terminal');
    expect(plain).toContain('Never put the key on the command line');
    // Git Bash's MinTTY window: the command cannot hide what is typed, so it says so and points
    // to PowerShell, Windows Terminal or a `read -rs` that keeps the key out of the history.
    const mintty = noKeyReason({ MSYSTEM: 'MINGW64' }, 'win32');
    expect(mintty).toContain('MinTTY');
    expect(mintty).toContain('PowerShell or Windows Terminal');
    expect(mintty).toContain('`read -rs TASKMOOR_AI_KEY && export TASKMOOR_AI_KEY`');
    expect(mintty).toContain('Never put the key on the command line');
    expect(noKeyReason({ MSYSTEM: 'MINGW64' }, 'darwin')).toBe(plain);
  });
});

/** A stream that keeps what is written to it. */
function capture() {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (d: Buffer) => {
    text += d.toString('utf8');
  });
  return { stream, text: () => text };
}

describe('ai:live scrubs every way out of the command (T-333)', () => {
  it('[IAM-020] scrubs what it prints, what it writes and what it reads back from a child', async () => {
    const out = capture();
    const err = capture();
    const io = new ScrubbedIo(out.stream, err.stream);
    io.useKey(KEY);
    const dir = mkdtempSync(join(tmpdir(), 'ai-live-io-'));
    try {
      io.say(`said ${KEY}`);
      io.warn(`warned ${KEY}`);
      const written = join(dir, 'docs', 'live-checks.md');
      io.write(written, `wrote ${KEY}\n`);
      expect(readFileSync(written, 'utf8')).toBe(`wrote ${KEY_MARK}\n`);
      // A child's report and records, as a failing test or a careless record would leave them.
      const report = join(dir, 'smoke.json');
      writeFileSync(report, JSON.stringify({ failure: `expected '${KEY}' to contain 'WEB-42'` }));
      expect(io.readJson(report)).toEqual({
        failure: `expected '${KEY_MARK}' to contain 'WEB-42'`,
      });
      const records = join(dir, 'smoke.jsonl');
      writeFileSync(records, `${JSON.stringify({ check: 'smoke', model: KEY })}\nnot json\n`);
      expect(io.records(records)).toEqual([{ check: 'smoke', model: KEY_MARK }]);
      expect(io.read(join(dir, 'missing.json'))).toBeNull();
      expect(io.records(join(dir, 'missing.jsonl'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(out.text()).toBe(`said ${KEY_MARK}\n`);
    expect(err.text()).toBe(`warned ${KEY_MARK}\n`);
  });

  it('[IAM-020] scrubs a child’s output before its log, its progress lines and its result see it', async () => {
    const io = new ScrubbedIo(capture().stream, capture().stream);
    io.useKey(KEY);
    const dir = mkdtempSync(join(tmpdir(), 'ai-live-io-'));
    try {
      const log = join(dir, 'child.log');
      const lines: string[] = [];
      const child = await io.run({
        command: process.execPath,
        args: ['-e', 'console.log("out " + process.env.K); console.error("err " + process.env.K)'],
        cwd: dir,
        env: { ...process.env, K: KEY },
        log,
        onLine: (line) => lines.push(line),
      });
      expect(child).toMatchObject({
        code: 0,
        stdout: `out ${KEY_MARK}`,
        stderr: `err ${KEY_MARK}`,
      });
      expect(lines.sort()).toEqual([`err ${KEY_MARK}`, `out ${KEY_MARK}`]);
      const logged = readFileSync(log, 'utf8');
      expect(logged).toContain(`out ${KEY_MARK}`);
      expect(logged).not.toContain(KEY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ai:live plans and prices its run before spending (T-333)', () => {
  it('[OPS-020] counts the calls from the corpora and prices them at the list price', () => {
    const sizes = corpusSizes();
    expect(sizes.injectionCases).toBe(INJECTION_CASES.length);
    expect(sizes.queries).toBeGreaterThanOrEqual(100);
    expect(sizes.graded).toBeGreaterThan(sizes.summaries);
    const e = estimate(sizes);
    expect(e.model).toBe(DEFAULT_MODEL);
    for (const load of [...Object.values(e.steps), e.total]) {
      for (const [lo, hi] of [load.calls, load.inputTokens, load.outputTokens]) {
        expect(lo).toBeGreaterThan(0);
        expect(hi).toBeGreaterThanOrEqual(lo as number);
      }
    }
    expect(e.total.calls[0]).toBe(
      e.steps.smoke.calls[0] + e.steps.injection.calls[0] + e.steps.evals.calls[0],
    );
    const price = LIST_PRICES.find((p) => p.provider === 'anthropic' && p.model === DEFAULT_MODEL);
    expect(e.price).toEqual({
      input: (price?.price.inputNanos ?? 0) / 1000,
      output: (price?.price.outputNanos ?? 0) / 1000,
    });
    const low =
      (e.total.inputTokens[0] * e.price.input + e.total.outputTokens[0] * e.price.output) / 1e6;
    expect(e.dollars[0]).toBeCloseTo(low, 6);
    expect(e.dollars[1]).toBeGreaterThan(e.dollars[0]);

    const plan = describePlan(sizes, e, 'the Anthropic API');
    expect(plan).toContain(`${sizes.injectionCases} cases`);
    expect(plan).toContain(`${sizes.queries} questions to queries`);
    expect(plan).toContain(`$${Math.round(e.dollars[0])} to $${Math.round(e.dollars[1])}`);
    expect(plan).toContain('Use a key with a spend limit');
  });

  it('[AI-013] [AI-014] [AI-016] holds each check to the thresholds of M1-079', () => {
    expect(CHECKS.map((c) => [c.id, c.task])).toEqual([
      ['smoke', 'M1-073'],
      ['cache-read', 'M1-074'],
      ['injection-corpus', 'M1-079'],
      ['eval-query', 'M1-079'],
      ['eval-summary', 'M1-079'],
      ['eval-duplicates', 'M1-079'],
      ['eval-injection', 'M1-079'],
    ]);
    expect(CHECKS.find((c) => c.id === 'eval-query')?.threshold).toBe(
      `${Math.round(THRESHOLDS.query * 100)}% or more`,
    );
  });
});

/** A Vitest JSON report of the given tests. */
const vitest = (tests: [title: string, status: string, failure?: string][]) => ({
  testResults: [
    {
      status: 'failed',
      assertionResults: tests.map(([title, status, failure]) => ({
        title,
        status,
        failureMessages: failure ? [failure] : [],
      })),
    },
  ],
});

const LOG = '.verify/ai-live/smoke.log';

const output = (report: unknown, records: Record<string, unknown>[] = []): StepOutput => ({
  code: 1,
  report,
  records,
  log: LOG,
});

/** An eval run as `pnpm eval all --json` prints it, trimmed to what is read. */
const evalRun = (
  query: number,
  summaryPassed: number,
  recall: number,
  held: number,
  options: {
    /** The cases each feature got no answer for. */
    unanswered?: Partial<Record<InjectionFeature, string[]>>;
    /** Graded examples the judge agrees with, of 39. */
    judgeAgree?: number;
  } = {},
) => ({
  query: [
    {
      total: 125,
      passed: Math.round(query * 125),
      score: query,
      byLanguage: { en: { total: 77, passed: 70, score: 0.9 } },
      failures: [{ id: 'en-003', prompt: 'my open bugs, said by someone' }],
    },
  ],
  summary: [
    {
      total: 12,
      passed: summaryPassed,
      score: summaryPassed / 12,
      judged: 'judged',
      failures:
        summaryPassed < 12 ? [{ id: 'sum-04', failed: ['faithful'], text: 'A summary.' }] : [],
    },
  ],
  duplicates: [{ queries: 46, recallAt3: recall, mrr: 0.9, failures: [] }],
  injection: [
    {
      total: 40,
      passed: held,
      score: held / 40,
      answered: 160 - Object.values(options.unanswered ?? {}).flat().length,
      asked: 160,
      byFeature: Object.fromEntries(
        INJECTION_FEATURES.map((f) => [f, 40 - (options.unanswered?.[f]?.length ?? 0)]),
      ),
      failures:
        held < 40 ? [{ id: 'exfil-image', problems: ['an answer keeps a foreign image'] }] : [],
      outcomes: ['reveal-direct', 'tool-shell', 'exfil-image'].map((id) => ({
        id,
        answeredBy: INJECTION_FEATURES.filter((f) => !options.unanswered?.[f]?.includes(id)),
      })),
    },
  ],
  judge: {
    examples: 39,
    agree: options.judgeAgree ?? 39,
    disagreements: Array.from({ length: 39 - (options.judgeAgree ?? 39) }, (_, n) => ({
      example: `sum-0${n + 1}-flawed`,
      labelled: ['faithful'],
      judged: [],
    })),
  },
  pending: [],
  broken: [],
});

describe('ai:live turns the children’s reports into checks (T-333)', () => {
  const smokeTests = (cache: string) =>
    vitest([
      ['[AI-003] answers a summary through the gateway', 'passed'],
      [
        '[AI-008] a repeat call with the same prefix reads the cache',
        cache,
        'AssertionError: expected 0 to be greater than 0',
      ],
      ['[AI-007] streams, returns strict structured output', 'passed'],
      ['[AI-001] [AI-002] counts tokens and lists models live', 'passed'],
    ]);

  it('[AI-003] [AI-008] reads the smoke test and the cache read from the live test file', () => {
    const records = [
      { check: 'smoke', model: 'claude-opus-5-5' },
      {
        check: 'cache-read',
        firstCacheWriteTokens: 1450,
        firstCacheReadTokens: 0,
        cacheReadTokens: 1450,
      },
    ];
    const [smoke, cache] = smokeChecks(output(smokeTests('passed'), records));
    expect(smoke).toMatchObject({
      status: 'pass',
      measured: '3/3 tests pass; answered by claude-opus-5-5',
    });
    expect(cache).toMatchObject({
      status: 'pass',
      measured: '1450 cache-read tokens on the repeat call',
    });

    const zero = smokeChecks(
      output(smokeTests('failed'), [{ check: 'cache-read', cacheReadTokens: 0 }]),
    )[1];
    expect(zero.status).toBe('fail');
    expect(zero.details.slice(-2)).toEqual([
      '[AI-008] a repeat call with the same prefix reads the cache: failed (an expectation was not met)',
      `the messages are in ${LOG}`,
    ]);
    expect(zero.details.join(' ')).not.toContain('expected 0');
  });

  it('[IAM-020] names a failure by its kind and status, never by the text a provider or an assertion carries', () => {
    // A rate limit that outlasted the retries: the provider's message names the organization.
    const ORG = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
    const limited = `AiProviderError: anthropic: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization (${ORG})"}}\n    at attempt (gateway.ts:720:15)`;
    expect(failureKind(limited)).toBe('AiProviderError, HTTP 429');
    // An assertion that quotes the model's answer.
    const quoted =
      "AssertionError: expected 'The ticket describes a sign-in failur…' to contain 'WEB-42'";
    expect(failureKind(quoted)).toBe('an expectation was not met');
    expect(failureKind('Error: Test timed out in 180000ms.\nIf this is a long-running test')).toBe(
      'timed out after 180 s',
    );
    expect(failureKind('AiProviderError: anthropic: Connection error.')).toBe('AiProviderError');
    expect(failureKind('TypeError: x is not a function')).toBe('TypeError');
    expect(failureKind('something odd happened')).toBe('an error');
    expect(failureKind('')).toBe('');

    const [smoke, cache] = smokeChecks(
      output(
        vitest([
          ['[AI-003] answers a summary through the gateway', 'failed', limited],
          ['[AI-008] a repeat call with the same prefix reads the cache', 'failed', quoted],
        ]),
      ),
    );
    expect(smoke.details).toEqual([
      '[AI-003] answers a summary through the gateway: failed (AiProviderError, HTTP 429)',
      `the messages are in ${LOG}`,
    ]);
    const md = renderMarkdown(
      summarize([smoke, cache], {
        at: '2026-11-23T08:00:00.000Z',
        seconds: 60,
        model: DEFAULT_MODEL,
        endpoint: 'the Anthropic API',
        estimate: { calls: [1, 2], dollars: [1, 2] },
      }),
    );
    expect(md).toContain('(AiProviderError, HTTP 429)');
    expect(md).not.toContain(ORG);
    expect(md).not.toContain('sign-in failur');
    expect(md).not.toContain('rate_limit_error');
  });

  it('[AI-003] says a check was not measured when the tests were skipped or left no report', () => {
    const skipped = smokeChecks(
      output(
        vitest([
          ['[AI-003] answers', 'skipped'],
          ['[AI-008] cache', 'skipped'],
        ]),
      ),
    );
    expect(skipped.map((c) => c.status)).toEqual(['error', 'error']);
    expect(skipped[0].details).toEqual(['the tests were skipped: the key did not reach them']);
    const none = smokeChecks(output(null));
    expect(none[0]).toMatchObject({ status: 'error', measured: 'not measured' });
    // The child's own output stays in its log; the summary only points there.
    expect(none[0].details).toEqual([
      `the test run left no report (exit code 1); its output and messages are in ${LOG}`,
    ]);
    const stopped = smokeChecks(
      output({ testResults: [{ message: 'Error: Cannot find module ./gateway' }] }),
    );
    expect(stopped[0].details).toEqual([
      `the test file stopped before its tests ran (Error); its output and messages are in ${LOG}`,
    ]);
  });

  it('[IAM-023] counts the corpus cases that held and names those that did not', () => {
    const held = INJECTION_CASES.map((c) => ({
      check: 'injection-case',
      id: c.id,
      holds: true,
      followed: c.attempt.kind === 'none' ? null : c.id === 'write-close',
    }));
    const all = injectionCheck(output(null, held), INJECTION_CASES.length);
    expect(all).toMatchObject({ status: 'pass', measured: `40/40 cases hold` });
    expect(all.details[0]).toMatch(
      /^the model went where the injection pointed in 1 of the \d+ cases/,
    );

    const one = held.map((r) =>
      r.id === 'tool-delete'
        ? { ...r, holds: false, problems: ['delete_ticket ran, though it was not offered'] }
        : r,
    );
    const failing = injectionCheck(output(null, one.slice(1)), INJECTION_CASES.length);
    expect(failing.status).toBe('fail');
    expect(failing.measured).toBe('38/40 cases hold');
    expect(failing.details).toContain('tool-delete: delete_ticket ran, though it was not offered');
    expect(failing.details).toContain('1 case left no result');
    expect(injectionCheck(output(null), 40).status).toBe('error');
  });

  it('[AI-013] [AI-014] [AI-016] [IAM-023] reads the evals against their thresholds', () => {
    const passing = evalChecks({ ...output(evalRun(0.92, 12, 0.85, 40)), code: 0 });
    expect(passing.map((c) => [c.id, c.status])).toEqual([
      ['eval-query', 'pass'],
      ['eval-summary', 'pass'],
      ['eval-duplicates', 'pass'],
      ['eval-injection', 'pass'],
    ]);
    expect(passing[0]?.measured).toBe('92.0% (115/125; en 70/77)');
    expect(passing[1]?.details[0]).toBe(
      'judge calibration: 39/39 graded examples agree with their labels',
    );
    expect(passing[3]?.measured).toBe('40/40 cases hold; the model answered 160 of 160 requests');
    expect(passing[3]?.details).toEqual([
      'answered per feature: summary 40/40, query 40/40, drafts 40/40, breakdown 40/40',
    ]);

    const failing = evalChecks({ ...output(evalRun(0.84, 11, 0.79, 39)), code: 0 });
    expect(failing.map((c) => c.status)).toEqual(['fail', 'fail', 'fail', 'fail']);
    expect(failing[0]?.details).toEqual(['no exact-result match: en-003']);
    expect(failing[1]?.details).toContain('sum-04: fails faithful');
    // Ids and criteria only: no prompt and no answer reaches the summary.
    const text = JSON.stringify(failing);
    expect(text).not.toContain('my open bugs');
    expect(text).not.toContain('A summary.');

    const stopped = evalChecks({
      code: 2,
      report: null,
      records: [],
      log: '.verify/ai-live/evals.log',
    });
    expect(stopped.map((c) => c.status)).toEqual(['error', 'error', 'error', 'error']);
    expect(stopped[0]?.details).toEqual([
      'the eval run stopped (exit code 2); its output and messages are in .verify/ai-live/evals.log',
    ]);
    const unjudged = evalRun(1, 12, 1, 40);
    unjudged.summary[0] = {
      ...(unjudged.summary[0] as (typeof unjudged.summary)[0]),
      judged: 'pending',
    };
    expect(evalChecks({ ...output(unjudged), code: 0 })[1]).toMatchObject({
      status: 'fail',
      measured: '12/12 pass the automatic criteria; the judge did not run',
    });
  });

  it('[AI-013] counts the judge’s verdicts only once it agrees with every graded example', () => {
    // A lenient judge passes every summary, and so misses flaws the graded examples carry.
    for (const agree of [37, 20]) {
      const checks = evalChecks({
        ...output(evalRun(1, 12, 1, 40, { judgeAgree: agree })),
        code: 0,
      });
      expect(checks[1]).toMatchObject({
        status: 'error',
        measured: `12/12 pass both graders, but the judge is not trusted yet: it disagrees with ${39 - agree} of 39 graded examples`,
      });
      expect(checks[1]?.details[0]).toBe(
        `judge calibration: ${agree}/39 graded examples agree with their labels`,
      );
      expect(checks[1]?.details[1]).toMatch(
        /^the judge disagrees with sum-01-flawed, sum-02-flawed.*: review them and correct the prompt or the label/,
      );
      // So M1-079 is not done, though every other check passes.
      const all = CHECKS.map((c): CheckResult => {
        const measured = checks.find((x) => x.id === c.id);
        return measured ?? { ...c, status: 'pass', measured: 'measured', details: [] };
      });
      expect(verdicts(all).find((v) => v.task === 'M1-079')).toEqual({
        task: 'M1-079',
        done: false,
        open: ['eval-summary'],
      });
    }
  });

  it('[IAM-023] [AI-015] needs every feature to get the model’s answer for every injection case', () => {
    // Drafts and breakdown fail on every call: each case still holds, through the other two.
    const down = evalRun(1, 12, 1, 40, {
      unanswered: {
        drafts: ['reveal-direct', 'tool-shell', 'exfil-image'],
        breakdown: ['tool-shell'],
      },
    });
    const injection = evalChecks({ ...output(down), code: 0 })[3];
    expect(injection).toMatchObject({
      status: 'fail',
      measured: '40/40 cases hold; the model answered 156 of 160 requests',
    });
    expect(injection?.details).toEqual([
      'answered per feature: summary 40/40, query 40/40, drafts 37/40, breakdown 39/40',
      'drafts got no answer from the model for reveal-direct, tool-shell, exfil-image',
      'breakdown got no answer from the model for tool-shell',
    ]);
  });
});

describe('ai:live sums up the run and what it closes (T-333)', () => {
  const pass = (c: (typeof CHECKS)[number]): CheckResult => ({
    ...c,
    status: 'pass',
    measured: 'measured',
    details: [],
  });
  const meta = {
    at: '2026-11-22T14:05:00.000Z',
    seconds: 4_380,
    model: DEFAULT_MODEL,
    endpoint: 'the Anthropic API (https://api.anthropic.com)',
    estimate: { calls: [440, 890] as [number, number], dollars: [7, 52] as [number, number] },
  };

  it('[AI-003] closes M1-073, M1-074 and M1-079 when every check passes, and exits 0', () => {
    const s = summarize(CHECKS.map(pass), meta);
    expect(s).toMatchObject({ ok: true, exitCode: 0 });
    expect(s.tasks).toEqual([
      { task: 'M1-073', done: true, open: [] },
      { task: 'M1-074', done: true, open: [] },
      { task: 'M1-079', done: true, open: [] },
    ]);
    expect(renderConsole(s, ['a.json'])).toContain('M1-073, M1-074 and M1-079 are done');
  });

  it('[AI-008] leaves open only the items whose checks did not pass, and exits 1', () => {
    const checks = CHECKS.map((c) =>
      c.id === 'cache-read'
        ? { ...pass(c), status: 'fail' as const, details: ['the first call wrote 0'] }
        : c.id === 'eval-query'
          ? { ...pass(c), status: 'error' as const }
          : pass(c),
    );
    const s = summarize(checks, meta);
    expect(s).toMatchObject({ ok: false, exitCode: 1 });
    expect(verdicts(checks)).toEqual([
      { task: 'M1-073', done: true, open: [] },
      { task: 'M1-074', done: false, open: ['cache-read'] },
      { task: 'M1-079', done: false, open: ['eval-query'] },
    ]);
    const md = renderMarkdown(s);
    expect(md).toContain('- Run: 2026-11-22 14:05 UTC, took 1 h 13 min');
    expect(md).toContain('- Result: 5 of 7 checks pass');
    expect(md).toContain('- M1-074: not yet (cache-read fail).');
    expect(md).toContain('- M1-079: not yet (eval-query not measured).');
    for (const c of CHECKS) expect(md).toContain(`| ${c.title} | ${c.task} |`);
    expect(md).toContain('- the first call wrote 0');
  });
});
