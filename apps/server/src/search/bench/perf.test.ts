import { makeCatalogue, parseQuery, resolveQuery } from '@taskmoor/query';
import { describe, expect, it } from 'vitest';
import { type BenchNames, instantiate, PERF_QUERIES, timed } from './perf';

const NAMES: BenchNames = {
  A: 'AA',
  B: 'AB',
  other: '17',
  label: 'infra',
  label2: 'ui',
  word: 'login',
  word2: 'page',
  rare: 'zebra',
  number: 'Size',
  option: 'Team',
  optionValue: 'Red',
  optionValue2: 'Blue',
  date: 'Review',
  user: 'Reviewer',
  multi: 'Tags',
  multiA: 'A',
  multiB: 'B',
  labelsField: 'Topics',
  labelsValue: 'alpha',
  text: 'Notes',
  textWord: 'cookie',
  parent: 'AA-1',
  k1: 'AA-2',
  k2: 'AA-3',
  k3: 'AB-4',
};

describe('search perf set (M1-037)', () => {
  it('[NFR-001] holds 50 distinct queries that the language accepts', () => {
    expect(PERF_QUERIES).toHaveLength(50);
    expect(new Set(PERF_QUERIES.map((q) => q.id)).size).toBe(50);
    const catalogue = makeCatalogue(
      [
        { kind: 'custom', id: 1, name: 'Size', type: 'number' },
        { kind: 'custom', id: 2, name: 'Team', type: 'option' },
        { kind: 'custom', id: 3, name: 'Review', type: 'date' },
        { kind: 'custom', id: 4, name: 'Reviewer', type: 'user' },
        { kind: 'custom', id: 5, name: 'Tags', type: 'multi' },
        { kind: 'custom', id: 6, name: 'Topics', type: 'labels' },
        { kind: 'custom', id: 7, name: 'Notes', type: 'text' },
      ],
      { AA: 1, AB: 2 },
    );
    for (const q of PERF_QUERIES) {
      const plan = resolveQuery(parseQuery(instantiate(q.text, NAMES)), catalogue, {
        currentUserId: 1,
        now: new Date('2026-10-01T00:00:00Z'),
      });
      expect(plan, q.id).toBeDefined();
      // No history operator: those have their own budget (M1-039).
      expect(JSON.stringify(plan), q.id).not.toContain('"kind":"history"');
    }
    // A second page follows the query it continues.
    PERF_QUERIES.forEach((q, i) => {
      if (q.page === 2) expect(PERF_QUERIES[i - 1]?.text).toBe(q.text);
    });
  });

  it('reads percentiles as the nearest rank', () => {
    expect(timed([5, 1, 3, 2, 4])).toEqual({ runs: 5, p50: 3, p95: 5, max: 5 });
    expect(timed(Array.from({ length: 20 }, (_, i) => i + 1)).p95).toBe(19);
  });
});
