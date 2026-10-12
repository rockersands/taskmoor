import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatGate, type GateInputs, loadGateInputs, m0Gate, runGate } from './gate';

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

  it('reads the real repository and refuses unknown milestones', () => {
    const inputs = loadGateInputs(ROOT, 'M0');
    expect(runGate(inputs).length).toBe(8);
    expect(() => runGate({ ...inputs, milestone: 'M9' })).toThrow(/No gate defined for M9/);
  });
});
