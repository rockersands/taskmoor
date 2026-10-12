import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ReferenceEngine } from '../reference';
import { SECTIONS } from './case';
import { WORKFLOW_CASES } from './cases';
import { formatReport, runConformance } from './run';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('workflow conformance suite', () => {
  it('[WF-001] holds at least 300 cases with unique ids, each citing a known WF requirement', () => {
    expect(WORKFLOW_CASES.length).toBeGreaterThanOrEqual(300);
    const ids = WORKFLOW_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const index = readFileSync(`${ROOT}docs/specs/requirements-index.csv`, 'utf8');
    const known = new Set(index.split(/\r?\n/).map((line) => line.split(',')[0]));
    for (const c of WORKFLOW_CASES) {
      expect(known.has(c.requirement), `${c.id} cites ${c.requirement}`).toBe(true);
      expect(c.id.startsWith(c.requirement), `${c.id} starts with its requirement`).toBe(true);
      expect(c.spec.length).toBeGreaterThan(0);
      expect(c.title.length).toBeGreaterThan(0);
    }
  });

  it('[WF-001] covers every section and every M1 WF requirement', () => {
    const sections = new Set(WORKFLOW_CASES.map((c) => c.section));
    for (const s of SECTIONS) expect(sections.has(s), s).toBe(true);
    const cited = new Set(WORKFLOW_CASES.map((c) => c.requirement));
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(cited.has(`WF-${String(n).padStart(3, '0')}`)).toBe(true);
    }
  });

  const report = runConformance(new ReferenceEngine(), WORKFLOW_CASES);
  const requirementsOf = (section: string) =>
    [
      ...new Set(
        WORKFLOW_CASES.filter((c) => c.section === section).map((c) => `[${c.requirement}]`),
      ),
    ].join(' ');

  for (const section of SECTIONS) {
    it(`${requirementsOf(section)} ${section} cases pass on the reference model`, () => {
      const own = report.results.filter((r) => r.section === section);
      expect(own.length).toBeGreaterThan(0);
      const failures = own.filter((r) => r.status !== 'pass');
      expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
    });
  }

  it('[WF-001] prints one line per section', () => {
    const text = formatReport(report);
    for (const s of SECTIONS) expect(text).toContain(s);
    expect(text).toContain('all');
  });
});
