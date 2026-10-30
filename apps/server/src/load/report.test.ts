import { describe, expect, it } from 'vitest';
import { coresFor, type LoadData, rateFor, renderReport, type TierResult } from './report';

const tier = (users: number, over: Partial<TierResult> = {}): TierResult => ({
  users,
  seconds: 150,
  k6Exit: 0,
  requests: users * 12,
  requestsPerSecond: users / 10,
  errorRate: 0,
  p95: {
    open_ticket: 40,
    search: 120,
    board: 600,
    history: 30,
    edit: 90,
    comment: 80,
    create: 150,
  },
  p50: {},
  serverCpuSeconds: users * 12 * 0.004,
  postgresCpuSeconds: users * 12 * 0.002,
  serverPeakRssMb: 300,
  ...over,
});

const data = (tiers: TierResult[]): LoadData => ({
  label: 'test',
  at: '2026-10-30T15:00:00Z',
  items: 100_000,
  hold: '2m',
  ramp: '30s',
  machine: { cpus: 10, cpuModel: 'Test CPU', memoryGb: 32, platform: 'darwin/arm64' },
  tiers,
});

describe('load test report (M1-104)', () => {
  it('[NFR-003] sizes cores for 60% use from the CPU each request takes', () => {
    expect(coresFor(100, 0.004)).toBe(1);
    expect(coresFor(300, 0.004)).toBe(2);
    expect(coresFor(0, 0.004)).toBe(1);
    expect(rateFor(1000, tier(500))).toBe(100);
  });

  it('[NFR-003] tables every tier against its targets and marks what is over', () => {
    const report = renderReport(
      data([tier(50), tier(500), tier(2000, { p95: { ...tier(0).p95, search: 450 } })]),
    );
    expect(report).toContain('| p95 (ms) | Target | 50 people | 500 people | 2,000 people |');
    expect(report).toContain(
      '| Search (track, status, order) | 300 | 120 | 120 | **450** (over) |',
    );
    expect(report).toContain('Over target: Search (track, status, order) at 2,000 people.');
    // The sizing rows come from the busiest tier.
    expect(report).toMatch(/\| 2,000 \| 200\.0 \| \d+ cores, \d+ GB \| \d+ cores, \d+ GB \|/);
  });

  it('[NFR-003] says when every target was met', () => {
    expect(renderReport(data([tier(50)]))).toContain('Every p95 target was met at every tier.');
  });
});
