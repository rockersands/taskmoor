import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FUZZ_GATE_SECONDS,
  formatGate,
  type GateInputs,
  loadGateInputs,
  m0Gate,
  runGate,
  type ScanRecord,
} from './gate';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const index = (statuses: Record<string, string>) =>
  Array.from({ length: 33 }, (_, i) => String(i + 1).padStart(3, '0'))
    .map((n) => `| [${n}](${n}-x.md) | Title ${n} | ${statuses[n] ?? 'Accepted'} |`)
    .join('\n');

const green: GateInputs = {
  milestone: 'M0',
  adrIndex: index({}),
  progress: [{ id: 'M0-028', state: 'done', date: '2026-10-20', note: 'matrix green' }],
  decisions: [
    {
      Decision: 'Counsel review of the clean-room protocol',
      "Claude's recommendation": 'Decided: reviewed',
    },
    { Decision: 'M0 acceptance', "Claude's recommendation": 'Decided by the user on 2026-10-21' },
  ],
  results: {
    'query-compiler': { items: 10_000_000, queries: [{ id: 'a', p95: 120 }] },
    authz: { candidates: [{ id: 'inprocess-cold', check: { p95: 2 } }] },
  },
  verifySummary: {
    ok: true,
    at: '2026-10-21T00:00:00Z',
    results: [{ id: 'tests', headline: '300 passed' }],
  },
  ci: { conclusion: 'success', title: 'Finish M0' },
  workflows: ['ci.yml', 'nightly.yml'],
  ciBaselineFiles: 5,
};

describe('M0 gate', () => {
  it('is all green when every criterion holds', () => {
    const checks = m0Gate(green);
    expect(checks.every((c) => c.state === 'ok')).toBe(true);
    expect(formatGate('M0', checks)).toContain('M0 gate: all green.');
  });

  it('fails on a proposed ADR, a missed budget, a small dataset and a red CI run', () => {
    const checks = m0Gate({
      ...green,
      adrIndex: index({ '010': 'Proposed' }),
      results: {
        'query-compiler': { items: 1_000_000, queries: [{ id: 'slow', p95: 450 }] },
      },
      ci: { conclusion: 'failure', title: 'Broke it' },
    });
    const failing = checks.filter((c) => c.state === 'fail').map((c) => c.name);
    expect(failing).toEqual([
      'ADR-001 to ADR-033 accepted',
      'Spike budgets met at 10M items',
      'CI green on main (PostgreSQL 16, scans)',
    ]);
    expect(checks[0]?.detail).toBe('not accepted: 010');
    expect(checks[1]?.detail).toContain('slow p95 is 450 ms, budget 300');
  });

  it('does not count a narrowed verify run as the gate', () => {
    const checks = m0Gate({
      ...green,
      verifySummary: { ok: true, at: '2026-10-21T00:00:00Z', partial: true, results: [] },
    });
    const local = checks.find((c) => c.name.startsWith('pnpm verify green locally'));
    expect(local?.state).toBe('fail');
    expect(local?.detail).toContain('narrowed');
  });

  it('shows the install matrix task state while it is in progress', () => {
    const checks = m0Gate({
      ...green,
      progress: [
        { id: 'M0-028', state: 'in-progress', date: '2026-10-12', note: 'first run pending' },
      ],
    });
    const matrix = checks.find((c) => c.name.includes('M0-028'));
    expect(matrix?.state).toBe('waiting');
    expect(matrix?.detail).toBe('M0-028 in-progress: first run pending');
  });

  it('marks the human items as waiting rather than failing', () => {
    const checks = m0Gate({
      ...green,
      progress: [],
      decisions: [],
      workflows: ['ci.yml', 'nightly.yml'],
      ciBaselineFiles: 0,
    });
    const waiting = checks.filter((c) => c.state === 'waiting').map((c) => c.name);
    expect(waiting).toEqual([
      'Nightly benchmark job live with a CI baseline',
      'Backend skeleton installs in under 10 minutes on 5 OS images (M0-028)',
      'Counsel sign-off on the clean-room protocol recorded',
      'User acceptance of M0 recorded',
    ]);
    expect(formatGate('M0', checks)).toContain('0 failing, 4 waiting on the user.');
  });

  it('accepts a counsel review the user deferred to the first public release', () => {
    const checks = m0Gate({
      ...green,
      decisions: [
        {
          Decision: 'Counsel review of the clean-room protocol',
          "Claude's recommendation":
            'Deferred by the user on 2026-10-12 to the first public release',
        },
        { Decision: 'M0 acceptance', "Claude's recommendation": 'Decided by the user' },
      ],
    });
    const counsel = checks.find((c) => c.name.startsWith('Counsel'));
    expect(counsel?.state).toBe('ok');
    expect(counsel?.detail).toContain('deferred by the user');
  });

  it('reads the real repository and refuses unknown milestones', () => {
    const inputs = loadGateInputs(ROOT, 'M0');
    expect(runGate(inputs).length).toBe(8);
    expect(() => runGate({ ...inputs, milestone: 'M9' })).toThrow(/No gate defined for M9/);
  });

  it('[NFR-008] gates M1 on the scans, 24 h of fuzzing, the ASVS gaps and the live injection run', () => {
    const inputs = loadGateInputs(ROOT, 'M1');
    const security = inputs.security;
    if (!security) throw new Error('docs/security records are missing');
    const scan = (open: Partial<ScanRecord['open']>, ran = true): ScanRecord => ({
      scan: 'SAST',
      tool: 'semgrep',
      ran,
      at: '2026-10-31',
      open: { critical: 0, high: 0, medium: 0, low: 0, ...open },
    });
    const state = (records: Partial<typeof security>) =>
      Object.fromEntries(
        runGate({ ...inputs, security: { ...security, ...records } }).map((c) => [
          c.name.split(' (')[0],
          c.state,
        ]),
      );
    expect(state({ scans: [scan({ medium: 3 })] })['SAST scan']).toBe('ok');
    expect(state({ scans: [scan({ high: 1 })] })['SAST scan']).toBe('fail');
    expect(state({ scans: [scan({}, false)] })['SAST scan']).toBe('waiting');
    const fuzz = (seconds: number, failures = 0) => [
      { target: 'wiki', seconds, inputs: 1, failures },
    ];
    expect(state({ fuzz: fuzz(600) })['Fuzzers 24 h clean']).toBe('waiting');
    expect(state({ fuzz: fuzz(FUZZ_GATE_SECONDS) })['Fuzzers 24 h clean']).toBe('ok');
    expect(state({ fuzz: fuzz(FUZZ_GATE_SECONDS, 1) })['Fuzzers 24 h clean']).toBe('fail');
    expect(
      state({ asvs: '| 1.1.1 | x | Gap | y |' })[
        'ASVS 4.0.3 level 2 checklist without an open gap'
      ],
    ).toBe('waiting');
    expect(
      state({ asvs: '| 1.1.1 | x | Met | y |' })[
        'ASVS 4.0.3 level 2 checklist without an open gap'
      ],
    ).toBe('ok');
  });
});
