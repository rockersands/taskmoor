import { describe, expect, it } from 'vitest';
import type { ReportEvent } from './events';
import { type ScopeInput, scopeBurndown, scopeByDay } from './scope-burndown';

/**
 * Release and outcome burndowns from a hand-built month (M1-062; RPT-001): three sprints of a
 * board estimating in points; a release gains, loses and re-estimates work, and a done ticket is
 * reopened. Every number below was worked out by hand from the events.
 */
const POINTS = 10;
const RELEASE = 50;
const OUTCOME = 900;
const NEW = 1;
const CLOSED = 3;
let seq = 0;
const field = (ticketId: number, when: string, name: string, to: string | null): ReportEvent => ({
  kind: 'field',
  ticketId,
  at: new Date(`${when}:00Z`),
  seq: String(++seq),
  field: name,
  to,
});
const created = (
  ticketId: number,
  when: string,
  points: number,
  release: boolean,
  parent: number | null = null,
) => [
  field(ticketId, when, 'status', String(NEW)),
  field(ticketId, when, `cf[${POINTS}]`, String(points)),
  ...(release ? [field(ticketId, when, 'targetRelease', String(RELEASE))] : []),
  ...(parent === null ? [] : [field(ticketId, when, 'parent', String(parent))]),
];
const close = (ticketId: number, when: string) => field(ticketId, when, 'status', String(CLOSED));

const MONTH: ReportEvent[] = [
  ...created(1, '2026-10-01T10:00', 5, true, OUTCOME),
  ...created(2, '2026-10-01T10:00', 3, true),
  ...created(3, '2026-10-01T10:00', 8, true),
  ...created(5, '2026-10-01T10:00', 13, false),
  ...created(6, '2026-10-01T10:00', 4, true),
  ...created(7, '2026-10-01T10:00', 1, true),
  ...created(9, '2026-10-01T10:00', 2, true),
  close(7, '2026-10-02T10:00'),
  // Sprint 1, 5 to 9 October: starts with 22 remaining.
  field(6, '2026-10-06T10:00', 'targetRelease', '51'),
  close(1, '2026-10-07T10:00'),
  ...created(4, '2026-10-08T10:00', 2, true, OUTCOME),
  // Between sprints: the next one starts with it.
  ...created(8, '2026-10-10T10:00', 6, true),
  // Sprint 2, 12 to 16 October.
  field(3, '2026-10-13T10:00', `cf[${POINTS}]`, '5'),
  field(7, '2026-10-13T11:00', 'status', String(NEW)),
  close(2, '2026-10-14T10:00'),
  field(5, '2026-10-15T10:00', 'targetRelease', `${RELEASE},52`),
  // Sprint 3, from 19 October, still running.
  close(3, '2026-10-20T10:00'),
  close(9, '2026-10-21T11:00'),
];

const SPRINTS = [
  {
    id: 1,
    startedAt: new Date('2026-10-05T09:00:00Z'),
    completedAt: new Date('2026-10-09T17:00:00Z'),
  },
  {
    id: 2,
    startedAt: new Date('2026-10-12T09:00:00Z'),
    completedAt: new Date('2026-10-16T17:00:00Z'),
  },
  { id: 3, startedAt: new Date('2026-10-19T09:00:00Z'), completedAt: null },
];

const base = (member: ScopeInput['member']): ScopeInput => ({
  member,
  estimation: { statistic: 'field', fieldId: POINTS },
  burnRemaining: false,
  done: new Set([CLOSED]),
  events: MONTH,
  now: new Date('2026-10-21T12:00:00Z'),
});
const inRelease = base((s) => s.targetReleases.has(RELEASE));
const row = (w: {
  start: number;
  completed: number;
  added: number;
  removed: number;
  end: number;
}) => [w.start, w.completed, w.added, w.removed, w.end];

describe('release and outcome burndowns (M1-062)', () => {
  it('[RPT-001] follows a release sprint by sprint: completed, added, removed', () => {
    const report = scopeBurndown({ ...inRelease, sprints: SPRINTS });
    expect(report.sprints.map(row)).toEqual([
      // 22 - 5 + 2 - 4 = 15: ticket 6 left, 1 closed, 4 joined.
      [22, 5, 2, 4, 15],
      // 21 (ticket 8 joined between) - 3 + 14 - 3 = 29: 3 lost 3 points, 7 reopened, 5 joined.
      [21, 3, 14, 3, 29],
      [29, 7, 0, 0, 22],
    ]);
    expect(report.now).toEqual({ scope: 37, completed: 15, remaining: 22 });
    // Two completed sprints: (5 + 3) / 2 = 4 a sprint, so 22 needs 6 more.
    expect(report.velocity).toBe(4);
    expect(report.forecast).toBe(6);
  });

  it('[RPT-001] follows an outcome by the tickets under it', () => {
    const report = scopeBurndown({
      ...base((s) => s.parentId === OUTCOME),
      sprints: SPRINTS,
    });
    expect(report.sprints.map(row)).toEqual([
      [5, 5, 2, 0, 2],
      [2, 0, 0, 0, 2],
      [2, 0, 0, 0, 2],
    ]);
    // Five in two sprints: 2.5 a sprint, one more for the last 2.
    expect([report.velocity, report.forecast]).toEqual([2.5, 1]);
    // Without a completed sprint there is no pace yet.
    const early = scopeBurndown({
      ...inRelease,
      sprints: SPRINTS.slice(0, 1).map((s) => ({ ...s, completedAt: null })),
    });
    expect([early.velocity, early.forecast]).toEqual([0, null]);
  });

  it('[RPT-001] reports a release day by day, with a date at the recent pace', () => {
    const report = scopeByDay({ ...inRelease, from: '2026-10-05', timeZone: 'UTC' });
    expect(report.days.map((d) => `${d.date.slice(5)} ${d.scope}/${d.completed}`)).toEqual([
      '10-05 23/1',
      '10-06 19/1',
      '10-07 19/6',
      '10-08 21/6',
      '10-09 21/6',
      '10-10 27/6',
      '10-11 27/6',
      '10-12 27/6',
      '10-13 24/5',
      '10-14 24/8',
      '10-15 37/8',
      '10-16 37/8',
      '10-17 37/8',
      '10-18 37/8',
      '10-19 37/8',
      '10-20 37/13',
      '10-21 37/15',
    ]);
    // 15 - 6 completed over the last 14 days: 22 left takes 35 more days.
    expect(report.pace).toBeCloseTo(9 / 14, 9);
    expect(report.forecast).toBe('2026-11-25');
  });
});
