import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Writable } from 'node:stream';
import { type ChildResult, runChild } from './run';
import { keyScrubber } from './scrub';

/** Text as JSON, or null when there is none or it does not parse. */
export function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Everything `pnpm ai:live` (T-333; IAM-020) prints, writes, reads back from its children or
 * runs goes through one of these, and so through one scrubber, set once the key is known. No
 * path takes a scrubber of its own, so none can be handed one that lets the key through.
 */
export class ScrubbedIo {
  private scrubText: (text: string) => string = (text) => text;

  constructor(
    private readonly out: Writable = process.stdout,
    private readonly err: Writable = process.stderr,
  ) {}

  /** From now on, the key becomes `[key]` in everything, and a line with a piece of it goes. */
  useKey(key: string): void {
    this.scrubText = keyScrubber(key);
  }

  scrub(text: string): string {
    return this.scrubText(text);
  }

  say(text: string): void {
    this.out.write(this.scrub(`${text}\n`));
  }

  warn(text: string): void {
    this.err.write(this.scrub(`${text}\n`));
  }

  write(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.scrub(text));
  }

  /** A file a child wrote, scrubbed; null when it is not there. */
  read(path: string): string | null {
    return existsSync(path) ? this.scrub(readFileSync(path, 'utf8')) : null;
  }

  /** A child's JSON report, scrubbed and parsed; null when it is missing or unreadable. */
  readJson(path: string): unknown {
    return parseJson(this.read(path));
  }

  /** What a child's tests recorded (`recordLiveResult`), a JSON object a line, scrubbed. */
  records(path: string): Record<string, unknown>[] {
    return (this.read(path) ?? '').split('\n').flatMap((line) => {
      const parsed = parseJson(line.trim() || null);
      return parsed && typeof parsed === 'object' ? [parsed as Record<string, unknown>] : [];
    });
  }

  /** Runs a child; each line of its output is scrubbed before the log or anything else sees it. */
  run(options: Omit<Parameters<typeof runChild>[0], 'scrub'>): Promise<ChildResult> {
    return runChild({ ...options, scrub: (text) => this.scrub(text) });
  }
}
