import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TEXT = /\.(ts|tsx|mts|mjs|cjs|js|css|md)$/;
const SKIP = new Set([
  'node_modules',
  'dist',
  'dist-builder',
  'coverage',
  '.cache',
  '__fixtures__',
]);

/** Every source file under `dir`, outside build output and dependencies. */
function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (TEXT.test(entry.name)) found.push(path);
  }
  return found;
}

describe('the sources stay text', () => {
  // A raw NUL byte makes grep and ripgrep take a file for binary and skip it, so its test names
  // and requirement IDs drop out of every search; write the escape (`\u0000`) instead.
  it('[QA-003] holds no NUL byte in any source file', () => {
    const files = ['apps', 'packages', 'tools'].flatMap((dir) => sources(join(ROOT, dir)));
    expect(files.length).toBeGreaterThan(100);
    const binary = files
      .filter((file) => readFileSync(file).includes(0))
      .map((file) => relative(ROOT, file).replaceAll('\\', '/'));
    expect(binary).toEqual([]);
  });
});
