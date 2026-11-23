import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { LineScrubber } from './scrub';

/** What a child run left: its exit code and its output, scrubbed, a line at a time. */
export interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  seconds: number;
  /** Why it could not start, when it could not. */
  failedToStart: string | null;
  /** How it was stopped before its end (Ctrl+C, or a signal); null when it ended by itself. */
  stopped: string | null;
}

/**
 * Variables a child never inherits from `pnpm ai:live`: every way to hand it a key or another
 * provider setting (each child gets exactly the ones it needs), and Vitest's own, which belong
 * to a test run around this one, not to the child's.
 */
const NOT_INHERITED =
  /^(TASKMOOR_AI_(KEY|TEST_KEY|EVAL_KEY|TEST_BASE_URL|EVAL_BASE_URL|EVAL_MODEL|EVAL_PROVIDER|LIVE_RESULTS)|VITEST\w*)$/;

/** The parent's environment without what a child must not inherit, plus `extra`, uncoloured. */
export function childEnvironment(
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!NOT_INHERITED.test(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) if (value !== undefined) env[name] = value;
  env.FORCE_COLOR = '0';
  return env;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape codes is the point
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** The child running now, so Ctrl+C can stop it, and whether it was asked to. */
let current: { child: ChildProcess; stopAsked: boolean } | null = null;

export function stopCurrentChild(): void {
  if (!current) return;
  current.stopAsked = true;
  current.child.kill();
}

/**
 * Runs a child to its end. Each line of its output is scrubbed before anything else sees it:
 * the log, `onLine` and the result all get the scrubbed text only. Each line reaches the log the
 * moment it arrives, so a step that is slow, stopped or killed with the command around it leaves
 * everything it printed until then; a step that was stopped says so at the end of its log.
 */
export function runChild(options: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  scrub: (text: string) => string;
  /** Where the scrubbed output is kept. */
  log: string;
  onLine?: (line: string) => void;
}): Promise<ChildResult> {
  const started = Date.now();
  const seconds = () => (Date.now() - started) / 1000;
  const log = openSync(options.log, 'w');
  const out: string[] = [];
  const err: string[] = [];
  const keep = (into: string[]) => (line: string) => {
    const clean = line.replace(ANSI, '');
    into.push(clean);
    writeSync(log, `${clean}\n`);
    options.onLine?.(clean);
  };
  const stdout = new LineScrubber(options.scrub, keep(out));
  const stderr = new LineScrubber(options.scrub, keep(err));
  const done = (
    code: number | null,
    failedToStart: string | null,
    stopped: string | null,
  ): ChildResult => {
    // Why it could not start, or that it was stopped, goes to the log too: the summary only
    // points there.
    if (failedToStart) writeSync(log, `could not start: ${failedToStart}\n`);
    if (stopped) {
      writeSync(
        log,
        `ai:live: this step was stopped (${stopped}) after ${Math.round(seconds())} s; the lines above are what it printed until then.\n`,
      );
    }
    closeSync(log);
    return {
      code,
      stdout: out.join('\n'),
      stderr: err.join('\n'),
      seconds: seconds(),
      failedToStart,
      stopped,
    };
  };
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      const why = options.scrub(error instanceof Error ? error.message : String(error));
      resolve(done(null, why, null));
      return;
    }
    const running = { child, stopAsked: false };
    current = running;
    let settled = false;
    const settle = (
      code: number | null,
      signal: NodeJS.Signals | null,
      failedToStart: string | null,
    ) => {
      if (settled) return;
      settled = true;
      if (current === running) current = null;
      stdout.end();
      stderr.end();
      const stopped = running.stopAsked ? 'Ctrl+C' : signal;
      resolve(done(code, failedToStart, stopped));
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk));
    // A child that never started may not close.
    child.on('error', (error) => {
      if (child.pid === undefined) settle(null, null, options.scrub(error.message));
    });
    child.on('close', (code, signal) => settle(code, signal, null));
  });
}
