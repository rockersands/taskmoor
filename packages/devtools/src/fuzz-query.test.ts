import { Rng } from '@taskmoor/testkit/gen';
import { describe, expect, it } from 'vitest';
import { checkQueryInput, corpus, fuzzQueryParser, generate } from './fuzz-query';

describe('query parser fuzzer', () => {
  it('[QRY-001] accepts every conformance query and a few broken ones', () => {
    const seeds = corpus();
    expect(seeds.length).toBeGreaterThan(1000);
    for (const text of [...seeds.slice(0, 200), '', '(', 'a = "x', 'NOT NOT', ') ]', '\u0000']) {
      expect(checkQueryInput(text), text).toBeUndefined();
    }
  });

  it('[QRY-001] generates the same inputs for the same seed', () => {
    const seeds = corpus();
    const a = new Rng(7);
    const b = new Rng(7);
    expect(Array.from({ length: 50 }, () => generate(a, seeds))).toEqual(
      Array.from({ length: 50 }, () => generate(b, seeds)),
    );
  });

  it('[QRY-001] finds no failure in a short run (the hour-long run is pnpm fuzz query --minutes 60)', () => {
    const report = fuzzQueryParser({ seed: 1, seconds: 20, inputs: 5_000 });
    expect(report.failures).toEqual([]);
    expect(report.inputs).toBe(5_000);
    expect(report.valid).toBeGreaterThan(0);
    expect(report.invalid).toBeGreaterThan(0);
  });
});
