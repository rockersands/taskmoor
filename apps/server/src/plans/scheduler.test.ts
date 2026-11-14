import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { dayNumber, type Period, periodsFrom } from './periods';
import {
  barDays,
  hundredths,
  isLate,
  type ScheduleInput,
  type ScheduleOutput,
  type SchedulePerson,
  type ScheduleTeam,
  type ScheduleTicket,
  schedule,
  scheduleBody,
} from './scheduler';

// Two-week periods from Monday 16 November 2026: 16-29 Nov, 30 Nov-13 Dec, 14-27 Dec, ...
const FROM = '2026-11-16';
const PERIODS = periodsFrom({ kind: 'weeks', weeks: 2, anchor: FROM }, FROM, 6);
const P1 = PERIODS[0] as Period;
const P2 = PERIODS[1] as Period;
const P3 = PERIODS[2] as Period;
const LAST = PERIODS[5] as Period;
const pts = (n: number) => n * 100;

const ticket = (id: number, extra: Partial<ScheduleTicket> = {}): ScheduleTicket => ({
  id,
  key: `SPA-${id}`,
  rank: `r${String(id).padStart(4, '0')}`,
  level: 0,
  typeId: 1,
  stage: 'new',
  assigneeId: 1,
  estimate: pts(10),
  start: null,
  due: null,
  sprint: null,
  inActiveSprint: false,
  releaseIds: [],
  release: null,
  personDraft: false,
  maySchedule: true,
  leftOutByQuery: false,
  keptByQuery: false,
  hiddenBlocker: false,
  ...extra,
});
const every = (amount: number | null, periods = PERIODS.length) =>
  new Array<number | null>(periods).fill(amount);
const team = (id: number, members: number[], capacity: (number | null)[]): ScheduleTeam => ({
  id,
  members,
  capacity,
});
const person = (
  id: number,
  capacity: (number | null)[] = every(null),
  load: number[] = new Array<number>(PERIODS.length).fill(0),
): SchedulePerson => ({ id, capacity, load });

/** One team (Atlas, 10) with person 1 at 20 points a period, unless the case says otherwise. */
const input = (tickets: ScheduleTicket[], extra: Partial<ScheduleInput> = {}): ScheduleInput => ({
  from: FROM,
  periods: PERIODS,
  tickets,
  links: [],
  teams: [team(10, [1], every(pts(20)))],
  people: [person(1)],
  leaveOut: { typeIds: [], releaseIds: [] },
  keep: { inProgress: true, inActiveSprint: true },
  ...extra,
});

const entry = (out: ScheduleOutput, id: number) => out.tickets.find((t) => t.id === id);
const days = (out: ScheduleOutput, id: number) => {
  const p = out.proposals.find((x) => x.id === id);
  return p ? [p.start, p.due] : null;
};
const why = (out: ScheduleOutput, id: number) => {
  const e = entry(out, id);
  return e ? [e.outcome, e.reason] : null;
};

describe('the auto-scheduler fills periods in rank order (PLN-004)', () => {
  it('[PLN-004] (1) fills three periods of 20 points with 60 points of ranked work, in rank order', () => {
    const out = schedule(input([1, 2, 3, 4, 5, 6].map((id) => ticket(id))));
    expect([1, 2, 3, 4, 5, 6].map((id) => days(out, id))).toEqual([
      [P1.start, P1.end],
      [P1.start, P1.end],
      [P2.start, P2.end],
      [P2.start, P2.end],
      [P3.start, P3.end],
      [P3.start, P3.end],
    ]);
    expect(out.counts.placed).toBe(6);
    expect(entry(out, 1)?.args).toEqual({
      teamId: 10,
      periodStart: P1.start,
      periodEnd: P1.end,
      free: 20,
      capacity: 20,
      before: 0,
    });
    expect(entry(out, 2)).toMatchObject({ reason: 'fits', args: { free: 10, before: 1 } });
  });

  it('[PLN-004] (1) keeps rank order and leaves room unused rather than fill it with lower-ranked work', () => {
    const out = schedule(
      input([
        ticket(1, { estimate: pts(8) }),
        ticket(2, { estimate: pts(7) }),
        ticket(3, { estimate: pts(7) }),
        ticket(4, { estimate: pts(5) }),
      ]),
    );
    expect([1, 2, 3, 4].map((id) => days(out, id)?.[1])).toEqual([P1.end, P1.end, P2.end, P2.end]);
    // Five points stay free in the first period: the 5-point ticket is ranked below one in P2.
    expect(entry(out, 4)).toMatchObject({
      reason: 'after_higher_ranked',
      args: { teamId: 10, periodStart: P2.start },
    });
  });

  it('[PLN-004] orders ranks by code unit, never by localeCompare', () => {
    // 'B0' < 'a0' by code unit (the "C" collation); localeCompare would put 'a0' first.
    expect('a0'.localeCompare('B0')).toBeLessThan(0);
    const out = schedule(
      input([
        ticket(1, { rank: 'a0', estimate: pts(20) }),
        ticket(2, { rank: 'B0', estimate: pts(20) }),
      ]),
    );
    expect(days(out, 2)).toEqual([P1.start, P1.end]);
    expect(days(out, 1)).toEqual([P2.start, P2.end]);
  });

  it('[PLN-004] starts on the run’s first day when it falls inside the first period', () => {
    const out = schedule(input([ticket(1)], { from: '2026-11-20' }));
    expect(days(out, 1)).toEqual(['2026-11-20', P1.end]);
  });

  it('[PLN-004] uses the run’s last period, and leaves the next ticket not placed with the last day', () => {
    const full = every(pts(20));
    const load = [...every(pts(20), 5), 0] as number[];
    const out = schedule(
      input([ticket(1, { estimate: pts(20) }), ticket(2, { estimate: pts(5) })], {
        people: [person(1, every(null), load)],
        teams: [team(10, [1], full)],
      }),
    );
    expect(days(out, 1)).toEqual([LAST.start, LAST.end]);
    expect(entry(out, 2)).toMatchObject({
      outcome: 'not_placed',
      reason: 'no_room',
      args: { teamId: 10, until: LAST.end },
    });
  });
});

describe('the auto-scheduler and dependencies (PLN-004, PLN-006)', () => {
  it('[PLN-004] [PLN-006] (2) puts a low-ranked blocker first and starts what it blocks the day after it ends', () => {
    const out = schedule(
      input([ticket(1), ticket(9)], {
        links: [{ from: 9, to: 1 }],
      }),
    );
    expect(days(out, 9)).toEqual([P1.start, P1.end]);
    expect(days(out, 1)).toEqual([P2.start, P2.end]);
    expect(entry(out, 9)).toMatchObject({ reason: 'first_for_blocked', args: { ticketId: 1 } });
    expect(entry(out, 1)).toMatchObject({
      reason: 'after_blocker',
      args: { blockerId: 9, blockerEnd: P1.end },
    });
  });

  it('[PLN-004] [PLN-006] (2) is pushed by a kept, dated blocker to the day after it ends', () => {
    const kept = ticket(2, { stage: 'active', start: '2026-11-16', due: '2026-12-02' });
    const out = schedule(input([ticket(1), kept], { links: [{ from: 2, to: 1 }] }));
    expect(why(out, 2)).toEqual(['kept', 'in_progress']);
    expect(days(out, 1)).toEqual(['2026-12-03', P2.end]);
    expect(entry(out, 1)).toMatchObject({
      reason: 'after_blocker',
      args: { blockerEnd: '2026-12-02' },
    });
  });

  it('[PLN-004] [PLN-006] (2) ends a kept blocker without days of its own on its sprint’s end', () => {
    const kept = ticket(2, {
      inActiveSprint: true,
      sprint: { start: '2026-11-16', end: '2026-11-22' },
    });
    const out = schedule(input([ticket(1), kept], { links: [{ from: 2, to: 1 }] }));
    expect(days(out, 1)).toEqual(['2026-11-23', P1.end]);
  });

  it('[PLN-004] [PLN-006] (2) leaves a ticket behind a kept, undated blocker not placed', () => {
    const out = schedule(
      input([ticket(1), ticket(2, { stage: 'active' })], { links: [{ from: 2, to: 1 }] }),
    );
    expect(entry(out, 1)).toMatchObject({
      outcome: 'not_placed',
      reason: 'blocker_undated',
      args: { blockerId: 2 },
    });
  });

  it('[PLN-004] [PLN-006] (2) lets a closed blocker hold nothing up', () => {
    const done = ticket(2, { stage: 'closed', start: '2026-11-16', due: '2026-12-20' });
    const out = schedule(input([ticket(1), done], { links: [{ from: 2, to: 1 }] }));
    expect(days(out, 1)).toEqual([P1.start, P1.end]);
    expect(entry(out, 2)).toBeUndefined();
    expect(days(out, 2)).toBeNull();
  });

  it('[PLN-004] [PLN-006] (2) does not move a ticket whose blocker the runner may not see', () => {
    const out = schedule(
      input([ticket(1, { hiddenBlocker: true, start: '2026-11-18', due: '2026-11-19' })]),
    );
    expect(entry(out, 1)).toEqual({
      id: 1,
      key: 'SPA-1',
      outcome: 'not_placed',
      reason: 'hidden_blocker',
      args: {},
      warnings: [],
    });
    expect(out.proposals).toEqual([]);
  });

  it('[PLN-004] [PLN-006] (2) finds circles of two and three tickets and a self-link', () => {
    const out = schedule(
      input(
        [1, 2, 3, 4, 5, 6, 7].map((id) => ticket(id)),
        {
          links: [
            { from: 1, to: 2 },
            { from: 2, to: 1 },
            { from: 3, to: 4 },
            { from: 4, to: 5 },
            { from: 5, to: 3 },
            { from: 6, to: 6 },
            // Behind a circle: its blocker is not placed and has no days.
            { from: 5, to: 7 },
          ],
        },
      ),
    );
    expect(entry(out, 1)).toMatchObject({ reason: 'cycle', args: { ticketIds: [2], size: 2 } });
    expect(entry(out, 2)).toMatchObject({ reason: 'cycle', args: { ticketIds: [1], size: 2 } });
    expect(entry(out, 4)).toMatchObject({ reason: 'cycle', args: { ticketIds: [3, 5], size: 3 } });
    expect(entry(out, 6)).toMatchObject({ reason: 'cycle', args: { ticketIds: [], size: 1 } });
    expect(entry(out, 7)).toMatchObject({ reason: 'blocker_not_placed', args: { blockerId: 5 } });
    expect(out.counts.notPlaced.cycle).toBe(6);
  });

  it('[PLN-004] [PLN-006] (2) leaves a chain behind a blocker not placed, or starts it after the blocker’s own days', () => {
    const undated = schedule(
      input([ticket(1, { estimate: null }), ticket(2), ticket(3)], {
        links: [
          { from: 1, to: 2 },
          { from: 2, to: 3 },
        ],
      }),
    );
    expect(why(undated, 1)).toEqual(['not_placed', 'no_estimate']);
    expect(entry(undated, 2)).toMatchObject({
      reason: 'blocker_not_placed',
      args: { blockerId: 1 },
    });
    expect(entry(undated, 3)).toMatchObject({
      reason: 'blocker_not_placed',
      args: { blockerId: 2 },
    });

    const dated = schedule(
      input([ticket(1, { estimate: null, start: '2026-11-16', due: '2026-11-20' }), ticket(2)], {
        links: [{ from: 1, to: 2 }],
      }),
    );
    expect(days(dated, 2)).toEqual(['2026-11-21', P1.end]);
  });

  it('[PLN-004] [PLN-006] warns when a placed ticket blocks a kept ticket that starts before it ends', () => {
    const kept = ticket(2, { personDraft: true, start: '2026-11-20', due: '2026-11-25' });
    const out = schedule(input([ticket(1), kept], { links: [{ from: 1, to: 2 }] }));
    expect(days(out, 1)).toEqual([P1.start, P1.end]);
    expect(entry(out, 1)?.warnings).toEqual([
      { kind: 'late_against_kept', args: { ticketIds: [2], count: 1 } },
    ]);
    expect(out.counts.warnings.late_against_kept).toBe(1);
  });

  it('[PLN-004] [PLN-006] isLate agrees with the web’s dependencyState on the shared table of cases', () => {
    const table = JSON.parse(
      readFileSync(join(import.meta.dirname, '__cases__', 'late-rule.json'), 'utf8'),
    ) as {
      cases: {
        name: string;
        blocker: { start: string | null; due: string | null; closed: boolean };
        blocked: { start: string | null; due: string | null; closed: boolean };
        state: string;
      }[];
    };
    expect(table.cases.length).toBeGreaterThan(8);
    for (const c of table.cases) {
      const a = barDays(c.blocker.start, c.blocker.due);
      const b = barDays(c.blocked.start, c.blocked.due);
      const state = c.blocker.closed
        ? 'closed'
        : !a || !b
          ? 'undated'
          : c.blocked.closed
            ? 'onTime'
            : isLate(a.end, b.start)
              ? 'late'
              : 'onTime';
      expect(state, c.name).toBe(c.state);
    }
  });
});

describe('what the auto-scheduler keeps and leaves out (PLN-004)', () => {
  it('[PLN-004] (3) keeps tickets by each rule, and leaves out tickets by each choice', () => {
    const tickets = [
      ticket(1, { personDraft: true, start: '2026-12-01', due: '2026-12-04' }),
      ticket(2, { maySchedule: false }),
      ticket(3, { keptByQuery: true }),
      ticket(4, { stage: 'active' }),
      ticket(5, { inActiveSprint: true }),
      ticket(6, { level: 1 }),
      ticket(7, { typeId: 7 }),
      ticket(8, { releaseIds: [80] }),
      ticket(9, { leftOutByQuery: true }),
      ticket(10),
    ];
    const out = schedule(input(tickets, { leaveOut: { typeIds: [7], releaseIds: [80] } }));
    expect(out.tickets.map((t) => [t.id, t.outcome, t.reason])).toEqual([
      [1, 'kept', 'person_draft'],
      [2, 'kept', 'may_not_schedule'],
      [3, 'kept', 'kept_by_query'],
      [4, 'kept', 'in_progress'],
      [5, 'kept', 'in_sprint'],
      [10, 'placed', 'fits'],
    ]);
    expect(out.proposals.map((p) => p.id)).toEqual([10]);
    expect(out.counts.leftOut).toEqual({ level: 1, type: 1, release: 1, query: 1 });
    expect(out.counts.kept).toEqual({
      person_draft: 1,
      may_not_schedule: 1,
      kept_by_query: 1,
      in_progress: 1,
      in_sprint: 1,
    });
  });

  it('[PLN-004] (3) moves tickets in progress or in an active sprint when the run says so', () => {
    const out = schedule(
      input([ticket(1, { stage: 'active' }), ticket(2, { inActiveSprint: true })], {
        keep: { inProgress: false, inActiveSprint: false },
      }),
    );
    expect(out.proposals.map((p) => p.id)).toEqual([1, 2]);
  });

  it('[PLN-004] (3) counts the load of kept and left-out tickets where their days are', () => {
    const out = schedule(
      input([
        ticket(1, { stage: 'active', estimate: pts(15), due: '2026-11-20' }),
        ticket(2, { level: 1, estimate: pts(5), due: '2026-11-25' }),
        ticket(3),
      ]),
    );
    // Atlas has 20 points in P1, all taken by the kept and the left-out ticket.
    expect(days(out, 3)).toEqual([P2.start, P2.end]);
  });
});

describe('why a ticket is not placed (PLN-004)', () => {
  it('[PLN-004] says no estimate, no assignee, no team and no capacity', () => {
    const out = schedule(
      input(
        [
          ticket(1, { estimate: null }),
          ticket(2, { assigneeId: null }),
          ticket(3, { assigneeId: 5 }),
          ticket(4, { assigneeId: 2 }),
        ],
        {
          teams: [team(10, [1], every(pts(20))), team(11, [2], every(null))],
          people: [person(1), person(2), person(5)],
        },
      ),
    );
    expect(out.tickets.map((t) => [t.id, t.reason, t.args])).toEqual([
      [1, 'no_estimate', {}],
      [2, 'no_assignee', {}],
      [3, 'no_team', { userId: 5 }],
      [4, 'no_capacity', { teamIds: [11] }],
    ]);
  });

  it('[PLN-004] tells a ticket too big for any period from one with no room left', () => {
    const big = schedule(input([ticket(1, { estimate: pts(30) })]));
    expect(entry(big, 1)).toMatchObject({ reason: 'too_big', args: { teamId: 10, capacity: 20 } });

    const busy = schedule(
      input([ticket(1, { estimate: pts(10) })], {
        people: [person(1, every(null), every(pts(15)) as number[])],
      }),
    );
    expect(entry(busy, 1)).toMatchObject({
      reason: 'no_room',
      args: { teamId: 10, until: LAST.end },
    });
  });

  it('[PLN-004] names the largest capacity a ticket is too big for', () => {
    const out = schedule(
      input([ticket(1, { estimate: pts(30) })], {
        teams: [team(10, [1], [pts(10), pts(25), null, pts(5), null, null])],
      }),
    );
    expect(entry(out, 1)).toMatchObject({ reason: 'too_big', args: { teamId: 10, capacity: 25 } });
  });

  it('[PLN-004] holds a ticket to its person’s capacity under a team’s capacity from its members', () => {
    // Atlas's 20 points are the sum of its members' 10 and 10, as Capacity resolves them.
    const out = schedule(
      input([ticket(1, { estimate: pts(15) }), ticket(2, { estimate: pts(10) })], {
        teams: [team(10, [1, 2], every(pts(20)))],
        people: [person(1, every(pts(10))), person(2, every(pts(10)))],
      }),
    );
    expect(entry(out, 1)).toMatchObject({ reason: 'too_big', args: { userId: 1, capacity: 10 } });
    expect(entry(out, 2)).toMatchObject({ reason: 'fits', args: { userId: 1, free: 10 } });
  });

  it('[PLN-004] loads both teams of a person in two, as the Capacity tab counts', () => {
    const out = schedule(
      input([ticket(1, { estimate: pts(15) }), ticket(2, { assigneeId: 2, estimate: pts(10) })], {
        teams: [team(10, [1], every(pts(20))), team(11, [1, 2], every(pts(20)))],
        people: [person(1), person(2)],
      }),
    );
    expect(days(out, 1)).toEqual([P1.start, P1.end]);
    // Borealis (11) has 5 points left in P1 after person 1's ticket.
    expect(days(out, 2)).toEqual([P2.start, P2.end]);
    expect(entry(out, 2)).toMatchObject({ reason: 'fits', args: { teamId: 11 } });
  });

  it('[PLN-004] lets a capacity of 0 hold nothing, and a zero estimate fit a full period', () => {
    const zero = schedule(
      input([ticket(1, { estimate: pts(5) })], { teams: [team(10, [1], every(0))] }),
    );
    expect(entry(zero, 1)).toMatchObject({ reason: 'too_big', args: { capacity: 0 } });

    const later = schedule(
      input([ticket(1, { estimate: pts(5) })], {
        teams: [team(10, [1], [0, pts(20), null, null, null, null])],
      }),
    );
    expect(days(later, 1)).toEqual([P2.start, P2.end]);

    const full = schedule(
      input([ticket(1, { estimate: 0 })], {
        people: [person(1, every(null), every(pts(20)) as number[])],
      }),
    );
    expect(days(full, 1)).toEqual([P1.start, P1.end]);
  });

  it('[PLN-004] limits nothing in a period where no subject has a capacity set', () => {
    const out = schedule(
      input([ticket(1, { estimate: pts(50) })], {
        teams: [team(10, [1], [null, null, pts(60), null, null, null])],
      }),
    );
    expect(days(out, 1)).toEqual([P3.start, P3.end]);
  });

  it('[PLN-004] fits in whole hundredths, where floats would round wrongly', () => {
    expect(0.1 + 0.2 > 0.3).toBe(true);
    expect(hundredths(0.1) + hundredths(0.2)).toBe(hundredths(0.3));
    expect(hundredths(1.005)).toBe(101);
    expect(hundredths(2.675)).toBe(268);
    expect(hundredths(8)).toBe(800);
    const out = schedule(
      input([ticket(1, { estimate: hundredths(0.1) }), ticket(2, { estimate: hundredths(0.2) })], {
        teams: [team(10, [1], every(hundredths(0.3)))],
      }),
    );
    expect(days(out, 2)).toEqual([P1.start, P1.end]);
    expect(entry(out, 2)?.args).toMatchObject({ free: 0.2, capacity: 0.3 });
  });

  it('[PLN-004] warns when a ticket left where it was takes a period placed work filled', () => {
    const two = PERIODS.slice(0, 2);
    const out = schedule(
      input(
        [
          ticket(1, { estimate: pts(20) }),
          ticket(2, { estimate: pts(20) }),
          ticket(3, { estimate: pts(10), start: '2026-11-20', due: '2026-11-25' }),
        ],
        {
          periods: two,
          teams: [team(10, [1], every(pts(20), 2))],
          people: [person(1, every(null, 2), [0, 0])],
        },
      ),
    );
    expect(entry(out, 3)).toMatchObject({
      outcome: 'not_placed',
      reason: 'no_room',
      warnings: [{ kind: 'over_where_kept', args: { teamId: 10, periodStart: P1.start } }],
    });
    expect(out.proposals.map((p) => p.id)).toEqual([1, 2]);
  });
});

describe('warnings and the answer (PLN-004)', () => {
  it('[PLN-004] warns when a placed ticket is due after its target release', () => {
    const out = schedule(input([ticket(1, { release: { id: 70, date: '2026-11-20' } })]));
    expect(entry(out, 1)?.warnings).toEqual([
      { kind: 'after_release', args: { releaseId: 70, releaseDate: '2026-11-20', days: 9 } },
    ]);
  });

  it('[PLN-004] says a ticket is already where the run would put it', () => {
    const out = schedule(input([ticket(1, { start: P1.start, due: P1.end })]));
    expect(why(out, 1)).toEqual(['placed', 'already']);
    expect(out.counts).toMatchObject({ placed: 1, already: 1 });
    expect(out.proposals).toEqual([{ id: 1, start: P1.start, due: P1.end }]);
  });

  it('[PLN-004] (4) lists every ticket it does not place with its reason, not placed first', () => {
    const out = schedule(
      input([
        ticket(1, { release: { id: 70, date: '2026-11-20' } }),
        ticket(2, { stage: 'active' }),
        ticket(3),
        ticket(4, { estimate: null }),
        ticket(5, { estimate: pts(99) }),
      ]),
    );
    expect(out.tickets.map((t) => [t.id, t.outcome, t.reason])).toEqual([
      [4, 'not_placed', 'no_estimate'],
      [5, 'not_placed', 'too_big'],
      [1, 'placed', 'fits'],
      [2, 'kept', 'in_progress'],
      [3, 'placed', 'fits'],
    ]);
  });

  it('[PLN-004] (4) changes nothing on a second run over unchanged tickets', () => {
    const run = input(
      [1, 2, 3, 4, 5].map((id) => ticket(id, { estimate: pts(id * 3) })),
      { links: [{ from: 5, to: 1 }] },
    );
    const first = schedule(run);
    expect(schedule(run)).toEqual(first);
    // The proposals become the tickets' days: every one is already where the run puts it.
    const at = new Map(first.proposals.map((p) => [p.id, p]));
    const again = schedule({
      ...run,
      tickets: run.tickets.map((t) => ({
        ...t,
        start: at.get(t.id)?.start ?? t.start,
        due: at.get(t.id)?.due ?? t.due,
      })),
    });
    expect(again.proposals).toEqual(first.proposals);
    expect(again.counts.already).toBe(first.counts.placed);
  });
});

describe('the run’s body (PLN-004)', () => {
  it('[PLN-004] takes the defaults and refuses what is out of bounds', () => {
    const ok = scheduleBody.parse({ into: { newScenario: { name: ' Auto-schedule 14 Nov ' } } });
    expect(ok).toEqual({
      into: { newScenario: { name: 'Auto-schedule 14 Nov' } },
      periods: 6,
      leaveOut: { typeIds: [], releaseIds: [] },
      keep: { inProgress: true, inActiveSprint: true },
    });
    expect(
      scheduleBody.parse({ into: { scenarioId: 3 }, keep: { query: '  ' } }).keep.query,
    ).toBeUndefined();
    for (const bad of [
      {},
      { into: { scenarioId: 0 } },
      { into: { newScenario: { name: '' } } },
      { into: { newScenario: { name: 'x'.repeat(101) } } },
      { into: { scenarioId: 1 }, periods: 13 },
      { into: { scenarioId: 1 }, periods: 0 },
      { into: { scenarioId: 1 }, from: '2026-02-30' },
      {
        into: { scenarioId: 1 },
        leaveOut: { typeIds: Array.from({ length: 21 }, (_, i) => i + 1) },
      },
      { into: { scenarioId: 1 }, leaveOut: { query: 'x'.repeat(2001) } },
      { into: { scenarioId: 1 }, keep: { inProgress: 'yes' } },
      { into: { scenarioId: 1 }, extra: true },
    ]) {
      expect(scheduleBody.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Properties (a) to (e) of ADR-122 stage 7, over random plans.

const DAY0 = dayNumber('2026-11-02');
const isoOf = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const optDay = fc.option(
  fc.integer({ min: 0, max: 120 }).map((n) => isoOf(DAY0 + n)),
  {
    nil: null,
    freq: 2,
  },
);
/** One time in `n`, or never in a calm plan. */
const rarely = (calm: boolean, n = 8) =>
  calm ? fc.constant(false) : fc.integer({ min: 1, max: n }).map((x) => x === 1);
const amountArb = (calm: boolean) =>
  calm
    ? fc.integer({ min: 10, max: 80 }).map((n) => n * 50)
    : fc.option(
        fc.integer({ min: 0, max: 80 }).map((n) => n * 50),
        { nil: null, freq: 4 },
      );

/**
 * Random plans. Half are calm (every ticket assigned and estimated, capacity everywhere, few rules
 * keeping or leaving out), so that many tickets are placed behind blockers; half are messy.
 */
const planArb = fc
  .record({
    calm: fc.boolean(),
    n: fc.integer({ min: 1, max: 24 }),
    periods: fc.integer({ min: 1, max: 6 }),
    fromOffset: fc.integer({ min: 0, max: 30 }),
    keepInProgress: fc.boolean(),
    keepInSprint: fc.boolean(),
  })
  .chain(({ calm, n, periods, fromOffset, keepInProgress, keepInSprint }) => {
    const ticketArb = (id: number) =>
      fc
        .record({
          rank: fc.string({
            unit: fc.constantFrom('0', '9', 'A', 'Z', 'a', 'z'),
            minLength: 1,
            maxLength: 3,
          }),
          level: rarely(calm).map((x) => (x ? 1 : 0)),
          typeId: rarely(calm).map((x) => (x ? 2 : 1)),
          stage: (calm
            ? fc.constantFrom('new', 'new', 'new', 'new', 'new', 'new', 'active', 'closed')
            : fc.constantFrom('new', 'new', 'new', 'active', 'closed')) as fc.Arbitrary<
            ScheduleTicket['stage']
          >,
          assigneeId: calm
            ? fc.integer({ min: 1, max: 4 })
            : fc.option(fc.integer({ min: 1, max: 5 }), { nil: null, freq: 8 }),
          estimate: calm
            ? fc.integer({ min: 0, max: 800 })
            : fc.option(fc.integer({ min: 0, max: 1200 }), { nil: null, freq: 8 }),
          start: optDay,
          due: optDay,
          sprint: fc.option(
            fc.integer({ min: 0, max: 100 }).map((n) => ({
              start: isoOf(DAY0 + n),
              end: isoOf(DAY0 + n + 13),
            })),
            { nil: null, freq: 4 },
          ),
          inActiveSprint: rarely(calm, 4),
          releaseIds: fc.constantFrom<number[]>([], [], [], [80], [81], [80, 81]),
          release: fc.option(
            fc.integer({ min: 0, max: 100 }).map((n) => ({ id: 70, date: isoOf(DAY0 + n) })),
            { nil: null, freq: 3 },
          ),
          personDraft: rarely(calm),
          maySchedule: rarely(calm).map((x) => !x),
          leftOutByQuery: rarely(calm),
          keptByQuery: rarely(calm),
          hiddenBlocker: rarely(calm),
        })
        .map((r) => ({ ...r, id, key: `SPA-${id}` }) as ScheduleTicket);
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    return fc.record({
      tickets: fc.tuple(...ids.map(ticketArb)),
      // Mostly from a lower id to a higher one, so circles are few and chains are long.
      links: fc.array(
        fc
          .record({
            a: fc.integer({ min: 1, max: n + 1 }),
            b: fc.integer({ min: 1, max: n }),
            back: fc.integer({ min: 1, max: 10 }).map((x) => x === 1),
          })
          .map(({ a, b, back }) =>
            back || a > n ? { from: a, to: b } : { from: Math.min(a, b), to: Math.max(a, b) },
          ),
        { maxLength: n * 2 },
      ),
      teams: fc.array(
        fc.record({
          id: fc.integer({ min: 10, max: 13 }),
          members: fc.subarray([1, 2, 3, 4], { minLength: 2 }),
          capacity: fc.array(amountArb(calm), { minLength: periods, maxLength: periods }),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      people: fc.tuple(
        ...[1, 2, 3, 4, 5].map((id) =>
          fc.record({
            id: fc.constant(id),
            capacity: fc.array(calm ? fc.constant(null) : amountArb(false), {
              minLength: periods,
              maxLength: periods,
            }),
            load: fc.array(fc.integer({ min: 0, max: 600 }), {
              minLength: periods,
              maxLength: periods,
            }),
          }),
        ),
      ),
      from: fc.constant(isoOf(DAY0 + fromOffset)),
      periods: fc.constant(periods),
      keep: fc.constant({ inProgress: keepInProgress, inActiveSprint: keepInSprint }),
    });
  })
  .map(
    (g): ScheduleInput => ({
      from: g.from,
      periods: periodsFrom({ kind: 'weeks', weeks: 2, anchor: '2026-11-02' }, g.from, g.periods),
      tickets: [...g.tickets],
      links: g.links,
      teams: [...new Map(g.teams.map((t) => [t.id, t])).values()],
      people: [...g.people],
      leaveOut: { typeIds: [2], releaseIds: [81] },
      keep: g.keep,
    }),
  );

/** The class each open ticket falls in, by the ADR's rules, computed apart from the engine. */
function classOf(run: ScheduleInput, t: ScheduleTicket) {
  if (t.stage === 'closed') return 'closed';
  if (
    t.level !== 0 ||
    run.leaveOut.typeIds.includes(t.typeId) ||
    t.releaseIds.some((r) => run.leaveOut.releaseIds.includes(r)) ||
    t.leftOutByQuery
  )
    return 'left_out';
  if (
    t.personDraft ||
    !t.maySchedule ||
    t.keptByQuery ||
    (t.stage === 'active' && run.keep.inProgress) ||
    (t.inActiveSprint && run.keep.inActiveSprint)
  )
    return 'kept';
  return 'movable';
}

const ownEnd = (t: ScheduleTicket) =>
  barDays(t.start, t.due)?.end ?? (t.sprint ? dayNumber(t.sprint.end) : null);

describe('what the rules promise (PLN-004, properties)', () => {
  it('[PLN-004] draws random plans that place, keep, leave out and refuse tickets', () => {
    const runs = fc.sample(planArb, { numRuns: 300, seed: 7 });
    const outs = runs.map(schedule);
    // Links that (a) tests: a placed ticket behind a blocker with an end.
    const held = runs.reduce((n, run, i) => {
      const placed = new Set(outs[i]?.proposals.map((p) => p.id));
      const byId = new Map(run.tickets.map((t) => [t.id, t]));
      return (
        n +
        run.links.filter((l) => {
          const blocker = byId.get(l.from);
          return (
            placed.has(l.to) &&
            blocker !== undefined &&
            blocker.stage !== 'closed' &&
            (placed.has(l.from) || ownEnd(blocker) !== null)
          );
        }).length
      );
    }, 0);
    expect(held).toBeGreaterThan(40);
    const total = (f: (o: ScheduleOutput) => number) => outs.reduce((n, o) => n + f(o), 0);
    const reason = (r: string) => total((o) => o.tickets.filter((t) => t.reason === r).length);
    expect(total((o) => o.counts.placed - o.counts.already)).toBeGreaterThan(300);
    expect(reason('after_blocker')).toBeGreaterThan(10);
    expect(reason('first_for_blocked')).toBeGreaterThan(10);
    expect(reason('after_higher_ranked')).toBeGreaterThan(10);
    expect(total((o) => o.counts.notPlaced.no_room)).toBeGreaterThan(20);
    expect(total((o) => o.counts.notPlaced.cycle)).toBeGreaterThan(10);
    expect(total((o) => o.counts.kept.person_draft)).toBeGreaterThan(10);
    expect(total((o) => o.counts.warnings.over_where_kept)).toBeGreaterThan(3);
    expect(total((o) => o.counts.warnings.late_against_kept)).toBeGreaterThan(5);
    expect(total((o) => o.counts.leftOut.level)).toBeGreaterThan(5);
  });

  it('[PLN-004] [PLN-006] (a) no placed ticket starts on or before the end of a dated blocker', () => {
    fc.assert(
      fc.property(planArb, (run) => {
        const out = schedule(run);
        const byId = new Map(run.tickets.map((t) => [t.id, t]));
        const placed = new Map(out.proposals.map((p) => [p.id, p]));
        for (const l of run.links) {
          const to = placed.get(l.to);
          const blocker = byId.get(l.from);
          if (!to || !blocker || blocker.stage === 'closed' || l.from === l.to) continue;
          const mine = placed.get(l.from);
          const end = mine ? dayNumber(mine.due) : ownEnd(blocker);
          if (end === null) continue;
          expect(isLate(end, dayNumber(to.start)), `${l.from} -> ${l.to}`).toBe(false);
        }
      }),
    );
  });

  it('[PLN-004] [PLN-005] (b) no placed ticket takes a load over a capacity, unless a ticket kept where it was says so', () => {
    fc.assert(
      fc.property(planArb, (run) => {
        const out = schedule(run);
        const P = run.periods.length;
        const periodOf = (d: string) => {
          const n = dayNumber(d);
          return run.periods.findIndex((p) => n >= dayNumber(p.start) && n <= dayNumber(p.end));
        };
        const members = new Map(run.teams.map((t) => [t.id, [...new Set(t.members)]]));
        const subjects = (assignee: number | null) =>
          assignee === null
            ? []
            : [
                `u${assignee}`,
                ...run.teams.filter((t) => t.members.includes(assignee)).map((t) => `t${t.id}`),
              ];
        const capOf = (s: string, p: number) =>
          s.startsWith('t')
            ? (run.teams.find((t) => `t${t.id}` === s)?.capacity[p] ?? null)
            : (run.people.find((x) => `u${x.id}` === s)?.capacity[p] ?? null);
        const base = (s: string, p: number) =>
          s.startsWith('t')
            ? (members.get(Number(s.slice(1))) ?? []).reduce(
                (sum, m) => sum + (run.people.find((x) => x.id === m)?.load[p] ?? 0),
                0,
              )
            : (run.people.find((x) => `u${x.id}` === s)?.load[p] ?? 0);
        const entries = new Map(out.tickets.map((e) => [e.id, e]));
        const placed = new Map(out.proposals.map((x) => [x.id, x]));
        const fixed = new Map<string, number>();
        const moved = new Map<string, number>();
        const add = (m: Map<string, number>, key: string, v: number) =>
          m.set(key, (m.get(key) ?? 0) + v);
        for (const t of run.tickets) {
          const e = entries.get(t.id);
          const at = placed.get(t.id);
          const due = at ? at.due : t.due;
          if (due === null) continue;
          const p = periodOf(due);
          if (p < 0) continue;
          const est = t.estimate ?? 0;
          for (const s of subjects(t.assigneeId)) {
            if (at) add(moved, `${s}:${p}`, est);
            // Tickets the loop could not place add their load as it goes: not counted here.
            else if (e?.reason !== 'no_room' && e?.reason !== 'blocker_not_placed')
              add(fixed, `${s}:${p}`, est);
          }
        }
        for (const [cell, amount] of moved) {
          if (amount === 0) continue;
          const [s, p] = cell.split(':') as [string, string];
          const c = capOf(s, Number(p));
          if (c === null) continue;
          // Placed work never takes a cell over: whatever was there from the start, and it.
          expect(base(s, Number(p)) + (fixed.get(cell) ?? 0) + amount, cell).toBeLessThanOrEqual(c);
        }
        expect(P).toBeGreaterThan(0);
      }),
    );
  });

  it('[PLN-004] (c) kept, left-out and closed tickets get no proposal', () => {
    fc.assert(
      fc.property(planArb, (run) => {
        const out = schedule(run);
        const proposed = new Set(out.proposals.map((p) => p.id));
        for (const t of run.tickets) {
          if (classOf(run, t) !== 'movable') expect(proposed.has(t.id), `${t.id}`).toBe(false);
        }
      }),
    );
  });

  it('[PLN-004] (d) places or does not place every movable ticket exactly once, with one reason', () => {
    fc.assert(
      fc.property(planArb, (run) => {
        const out = schedule(run);
        const ids = out.tickets.map((t) => t.id);
        expect(new Set(ids).size).toBe(ids.length);
        const decided = out.tickets.filter((t) => t.outcome !== 'kept').map((t) => t.id);
        const movable = run.tickets.filter((t) => classOf(run, t) === 'movable').map((t) => t.id);
        expect([...decided].sort((a, b) => a - b)).toEqual(movable.sort((a, b) => a - b));
        const kept = out.tickets.filter((t) => t.outcome === 'kept').map((t) => t.id);
        expect(kept.sort((a, b) => a - b)).toEqual(
          run.tickets
            .filter((t) => classOf(run, t) === 'kept')
            .map((t) => t.id)
            .sort((a, b) => a - b),
        );
        for (const t of out.tickets) expect(typeof t.reason).toBe('string');
        expect(out.proposals.length).toBe(out.counts.placed);
        for (const p of out.proposals) expect(p.start <= p.due).toBe(true);
      }),
    );
  });

  it('[PLN-004] (e) gives the same answer whatever the order of the input, and none new on a second run', () => {
    fc.assert(
      fc.property(planArb, fc.integer(), (run, seed) => {
        const first = schedule(run);
        let s = seed;
        const shuffle = <T>(xs: readonly T[]): T[] => {
          const a = [...xs];
          for (let i = a.length - 1; i > 0; i--) {
            s = (s * 1_103_515_245 + 12_345) & 0x7fffffff;
            const j = s % (i + 1);
            [a[i], a[j]] = [a[j] as T, a[i] as T];
          }
          return a;
        };
        const shuffled: ScheduleInput = {
          ...run,
          tickets: shuffle(run.tickets),
          links: shuffle(run.links),
          teams: shuffle(run.teams).map((t) => ({ ...t, members: shuffle(t.members) })),
          people: shuffle(run.people),
        };
        expect(schedule(shuffled)).toEqual(first);
        const at = new Map(first.proposals.map((p) => [p.id, p]));
        const again = schedule({
          ...run,
          tickets: run.tickets.map((t) => ({
            ...t,
            start: at.get(t.id)?.start ?? t.start,
            due: at.get(t.id)?.due ?? t.due,
          })),
        });
        expect(again.proposals).toEqual(first.proposals);
        expect(again.counts.already).toBe(again.counts.placed);
      }),
    );
  });
});
