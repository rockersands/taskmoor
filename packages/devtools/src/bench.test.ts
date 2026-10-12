import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkBudgets,
  checkRegressions,
  formatBenchReport,
  loadResults,
  measurements,
  parseStem,
  resultSizes,
} from './bench';

const query = (p95s: Record<string, number>) => ({
  spike: 'query-compiler',
  queries: Object.entries(p95s).map(([id, p95]) => ({ id, p95 })),
});
const authz = (cold: number) => ({
  spike: 'authz',
  candidates: [
    { id: 'inprocess-cold', check: { p95: cold } },
    { id: 'openfga', check: { p95: 99 } },
  ],
});

describe('budgets', () => {
  it('[NFR-001] accept results inside every budget', () => {
    const results = {
      'query-compiler': query({ 'space-newest': 0.7, 'was-rare': 120 }),
      authz: authz(1.5),
      xml: { file: { bytes: 5e9 }, parse: { seconds: 150, maxRssMb: 300 } },
      queue: { candidates: [{ id: 'inhouse', jobsPerSecond: 18000 }] },
    };
    expect(checkBudgets(results)).toEqual([]);
    expect(measurements(results).map((m) => m.name)).toContain('minutes per 5 GB');
  });

  it('[NFR-001] name every measure over budget', () => {
    const problems = checkBudgets({
      'query-compiler': query({ 'space-newest': 0.7, 'was-rare': 301 }),
      authz: authz(10.5),
      xml: { file: { bytes: 2.5e9 }, parse: { seconds: 700, maxRssMb: 600 } },
      queue: { candidates: [{ id: 'inhouse', jobsPerSecond: 900 }] },
    });
    expect(problems.map((p) => p.name)).toEqual([
      'was-rare p95',
      'inprocess-cold check p95',
      'inhouse drain',
      'minutes per 5 GB',
      'max RSS',
    ]);
    expect(problems[3]?.message).toContain('23.33 min, budget 20');
  });

  it('[QRY-008] allow the pre-filter to add at most 10 ms, however fast the query', () => {
    const results = {
      'authz-overhead': {
        rows: [
          { query: 'a', allowedShare: 0.1, unfilteredP95: 0.8, filteredP95: 2.1 },
          { query: 'c', allowedShare: 0.9, unfilteredP95: 0.56, filteredP95: 4.1 },
          { query: 'd', allowedShare: 0.9, unfilteredP95: 3, filteredP95: 1 },
          { query: 'b', allowedShare: 0.5, unfilteredP95: 40, filteredP95: 58 },
        ],
      },
    };
    const problems = checkBudgets(results);
    expect(problems.map((p) => p.name)).toEqual(['b @0.5 overhead']);
    expect(problems[0]?.message).toContain('18 ms, budget 10');
  });
});

describe('regressions', () => {
  const baseline = {
    'query-compiler': query({ 'space-newest': 10, 'mine-open': 100, children: 0.5 }),
    queue: { candidates: [{ id: 'inhouse', jobsPerSecond: 18000 }] },
  };

  it('[NFR-001] flag a 25% slowdown and a 25% throughput drop', () => {
    const problems = checkRegressions(
      {
        'query-compiler': query({ 'space-newest': 12.5, 'mine-open': 105, children: 0.9 }),
        queue: { candidates: [{ id: 'inhouse', jobsPerSecond: 13000 }] },
      },
      baseline,
    );
    expect(problems.map((p) => p.name)).toEqual(['space-newest p95', 'inhouse drain']);
    expect(problems[0]?.message).toContain('(+25%)');
  });

  it('ignore changes within tolerance, below the noise floor, or without a baseline', () => {
    const problems = checkRegressions(
      {
        'query-compiler': query({
          'space-newest': 11.9,
          'mine-open': 101,
          children: 1.5,
          extra: 500,
        }),
        authz: authz(1),
      },
      baseline,
    );
    expect(problems).toEqual([]);
  });
});

describe('result files', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tracksmith-bench-'));
    await writeFile(join(dir, 'query-compiler-200k.json'), JSON.stringify(query({ a: 1 })));
    await writeFile(join(dir, 'query-compiler-1m.json'), JSON.stringify(query({ a: 2 })));
    await writeFile(join(dir, 'authz.json'), JSON.stringify(authz(3)));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('split stems into spike and size', () => {
    expect(parseStem('query-compiler-200k')).toEqual({ spike: 'query-compiler', size: '200k' });
    expect(parseStem('xml-5g')).toEqual({ spike: 'xml', size: '5g' });
    expect(parseStem('authz-overhead-1m')).toEqual({ spike: 'authz-overhead', size: '1m' });
    expect(parseStem('authz')).toEqual({ spike: 'authz' });
  });

  it('pick the requested size, or the largest, per spike', () => {
    const largest = loadResults(dir) as { 'query-compiler': { queries: { p95: number }[] } };
    expect(largest['query-compiler'].queries[0]?.p95).toBe(2);
    const small = loadResults(dir, '200k') as { 'query-compiler': { queries: { p95: number }[] } };
    expect(small['query-compiler'].queries[0]?.p95).toBe(1);
    expect(Object.keys(loadResults(dir, '10m'))).toEqual(['authz']);
    expect(loadResults(join(dir, 'missing'))).toEqual({});
    // A baseline read at the sizes of the current results, spike by spike.
    expect(resultSizes(dir)).toEqual({ 'query-compiler': '1m' });
    const matched = loadResults(dir, { 'query-compiler': '200k' }) as {
      'query-compiler': { queries: { p95: number }[] };
    };
    expect(matched['query-compiler'].queries[0]?.p95).toBe(1);
  });

  it('render a report with the problems listed', () => {
    const results = { authz: authz(12) };
    const text = formatBenchReport(results, checkBudgets(results), 'No baseline.');
    expect(text).toContain('| authz | inprocess-cold check p95 | 12 ms |');
    expect(text).toContain('1 problem(s):');
  });
});
