import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MODELS = fileURLToPath(new URL('../models', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/**
 * The bundled embedding model (M1-078; AI-012) is the files its source published and nothing
 * else: each folder's `SHA256SUMS` lists every file, and every file matches it.
 */
describe('bundled models', () => {
  for (const model of readdirSync(MODELS)) {
    it(`[AI-012] ${model} is exactly the verified download`, () => {
      const dir = join(MODELS, model);
      const sums = new Map(
        readFileSync(join(dir, 'SHA256SUMS'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => {
            const [hash, path] = line.split(/\s+/);
            return [(path ?? '').replace(/^\.\//, ''), hash ?? ''] as const;
          }),
      );
      const present = files(dir)
        .map((path) => relative(dir, path))
        .filter((path) => path !== 'SHA256SUMS' && path !== 'SOURCE.md')
        .sort();
      expect(present).toEqual([...sums.keys()].sort());
      for (const path of present) {
        const hash = createHash('sha256')
          .update(readFileSync(join(dir, path)))
          .digest('hex');
        expect(hash, path).toBe(sums.get(path));
      }
    });
  }
});
