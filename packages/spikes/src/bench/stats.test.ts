import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { percentile, summarize, timingsTable } from './stats';

describe('percentile', () => {
  it('uses nearest rank, so p95 of 20 samples is the 19th', () => {
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(10);
    expect(percentile(sorted, 95)).toBe(19);
    expect(percentile(sorted, 100)).toBe(20);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNaN();
  });

  it('never leaves the sample range and is monotonic in p', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 50 }),
        (samples) => {
          const sorted = [...samples].sort((a, b) => a - b);
          let last = Number.NEGATIVE_INFINITY;
          for (const p of [1, 10, 50, 90, 95, 99, 100]) {
            const v = percentile(sorted, p);
            expect(v).toBeGreaterThanOrEqual(sorted[0] as number);
            expect(v).toBeLessThanOrEqual(sorted[sorted.length - 1] as number);
            expect(v).toBeGreaterThanOrEqual(last);
            last = v;
          }
        },
      ),
    );
  });
});

describe('summarize and timingsTable', () => {
  it('rounds to hundredths and renders a Markdown table', () => {
    const t = summarize('open item', [1.234, 5.678, 2.5]);
    expect(t).toEqual({ name: 'open item', runs: 3, p50: 2.5, p95: 5.68, max: 5.68, mean: 3.14 });
    expect(timingsTable([t])).toBe(
      '| Query | Runs | p50 ms | p95 ms | Max ms |\n|---|---:|---:|---:|---:|\n| open item | 3 | 2.5 | 5.68 | 5.68 |',
    );
  });
});
