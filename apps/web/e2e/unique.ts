import type { TestInfo } from '@playwright/test';

/** The longest key a track made in Taskmoor may have (apps/server/src/tracks/model.ts). */
const KEY_LENGTH = 10;

let last = 0;

/**
 * This process's clock in milliseconds, never the same value twice: two calls in one
 * millisecond get consecutive values.
 */
function tick(): number {
  last = Math.max(Date.now(), last + 1);
  return last;
}

/**
 * The worker's slot as two base-36 characters. Tests running at the same moment always have
 * different slots, so a test repeated with --repeat-each, or run on both projects at once,
 * never shares a value with its twin even when both start in the same millisecond (T-244).
 */
function slot(testInfo: TestInfo): string {
  return testInfo.parallelIndex.toString(36).toUpperCase().padStart(2, '0');
}

/**
 * A track key no other test of this run, and no earlier run, has used: the prefix, the worker's
 * slot, then as much of this process's clock as fits in a key. Tests running at the same time
 * differ by slot; tests one after another in the same slot differ by the clock.
 */
export function uniqueKey(prefix: string, testInfo: TestInfo): string {
  const room = KEY_LENGTH - prefix.length - 2;
  if (!/^[A-Z][A-Z0-9]*$/.test(prefix) || room < 4) {
    throw new Error(`A key prefix is one to four capital letters or digits, not ${prefix}`);
  }
  return `${prefix}${slot(testInfo)}${tick().toString(36).toUpperCase().slice(-room)}`;
}

/**
 * A word for names, summaries and addresses that no other test of this run, and no earlier
 * run, has used: the project's name, the worker's slot and this process's whole clock.
 */
export function uniqueStamp(testInfo: TestInfo): string {
  return `${testInfo.project.name.replace(/\W/g, '')}${slot(testInfo)}${tick().toString(36)}`.toLowerCase();
}

/**
 * A word of eight capitals and digits for one test's several track keys, each with a prefix of
 * up to two letters, and for its names and addresses: the worker's slot, then the last six
 * characters of this process's clock (T-244).
 */
export function uniqueRun(testInfo: TestInfo): string {
  return `${slot(testInfo)}${tick().toString(36).toUpperCase().slice(-6)}`;
}
