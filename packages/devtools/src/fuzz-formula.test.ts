import { Rng } from '@taskmoor/testkit/gen';
import { describe, expect, it } from 'vitest';
import { checkFormulaInput, corpus, fuzzFormulas, generate } from './fuzz-formula';

describe('formula fuzzer', () => {
  it('[CORE-011] accepts every conformance formula and a few broken ones', () => {
    const seeds = corpus();
    expect(seeds.length).toBeGreaterThan(100);
    const rng = new Rng(3);
    for (const text of [...seeds, '', '(', '{', '"', '1 +', 'children.', '\u0000', 'sum(']) {
      expect(checkFormulaInput(text, rng), text.slice(0, 80)).toBeUndefined();
    }
  });

  it('[CORE-011] generates the same inputs for the same seed', () => {
    const seeds = corpus();
    const a = new Rng(7);
    const b = new Rng(7);
    expect(Array.from({ length: 50 }, () => generate(a, seeds))).toEqual(
      Array.from({ length: 50 }, () => generate(b, seeds)),
    );
  });

  it('[CORE-011] finds no failure in a short run (the hour-long run is pnpm fuzz formula --minutes 60)', () => {
    const report = fuzzFormulas({ seed: 1, seconds: 20, inputs: 3_000 });
    expect(report.failures).toEqual([]);
    expect(report.inputs).toBe(3_000);
    expect(report.valid).toBeGreaterThan(300);
    expect(report.invalid).toBeGreaterThan(300);
  });
});
