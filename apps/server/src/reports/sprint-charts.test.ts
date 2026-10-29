import { describe, expect, it } from 'vitest';
import type { ReportEvent, SprintChangeKind } from './events';
import { type ChartInput, sprintChart } from './sprint-charts';

/**
 * Burndown and burnup from a hand-built week (M1-060; RPT-001 (1)): every number below was
 * worked out by hand from the events, day by day, including scope added and removed after the
 * start, an estimate changed, a ticket reopened, and the completion.
 */
const SPRINT = 7;
const POINTS = 10;
const NEW = 1;
const ACTIVE = 2;
const CLOSED = 3;
let seq = 0;
const at = (iso: string) => new Date(iso);
const field = (ticketId: number, when: string, name: string, to: string | null): ReportEvent => ({
  kind: 'field',
  ticketId,
  at: at(when),
  seq: String(++seq),
  field: name,
  to,
});
const sprint = (
  ticketId: number,
  when: string,
  change: SprintChangeKind,
  sprintId = SPRINT,
): ReportEvent => ({
  kind: 'sprint',
  ticketId,
  at: at(when),
  seq: String(++seq),
  sprintId,
  change,
  afterStart: false,
  toSprintId: null,
  originalEstimate: null,
  remainingEstimate: null,
  points: null,
});
const created = (
  ticketId: number,
  when: string,
  points: number | null,
  extra: ReportEvent[] = [],
) => [
  field(ticketId, when, 'status', String(NEW)),
  ...(points === null ? [] : [field(ticketId, when, `cf[${POINTS}]`, String(points))]),
  ...extra,
];

// Monday 5 October to Friday 9 October 2026 (UTC), points as the statistic.
const WEEK: ReportEvent[] = [
  ...created(1, '2026-10-01T10:00:00Z', 5),
  ...created(2, '2026-10-01T10:00:00Z', 3),
  ...created(3, '2026-10-01T10:00:00Z', 8),
  ...created(4, '2026-10-01T10:00:00Z', 2),
  ...created(5, '2026-10-01T10:00:00Z', 13),
  sprint(1, '2026-10-02T10:00:00Z', 'added'),
  sprint(2, '2026-10-02T10:00:00Z', 'added'),
  sprint(3, '2026-10-02T10:00:00Z', 'added'),
  // In another sprint: never counts here.
  sprint(5, '2026-10-02T10:00:00Z', 'added', 8),
  // The start, Monday 09:00: 5 + 3 + 8 = 16.
  sprint(1, '2026-10-05T09:00:00Z', 'committed'),
  sprint(2, '2026-10-05T09:00:00Z', 'committed'),
  sprint(3, '2026-10-05T09:00:00Z', 'committed'),
  field(1, '2026-10-05T15:00:00Z', 'status', String(CLOSED)),
  field(4, '2026-10-06T12:00:00Z', 'status', String(ACTIVE)),
  sprint(4, '2026-10-06T12:00:00Z', 'added'),
  field(3, '2026-10-07T10:00:00Z', `cf[${POINTS}]`, '5'),
  field(2, '2026-10-07T16:00:00Z', 'status', String(CLOSED)),
  field(2, '2026-10-08T09:00:00Z', 'status', String(ACTIVE)),
  sprint(3, '2026-10-08T11:00:00Z', 'removed'),
  // Outside the sprint: changes nothing.
  field(5, '2026-10-08T12:00:00Z', `cf[${POINTS}]`, '21'),
  field(4, '2026-10-09T12:00:00Z', 'status', String(CLOSED)),
  // The completion, Friday 17:00.
  sprint(1, '2026-10-09T17:00:00Z', 'completed'),
  sprint(4, '2026-10-09T17:00:00Z', 'completed'),
  sprint(2, '2026-10-09T17:00:00Z', 'carried_over'),
  // After the end: not part of the chart.
  field(2, '2026-10-10T09:00:00Z', 'status', String(CLOSED)),
];

const input = (over: Partial<ChartInput> = {}): ChartInput => ({
  sprintId: SPRINT,
  startedAt: at('2026-10-05T09:00:00Z'),
  endAt: at('2026-10-09T17:00:00Z'),
  completedAt: at('2026-10-09T17:00:00Z'),
  estimation: { statistic: 'field', fieldId: POINTS },
  burnRemaining: false,
  done: new Set([CLOSED]),
  events: WEEK,
  now: at('2026-10-12T09:00:00Z'),
  timeZone: 'UTC',
  ...over,
});

describe('sprint burndown and burnup (M1-060)', () => {
  it('[RPT-001] matches the hand-computed week, day by day, with scope added and removed after the start', () => {
    const chart = sprintChart(input());
    expect(chart.dates).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ]);
    expect(chart.start).toEqual({ at: '2026-10-05T09:00:00.000Z', remaining: 16, scope: 16 });
    expect(chart.guideline).toEqual({
      from: { at: '2026-10-05T09:00:00.000Z', date: '2026-10-05', value: 16 },
      to: { at: '2026-10-09T17:00:00.000Z', date: '2026-10-09', value: 0 },
    });
    expect(
      chart.steps.map((s) => [
        s.at.slice(0, 16),
        s.ticketId,
        s.cause,
        s.remaining,
        s.scope,
        s.completed,
      ]),
    ).toEqual([
      ['2026-10-05T15:00', 1, 'completed', 11, 16, 5],
      ['2026-10-06T12:00', 4, 'added', 13, 18, 5],
      ['2026-10-07T10:00', 3, 'estimate', 10, 15, 5],
      ['2026-10-07T16:00', 2, 'completed', 7, 15, 8],
      ['2026-10-08T09:00', 2, 'reopened', 10, 15, 5],
      ['2026-10-08T11:00', 3, 'removed', 5, 10, 5],
      ['2026-10-09T12:00', 4, 'completed', 3, 10, 7],
    ]);
    expect(chart.days).toEqual([
      { date: '2026-10-05', remaining: 11, scope: 16, completed: 5 },
      { date: '2026-10-06', remaining: 13, scope: 18, completed: 5 },
      { date: '2026-10-07', remaining: 7, scope: 15, completed: 8 },
      { date: '2026-10-08', remaining: 5, scope: 10, completed: 5 },
      { date: '2026-10-09', remaining: 3, scope: 10, completed: 7 },
    ]);
    expect(chart.end).toEqual({
      at: '2026-10-09T17:00:00.000Z',
      remaining: 3,
      scope: 10,
      completed: 7,
    });
  });

  it('[RPT-001] counts days on the viewer’s time zone', () => {
    // UTC+14: the start (09:00 UTC) is 23:00 there, so Monday ends untouched; the first close
    // (15:00 UTC) falls on Tuesday; Friday's last close is Saturday 02:00 there.
    const chart = sprintChart(input({ timeZone: 'Pacific/Kiritimati' }));
    expect(chart.days.map((d) => [d.date, d.remaining])).toEqual([
      ['2026-10-05', 16],
      ['2026-10-06', 11],
      ['2026-10-07', 13],
      ['2026-10-08', 10],
      ['2026-10-09', 5],
      ['2026-10-10', 3],
    ]);
  });

  it('[RPT-001] counts tickets, or burns the remaining estimate when time is tracked', () => {
    const count = sprintChart(input({ estimation: { statistic: 'ticketCount' } }));
    expect(count.start).toMatchObject({ remaining: 3, scope: 3 });
    expect(count.end).toMatchObject({ remaining: 1, scope: 3, completed: 2 });
    const hours: ReportEvent[] = [
      field(21, '2026-10-01T10:00:00Z', 'status', String(NEW)),
      field(21, '2026-10-01T10:00:00Z', 'originalEstimate', String(10 * 3600)),
      field(21, '2026-10-01T10:00:00Z', 'remainingEstimate', String(10 * 3600)),
      sprint(21, '2026-10-02T10:00:00Z', 'added'),
      field(21, '2026-10-06T10:00:00Z', 'timeSpent', String(4 * 3600)),
      field(21, '2026-10-06T10:00:00Z', 'remainingEstimate', String(6 * 3600)),
    ];
    const burned = sprintChart(
      input({ events: hours, estimation: { statistic: 'originalEstimate' }, burnRemaining: true }),
    );
    expect(burned.days.map((d) => d.remaining / 3600)).toEqual([10, 6, 6, 6, 6]);
    const plain = sprintChart(
      input({ events: hours, estimation: { statistic: 'originalEstimate' } }),
    );
    expect(plain.days.map((d) => d.remaining / 3600)).toEqual([10, 10, 10, 10, 10]);
  });

  it('[RPT-001] runs to now while the sprint is active', () => {
    const chart = sprintChart(input({ completedAt: null, now: at('2026-10-07T12:00:00Z') }));
    expect(chart.days.map((d) => d.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
    // The axis still runs to the planned end.
    expect(chart.dates.at(-1)).toBe('2026-10-09');
    expect(chart.end).toEqual({
      at: '2026-10-07T12:00:00.000Z',
      remaining: 10,
      scope: 15,
      completed: 5,
    });
  });
});
