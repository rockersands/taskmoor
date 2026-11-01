import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type FuzzTarget, inputAt, mutateText, runFuzz, textInput } from './fuzz';
import { runWatched } from './fuzz-run';
import { Rng } from './gen/rng';

/** A target with a planted bug: inputs holding a `!` break its invariant. */
const planted: FuzzTarget<string> = {
  name: 'planted',
  description: 'refuses "!"',
  seeds: () => ['hello world', 'a(b)c'],
  generate: (rng, seeds) => textInput(rng, seeds, ['!', '(', ')', ' ']),
  check: (s) => (s.includes('!') ? { problem: 'found a !' } : s.length > 10 ? 'long' : 'short'),
  show: (s) => s,
};

describe('fuzz harness (M1-118)', () => {
  it('[NFR-008] finds a planted bug, once per distinct problem, and counts outcomes', async () => {
    const report = await runFuzz(planted, { seed: 3, seconds: 10, inputs: 2_000 });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.input).toContain('!');
    expect(report.inputs).toBeGreaterThan(0);
    expect(Object.keys(report.outcomes).sort()).toEqual(['long', 'short']);
  });

  it('[NFR-008] rebuilds any input of a run from its seed and index', async () => {
    const report = await runFuzz(planted, { seed: 9, seconds: 10, inputs: 500 });
    const failure = report.failures[0];
    if (!failure) throw new Error('expected the planted bug');
    expect(await inputAt(planted, 9, failure.index)).toBe(failure.input);
  });

  it('[NFR-008] reports a throwing check as a failure, not a crash', async () => {
    const throwing: FuzzTarget<string> = {
      ...planted,
      check: () => {
        throw new TypeError('boom');
      },
    };
    const report = await runFuzz(throwing, { seed: 1, seconds: 5, inputs: 10 });
    expect(report.failures[0]?.problem).toBe('the check threw TypeError: boom');
  });

  it('[NFR-008] mutates deterministically', () => {
    const a = new Rng(5);
    const b = new Rng(5);
    const run = (r: Rng) =>
      Array.from({ length: 50 }, () => mutateText(r, 'abc(def)', ['x'], ['zz']));
    expect(run(a)).toEqual(run(b));
  });

  it('[NFR-008] stops a target that hangs and names the input', async () => {
    const module = fileURLToPath(new URL('./__fixtures__/fuzz-targets.ts', import.meta.url));
    const report = await runWatched({
      module,
      target: 'hangs',
      seed: 4,
      seconds: 60,
      hangSeconds: 2,
    });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ index: 4, problem: 'no answer after 2 s (hang)' });
    expect(report.failures[0]?.input).toMatch(/^\d+$/);
  }, 30_000);
});
