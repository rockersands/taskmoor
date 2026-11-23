// pnpm ai:live [--yes] [--base-url <url>] [--json <file>] [--report <file>]
//
// The checks that need a real model, from one command the user runs once in their own terminal
// (T-333): M1-073's live smoke test and M1-074's cache read (packages/ai/src/live.test.ts), the
// prompt-injection corpus against the live model (packages/ai/src/injection/live.test.ts) and
// M1-079's evals with the live candidate (pnpm eval all --candidate .../candidates/live.ts).
//
// The Anthropic API key comes from TASKMOOR_AI_KEY (or the older TASKMOOR_AI_TEST_KEY or
// TASKMOOR_AI_EVAL_KEY); without one, a terminal is asked for it and shows nothing of it, so it
// never lands in the shell's history. It stays in this process's memory and reaches each child
// only through that child's environment. Every line printed or kept is scrubbed of it.
//
// Before anything is spent: a free check that the API accepts the key, the plan with a rough cost,
// and a question (--yes skips it). Then each step runs, whatever the one before did. The summary
// goes to .verify/ai-live.json and docs/ai/live-checks.md (--json and --report move them).
// Exit code 0 when every check passes, 1 when one fails, 2 when it could not run.
//
// Eval tooling: the server never imports it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  AiGateway,
  AiProviderError,
  createProviderAdapter,
  DEFAULT_MODEL,
  InMemorySecretStore,
  providerConfigSchema,
} from '@taskmoor/ai';
import { askHidden, askYesNo, KEY_VARIABLES, keyFromEnvironment, plausibleKey } from './key';
import { corpusSizes, describePlan, estimate, STEPS, type StepId } from './plan';
import {
  type CheckResult,
  evalChecks,
  injectionCheck,
  type NotRun,
  renderConsole,
  renderMarkdown,
  type StepOutput,
  smokeChecks,
  summarize,
} from './results';
import { childEnvironment, runChild, stopCurrentChild } from './run';
import { keyScrubber } from './scrub';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const AI_PACKAGE = join(ROOT, 'packages', 'ai');
const USAGE = 'Usage: pnpm ai:live [--yes] [--base-url <url>] [--json <file>] [--report <file>]\n';

/** Scrubs everything printed or written, once the key is known. */
let scrub: (text: string) => string = (text) => text;
const say = (text: string) => process.stdout.write(scrub(`${text}\n`));
const warn = (text: string) => process.stderr.write(scrub(`${text}\n`));
const shown = (path: string) => relative(process.cwd(), path).replaceAll('\\', '/') || path;

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, scrub(text));
}

/** Reads a child's file, scrubbed; null when it is not there. */
function readScrubbed(path: string): string | null {
  return existsSync(path) ? scrub(readFileSync(path, 'utf8')) : null;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The records a child's tests wrote (`recordLiveResult`), a JSON object a line. */
function records(path: string): Record<string, unknown>[] {
  return (readScrubbed(path) ?? '').split('\n').flatMap((line) => {
    const parsed = parseJson(line.trim() || null);
    return parsed && typeof parsed === 'object' ? [parsed as Record<string, unknown>] : [];
  });
}

/** The last lines of a child's output, without blank ones. */
const tail = (text: string, n = 15) =>
  text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-n);

/** A test's line from Vitest's verbose reporter, shown as progress: its mark and its name. */
function progress(line: string): void {
  const m = /^\s*(\S+)\s+\|ai\|\s.*>\s(.+)$/.exec(line);
  if (m) say(`    ${m[1]} ${m[2]}`);
}

const resolveIn = (pkg: string, path: string) =>
  join(dirname(createRequire(join(ROOT, 'package.json')).resolve(`${pkg}/package.json`)), path);

const parse = () =>
  parseArgs({
    options: {
      yes: { type: 'boolean', default: false },
      'base-url': { type: 'string' },
      json: { type: 'string' },
      report: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  }).values;

async function main(): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse();
  } catch (error) {
    warn(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    say(USAGE);
    return 0;
  }
  const jsonPath = resolve(args.json ?? join(ROOT, '.verify', 'ai-live.json'));
  const reportPath = resolve(args.report ?? join(ROOT, 'docs', 'ai', 'live-checks.md'));
  const logDir = join(dirname(jsonPath), 'ai-live');

  /** Exit code 2: nothing was run, or nothing more. Only the JSON status says why. */
  const couldNotRun = (reason: string): number => {
    const status: NotRun = { ran: false, at: new Date().toISOString(), reason, exitCode: 2 };
    writeFile(jsonPath, `${JSON.stringify(status, null, 2)}\n`);
    warn(`ai:live could not run: ${reason}`);
    warn(`Nothing was recorded in ${shown(reportPath)}.`);
    return 2;
  };

  // --- The address and the key ----------------------------------------------------------------

  let baseUrl: string | undefined;
  if (args['base-url']) {
    try {
      const url = new URL(args['base-url']);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http');
      url.username = '';
      url.password = '';
      baseUrl = url.toString().replace(/\/$/, '');
    } catch {
      return couldNotRun('--base-url takes an http or https address');
    }
  }
  const endpoint = baseUrl ? `the API at ${baseUrl}` : 'the Anthropic API';

  const lookup = keyFromEnvironment(process.env);
  if (lookup.skipped) warn(lookup.skipped);
  let key = lookup.key;
  if (key) {
    say(`Using the key in ${lookup.from}.`);
  } else if (process.stdin.isTTY) {
    key = await askHidden(
      `No key in ${KEY_VARIABLES.join(', ')}. Paste an Anthropic API key (nothing is shown) and press Enter: `,
      process.stdin,
      process.stderr,
    );
    if (key === null) return couldNotRun('no key was entered');
    key = key.trim();
  } else {
    return couldNotRun(
      'no API key. Set TASKMOOR_AI_KEY, or run `corepack pnpm ai:live` in a terminal and paste the key when asked (never put it on the command line).',
    );
  }
  if (!plausibleKey(key))
    return couldNotRun('that is not an API key (8 characters or more, no spaces)');
  const apiKey = key;
  scrub = keyScrubber(apiKey);

  // --- A free check that the key works: the model list ----------------------------------------

  say(`Checking the key against ${endpoint} (the model list, free)...`);
  const refused = await preflight(apiKey, baseUrl, endpoint);
  if (refused) return couldNotRun(refused);
  say(`The key works and ${DEFAULT_MODEL} is offered.\n`);

  // --- The plan, the cost, and the question ---------------------------------------------------

  const sizes = corpusSizes();
  const cost = estimate(sizes);
  say(describePlan(sizes, cost, endpoint));
  if (!args.yes && !(await askYesNo('Go on? [y/N] ', process.stdin, process.stderr))) {
    return couldNotRun('the run was not confirmed; nothing was spent');
  }

  // --- The steps --------------------------------------------------------------------------------

  const work = mkdtempSync(join(tmpdir(), 'taskmoor-ai-live-'));
  mkdirSync(logDir, { recursive: true });
  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
    stopCurrentChild();
  });
  const VITEST = resolveIn('vitest', 'vitest.mjs');
  const TSX = resolveIn('tsx', 'dist/cli.mjs');

  const vitestStep = async (id: StepId, file: string): Promise<StepOutput> => {
    const report = join(work, `${id}.json`);
    const results = join(work, `${id}.jsonl`);
    const child = await runChild({
      command: process.execPath,
      args: [
        VITEST,
        'run',
        '--config',
        'vitest.config.ts',
        '--reporter=verbose',
        '--reporter=json',
        `--outputFile.json=${report}`,
        file,
      ],
      cwd: AI_PACKAGE,
      env: childEnvironment(process.env, {
        TASKMOOR_AI_TEST_KEY: apiKey,
        TASKMOOR_AI_TEST_BASE_URL: baseUrl,
        TASKMOOR_AI_LIVE_RESULTS: results,
      }),
      scrub,
      log: join(logDir, `${id}.log`),
      onLine: progress,
    });
    return {
      code: child.code,
      report: parseJson(readScrubbed(report)),
      records: records(results),
      tail: [
        ...(child.failedToStart ? [child.failedToStart] : []),
        ...tail(`${child.stdout}\n${child.stderr}`),
      ],
    };
  };

  const evalStep = async (): Promise<StepOutput> => {
    const stepStarted = Date.now();
    const heartbeat = setInterval(() => {
      say(`    still running (${Math.round((Date.now() - stepStarted) / 60_000)} min)`);
    }, 300_000);
    try {
      const child = await runChild({
        command: process.execPath,
        args: [
          TSX,
          'apps/server/src/ai/evals/cli.ts',
          'all',
          '--candidate',
          'apps/server/src/ai/evals/candidates/live.ts',
          '--json',
        ],
        cwd: ROOT,
        env: childEnvironment(process.env, {
          TASKMOOR_AI_EVAL_KEY: apiKey,
          TASKMOOR_AI_EVAL_PROVIDER: 'anthropic',
          TASKMOOR_AI_EVAL_MODEL: DEFAULT_MODEL,
          TASKMOOR_AI_EVAL_BASE_URL: baseUrl,
        }),
        scrub,
        log: join(logDir, 'evals.log'),
      });
      return {
        code: child.code,
        report: parseJson(child.stdout),
        records: [],
        tail: [...(child.failedToStart ? [child.failedToStart] : []), ...tail(child.stderr)],
      };
    } finally {
      clearInterval(heartbeat);
    }
  };

  const started = Date.now();
  const checks: CheckResult[] = [];
  try {
    say(`1/3 ${STEPS[0]?.title} (${STEPS[0]?.runs})`);
    checks.push(...smokeChecks(await vitestStep('smoke', 'src/live.test.ts')));
    if (!interrupted) {
      say(`2/3 ${STEPS[1]?.title} (${STEPS[1]?.runs})`);
      const injection = await vitestStep('injection', 'src/injection/live.test.ts');
      checks.push(injectionCheck(injection, sizes.injectionCases));
    }
    if (!interrupted) {
      say(`3/3 ${STEPS[2]?.title} (${STEPS[2]?.runs}); it prints nothing until it ends`);
      checks.push(...evalChecks(await evalStep()));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (interrupted) return couldNotRun('stopped with Ctrl+C before the end');

  const summary = summarize(checks, {
    at: new Date(started).toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    model: DEFAULT_MODEL,
    endpoint: baseUrl ? `the API at ${baseUrl}` : 'the Anthropic API (https://api.anthropic.com)',
    estimate: { calls: cost.total.calls, dollars: cost.dollars },
  });
  writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  writeFile(reportPath, renderMarkdown(summary));
  say(renderConsole(summary, [shown(jsonPath), shown(reportPath), `${shown(logDir)}/*.log`]));
  return summary.exitCode;
}

/** Null when the API accepts the key and offers the default model; otherwise why not. */
async function preflight(
  apiKey: string,
  baseUrl: string | undefined,
  endpoint: string,
): Promise<string | null> {
  try {
    const adapter = await createProviderAdapter(
      providerConfigSchema.parse({
        provider: 'anthropic',
        apiKey: { secretId: 'live' },
        ...(baseUrl ? { baseUrl } : {}),
      }),
      new InMemorySecretStore({ live: apiKey }),
      { timeoutMs: 30_000 },
    );
    const models = await new AiGateway(adapter).listModels();
    return models.some((m) => m.id === DEFAULT_MODEL)
      ? null
      : `the key works, but ${endpoint} does not offer ${DEFAULT_MODEL}`;
  } catch (error) {
    if (error instanceof AiProviderError) {
      if (error.kind === 'authentication')
        return `the API did not accept the key (${error.message})`;
      if (error.kind === 'connection' || error.kind === 'timeout') {
        return `could not reach ${endpoint} (${error.message})`;
      }
      return `${endpoint} answered with an error (${error.kind}): ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
  }
}

/** Exits once both streams have handed on what was written to them. */
function exitAfterFlush(code: number): void {
  let open = 2;
  const flushed = () => {
    open -= 1;
    if (open === 0) process.exit(code);
  };
  process.stdout.write('', flushed);
  process.stderr.write('', flushed);
}

let code: number;
try {
  code = await main();
} catch (error) {
  // Whatever went wrong, its message is scrubbed like everything else.
  warn(
    `ai:live stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  code = 2;
}
exitAfterFlush(code);
