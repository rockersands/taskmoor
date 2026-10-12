import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintSpecs, loadRequirements, parseRequirements } from './specs';
import { formatTrace, trace, traceRepository } from './trace';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const ROW = (id: string, ms = 'M1', pri = 'M', criteria = '(1) It works.') =>
  `| ${id} | **Thing ${id}.** Taskmoor shall do it. | ${criteria} | ${ms} | ${pri} | Jira Free |`;

describe('the requirements spec', () => {
  it('passes spec lint: unique IDs, valid fields, numbered criteria, index in step', () => {
    expect(lintSpecs(REPO)).toEqual([]);
  });

  it('defines the requirements the plan counts on', () => {
    expect(loadRequirements(REPO).length).toBeGreaterThan(300);
  });

  it('has no test citing an unknown requirement', () => {
    expect(traceRepository(REPO).unknown).toEqual([]);
  });
});

describe('parseRequirements', () => {
  it('reads ID, bold title, milestone and priority from table rows only', () => {
    const md = [
      '| ID | Requirement | Acceptance criteria | MS | Pri | Source |',
      '|---|---|---|---|---|---|',
      ROW('CORE-001'),
      'Text mentioning CORE-002 is not a row.',
      ROW('WF-010', 'M2', 'S'),
    ].join('\n');
    expect(parseRequirements('x.md', md)).toEqual([
      { id: 'CORE-001', title: 'Thing CORE-001', milestone: 'M1', priority: 'M', file: 'x.md' },
      { id: 'WF-010', title: 'Thing WF-010', milestone: 'M2', priority: 'S', file: 'x.md' },
    ]);
  });
});

describe('spec lint on a broken fixture', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ts-specs-'));
    mkdirSync(join(dir, 'specs'));
    writeFileSync(
      join(dir, 'specs', 'a.md'),
      [ROW('CORE-001'), ROW('CORE-001'), ROW('CORE-002', 'M9', 'X', 'no numbers')].join('\n'),
    );
    writeFileSync(
      join(dir, 'specs', 'requirements-index.csv'),
      'ID,Module,Title,Milestone,Priority,Parity source\nCORE-001,CORE,T,M2,Must,x\nCORE-404,CORE,T,M1,Must,x\n',
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reports each problem', () => {
    const problems = lintSpecs(dir, 'specs');
    expect(problems).toEqual(
      expect.arrayContaining([
        'CORE-001 is defined twice (specs/a.md, specs/a.md)',
        'CORE-002: milestone "M9" is not M1-M4',
        'CORE-002: priority "X" is not M, S or C',
        'CORE-002: acceptance criteria are not numbered (1), (2), ...',
        'CORE-001: index says M2, spec says M1',
        'requirements-index.csv lists CORE-404, which no spec defines',
        'CORE-002 is missing from requirements-index.csv',
      ]),
    );
  });
});

describe('trace', () => {
  const requirements = [
    { id: 'CORE-001', title: 'A', milestone: 'M1', priority: 'M' as const, file: 'a.md' },
    { id: 'CORE-002', title: 'B', milestone: 'M1', priority: 'M' as const, file: 'a.md' },
    { id: 'SD-001', title: 'C', milestone: 'M2', priority: 'S' as const, file: 'b.md' },
  ];

  it('reports coverage per milestone and flags unknown citations', () => {
    const report = trace(requirements, [
      { id: 'CORE-001', file: 'x.test.ts' },
      { id: 'CORE-001', file: 'y.test.ts' },
      { id: 'NOPE-001', file: 'z.test.ts' },
    ]);
    expect(report.byMilestone).toEqual([
      { milestone: 'M1', covered: 1, total: 2 },
      { milestone: 'M2', covered: 0, total: 1 },
    ]);
    expect(formatTrace(report)).toBe(
      [
        'M1: 1/2 requirements cited by tests (50%)',
        'M2: 0/1 requirements cited by tests (0%)',
        'Unknown requirement NOPE-001 cited in z.test.ts',
      ].join('\n'),
    );
  });
});
