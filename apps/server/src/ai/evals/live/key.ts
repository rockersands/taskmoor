import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/**
 * Where `pnpm ai:live` (T-333) takes the Anthropic API key from: the environment, or, on a
 * terminal, a question whose answer is not shown. The key stays in memory; it reaches the
 * children only through their environment.
 */

/** Environment variables that may hold the key, in order; the first one set is used. */
export const KEY_VARIABLES = [
  'TASKMOOR_AI_KEY',
  'TASKMOOR_AI_TEST_KEY',
  'TASKMOOR_AI_EVAL_KEY',
] as const;
export type KeyVariable = (typeof KEY_VARIABLES)[number];

export interface KeyLookup {
  key: string | null;
  from: KeyVariable | null;
  /** Why a variable that was set was not used. */
  skipped: string | null;
}

/**
 * The key from the environment. TASKMOOR_AI_KEY is also the server's own setting (a headless
 * install's provider key), so it is passed over when TASKMOOR_AI_PROVIDER names another provider.
 */
export function keyFromEnvironment(env: NodeJS.ProcessEnv): KeyLookup {
  let skipped: string | null = null;
  for (const name of KEY_VARIABLES) {
    const value = env[name]?.trim();
    if (!value) continue;
    const provider = env.TASKMOOR_AI_PROVIDER?.trim().toLowerCase();
    if (name === 'TASKMOOR_AI_KEY' && provider && provider !== 'anthropic') {
      skipped = `TASKMOOR_AI_KEY is set for the provider "${provider}"; these checks need an Anthropic API key.`;
      continue;
    }
    return { key: value, from: name, skipped };
  }
  return { key: null, from: null, skipped };
}

/** A key as pasted: at least 8 characters and no spaces inside. */
export function plausibleKey(key: string): boolean {
  return /^\S{8,}$/.test(key);
}

const NEVER_ON_THE_COMMAND_LINE =
  'Never put the key on the command line: not as an argument, and not as TASKMOOR_AI_KEY=... typed at a prompt, which the shell keeps in its history.';

/**
 * Why the command cannot ask for the key when its input is not a terminal, and how to give the
 * key without typing it into a command. Git Bash's own window (MinTTY, `MSYSTEM` set) hands a
 * program like this one a pipe, not a terminal, so nothing typed there could be hidden: there
 * the obvious next step, `export TASKMOOR_AI_KEY=...`, would put the key in the history.
 */
export function noKeyReason(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === 'win32' && env.MSYSTEM) {
    return [
      'no API key, and this window cannot ask for one: Git Bash’s MinTTY window hands programs a pipe, not a terminal, so what you type could not be hidden.',
      'Run `corepack pnpm ai:live` from PowerShell or Windows Terminal instead, or set the key in this shell without typing it into a command:',
      'run `read -rs TASKMOOR_AI_KEY && export TASKMOOR_AI_KEY`, paste the key and press Enter (nothing is shown), then `corepack pnpm ai:live`, and `unset TASKMOOR_AI_KEY` afterwards.',
      NEVER_ON_THE_COMMAND_LINE,
    ].join(' ');
  }
  return [
    'no API key, and the input is not a terminal, so the command cannot ask for one.',
    'Run `corepack pnpm ai:live` in a terminal window and paste the key when asked, or set TASKMOOR_AI_KEY without typing the key into a command (for example from a password manager).',
    NEVER_ON_THE_COMMAND_LINE,
  ].join(' ');
}

/** Terminal escape sequences: arrow keys, and the markers some terminals put around a paste. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape codes is the point
const ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Asks on a terminal for a line that is not shown: nothing is echoed, so the key reaches neither
 * the screen nor the shell's history. Null when the person presses Ctrl+C or the input ends.
 */
export function askHidden(
  question: string,
  input: NodeJS.ReadStream,
  output: Writable,
): Promise<string | null> {
  output.write(question);
  return new Promise((resolve) => {
    let value = '';
    const finish = (result: string | null) => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      resolve(result);
    };
    const onEnd = () => finish(null);
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk).replace(ESCAPES, '')) {
        switch (ch) {
          case '\r':
          case '\n':
            finish(value);
            return;
          case '\u0003': // Ctrl+C
            finish(null);
            return;
          case '\u0004': // Ctrl+D
            finish(value || null);
            return;
          case '\u007f': // Backspace
          case '\b':
            value = value.slice(0, -1);
            break;
          case '\u0015': // Ctrl+U
            value = '';
            break;
          default:
            if (ch >= ' ') value += ch;
        }
      }
    };
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.on('end', onEnd);
    input.resume();
  });
}

/** Asks a yes-or-no question; only "y" or "yes" is a yes, and input that ends is a no. */
export function askYesNo(question: string, input: Readable, output: Writable): Promise<boolean> {
  return new Promise((resolve) => {
    const lines = createInterface({ input, terminal: false });
    let answered = false;
    lines.once('line', (line) => {
      answered = true;
      lines.close();
      resolve(/^y(es)?$/i.test(line.trim()));
    });
    lines.once('close', () => {
      if (!answered) resolve(false);
    });
    output.write(question);
  });
}
