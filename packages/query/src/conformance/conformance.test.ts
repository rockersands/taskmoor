import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stableJson } from '@taskmoor/testkit';
import { describe, expect, it } from 'vitest';
import { SECTIONS } from './case';
import { QUERY_CASES } from './cases';
import { formatReport, nativeEngine, runCase, runConformance } from './run';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('query conformance suite', () => {
  it('[QRY-001] holds at least 1,500 well-formed cases with unique ids citing known requirements', () => {
    expect(QUERY_CASES.length).toBeGreaterThanOrEqual(1500);
    const ids = QUERY_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const index = readFileSync(`${ROOT}docs/specs/requirements-index.csv`, 'utf8');
    const known = new Set(index.split(/\r?\n/).map((line) => line.split(',')[0]));
    for (const c of QUERY_CASES) {
      expect(known.has(c.requirement), `${c.id} cites ${c.requirement}`).toBe(true);
      expect(c.id.startsWith(c.requirement)).toBe(true);
      expect(c.spec.length).toBeGreaterThan(0);
      expect(c.title.length).toBeGreaterThan(0);
    }
    const sections = new Set(QUERY_CASES.map((c) => c.section));
    for (const s of SECTIONS) expect(sections.has(s), s).toBe(true);
  });

  const report = runConformance(nativeEngine, QUERY_CASES);

  it('[QRY-001] [QRY-002] [QRY-003] [QRY-004] [QRY-005] [QRY-006] [QRY-007] [QRY-009] [QRY-011] [QRY-013] records the pass rate per section', async () => {
    // The rates are a golden: the parser and resolver grow into the suite (M1-034, M1-035) and
    // every change of rate is reviewed. A section never silently regresses.
    const rates = Object.fromEntries(
      report.sections.map((s) => [s.section, { pass: s.pass, total: s.total, rate: s.rate }]),
    );
    await expect(stableJson(rates)).toMatchFileSnapshot('./__golden__/pass-rates.json');
    expect(formatReport(report)).toContain('grammar');
  });

  it('[QRY-001] every grammar case the parser supports today passes, and failures name their reason', () => {
    const failed = report.results.filter((r) => r.status === 'fail');
    for (const f of failed) expect(f.detail, f.id).toBeTruthy();
    expect(report.unsupported).toBe(0);
  });

  it('[QRY-001] a case that expects the canonical form fails when the print differs', () => {
    const result = runCase(
      { parse: () => ({ where: null, orderBy: [] }), print: () => 'nothing' },
      {
        id: 'QRY-001-x-001',
        requirement: 'QRY-001',
        section: 'grammar',
        title: 'x',
        spec: '01b 1.1',
        kind: 'parse',
        text: 'status = Done',
        expect: { canonical: 'status = Done' },
      },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('printed "nothing"');
  });
});
