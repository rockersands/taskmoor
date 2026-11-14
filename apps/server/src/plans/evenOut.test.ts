import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { countOverCells, type EvenOutOutput, evenOut } from './evenOut';
import { dayNumber, isoDay, type Period, periodsFrom } from './periods';
import {
  barDays,
  isLate,
  type ScheduleInput,
  type SchedulePerson,
  type ScheduleTeam,
  type ScheduleTicket,
} from './scheduler';

// Two-week periods from Monday 16 November 2026: 16-29 Nov, 30 Nov-13 Dec, 14-27 Dec, ...
const FROM = '2026-11-16';
const PERIODS = periodsFrom({ kind: 'weeks', weeks: 2, anchor: FROM }, FROM, 6);
const P1 = PERIODS[0] as Period;
const P2 = PERIODS[1] as Period;
const P3 = PERIODS[2] as Period;
const LAST = PERIODS[5] as Period;
const pts = (n: number) => n * 100;

/** A ticket of person 1, 10 points, from 16 to 27 November (in the first period). */
const ticket = (id: number, extra: Partial<ScheduleTicket> = {}): ScheduleTicket => ({
  id,
  key: `SPA-${id}`,
  rank: `r${String(id).padStart(4, '0')}`,
  level: 0,
  typeId: 1,
  stage: 'new',
  assigneeId: 1,
  estimate: pts(10),
  start: '2026-11-16',
  due: '2026-11-27',
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

/** One team (Atlas, 10) of person 1 with 20 points a period, unless the case says otherwise. */
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

const entry = (out: EvenOutOutput, id: number) => out.tickets.find((t) => t.id === id);
const days = (out: EvenOutOutput, id: number) => {
  const p = out.proposals.find((x) => x.id === id);
  return p ? [p.start, p.due] : null;
};
const why = (out: EvenOutOutput, id: number) => {
  const e = entry(out, id);
  return e ? [e.outcome, e.reason] : null;
};

describe('evening out load moves work off over-full periods (PLN-011)', () => {
  it('[PLN-011] (3) empties an over cell by moving the lowest-ranked ticket one period later, its length kept', () => {
    const out = evenOut(input([ticket(1), ticket(2), ticket(3)]));
    // 30 points due in a period of 20: SPA-3, ranked lowest, moves so it is due on 30 November.
    expect(days(out, 3)).toEqual(['2026-11-19', P2.start]);
    expect(entry(out, 3)).toMatchObject({
      outcome: 'placed',
      reason: 'moved_off_over',
      args: {
        teamId: 10,
        fromPeriod: P1.start,
        fromPeriodEnd: P1.end,
        toPeriod: P2.start,
        toPeriodEnd: P2.end,
        days: 3,
        over: 10,
      },
    });
    // The others stay where they are: proposed as they are, so nothing is drafted for them.
    expect(why(out, 1)).toEqual(['placed', 'already']);
    expect(days(out, 1)).toEqual(['2026-11-16', '2026-11-27']);
    expect(out.counts).toMatchObject({ placed: 3, already: 2 });
    expect(out.overLeft).toEqual([]);
    // The ticket moved is listed before those left where they are.
    expect(out.tickets.map((t) => t.id)).toEqual([3, 1, 2]);
  });

  it('[PLN-011] orders ranks by code unit when it picks the lowest-ranked ticket', () => {
    // 'a0' sorts after 'B0' by code unit: the ticket ranked 'a0' is the lowest and moves.
    const out = evenOut(
      input([
        ticket(1, { rank: 'a0', estimate: pts(15) }),
        ticket(2, { rank: 'B0', estimate: pts(15) }),
      ]),
    );
    expect(why(out, 1)).toEqual(['placed', 'moved_off_over']);
    expect(why(out, 2)).toEqual(['placed', 'already']);
  });

  it('[PLN-011] (2) never moves a kept ticket, and reports the cell with only fixed work in it', () => {
    const out = evenOut(
      input([
        ticket(1, { stage: 'active' }),
        ticket(2, { personDraft: true }),
        ticket(3, { keptByQuery: true }),
      ]),
    );
    expect(out.proposals).toEqual([]);
    expect(out.tickets.map((t) => [t.id, t.outcome, t.reason])).toEqual([
      [1, 'kept', 'in_progress'],
      [2, 'kept', 'person_draft'],
      [3, 'kept', 'kept_by_query'],
    ]);
    expect(out.overLeft).toEqual([
      {
        teamId: 10,
        periodStart: P1.start,
        periodEnd: P1.end,
        over: 10,
        onlyFixed: true,
      },
    ]);
  });

  it('[PLN-011] (2) leaves closed, left-out and level-1 tickets where they are, their load counted', () => {
    const out = evenOut(
      input(
        [
          ticket(1, { stage: 'closed' }),
          ticket(2, { level: 1 }),
          ticket(3, { typeId: 7 }),
          ticket(4, { estimate: pts(5) }),
        ],
        { leaveOut: { typeIds: [7], releaseIds: [] } },
      ),
    );
    // 35 points in a period of 20: only SPA-4 may move, and the cell stays 10 over with only
    // tickets that may not move in it.
    expect(why(out, 4)).toEqual(['placed', 'moved_off_over']);
    expect(out.proposals.map((p) => p.id)).toEqual([4]);
    expect(out.counts.leftOut).toMatchObject({ level: 1, type: 1 });
    expect(out.overLeft).toEqual([
      { teamId: 10, periodStart: P1.start, periodEnd: P1.end, over: 10, onlyFixed: true },
    ]);
  });

  it('[PLN-011] [PLN-006] pushes what the moved ticket blocks, along a chain of two, each keeping its length', () => {
    const out = evenOut(
      input(
        [
          ticket(1),
          ticket(2),
          ticket(3),
          // Nobody's work, so it carries no load: SPA-4 starts the day after SPA-3 ends, SPA-5
          // the day after SPA-4 ends.
          ticket(4, { assigneeId: null, start: '2026-11-28', due: '2026-12-01' }),
          ticket(5, { assigneeId: null, start: '2026-12-02', due: '2026-12-02' }),
          // Starts well after: not pushed.
          ticket(6, { assigneeId: null, start: '2026-12-20', due: '2026-12-22' }),
        ],
        {
          links: [
            { from: 3, to: 4 },
            { from: 4, to: 5 },
            { from: 3, to: 6 },
          ],
        },
      ),
    );
    expect(days(out, 3)).toEqual(['2026-11-19', '2026-11-30']);
    expect(days(out, 4)).toEqual(['2026-12-01', '2026-12-04']);
    expect(days(out, 5)).toEqual(['2026-12-05', '2026-12-05']);
    expect(days(out, 6)).toEqual(['2026-12-20', '2026-12-22']);
    expect(entry(out, 4)).toMatchObject({
      reason: 'pushed_by_move',
      args: { blockerId: 3, days: 3 },
    });
    expect(entry(out, 5)).toMatchObject({
      reason: 'pushed_by_move',
      args: { blockerId: 4, days: 3 },
    });
    expect(why(out, 6)).toEqual(['placed', 'already']);
  });

  it('[PLN-011] [PLN-006] undoes a move whose push would reach a kept, an open left-out or a sprint-dated ticket, and tries the next', () => {
    for (const [blocked, expected] of [
      [{ stage: 'active' as const }, 'kept'],
      [{ leftOutByQuery: true }, 'left_out'],
      [{ level: 1 }, 'left_out'],
      [{ start: null, due: null, sprint: { start: '2026-11-30', end: '2026-12-11' } }, 'sprint'],
    ] as const) {
      const out = evenOut(
        input(
          [
            ticket(1),
            ticket(2),
            ticket(3),
            ticket(9, { assigneeId: null, start: '2026-11-30', due: '2026-12-04', ...blocked }),
          ],
          { links: [{ from: 3, to: 9 }] },
        ),
      );
      // SPA-3 would end on 30 November, the day SPA-9 starts: the move is undone.
      expect(entry(out, 3), expected).toMatchObject({
        outcome: 'not_placed',
        reason: 'would_make_late',
        args: { ticketId: 9, why: expected, until: LAST.end },
      });
      expect(days(out, 3)).toBeNull();
      // The next lowest-ranked ticket moves instead.
      expect(why(out, 2), expected).toEqual(['placed', 'moved_off_over']);
      expect(out.overLeft).toEqual([]);
    }
  });

  it('[PLN-011] undoes a push past the run’s last day', () => {
    const two = PERIODS.slice(0, 2);
    const out = evenOut(
      input(
        [
          ticket(1),
          ticket(2, { estimate: pts(15) }),
          ticket(9, { assigneeId: null, start: '2026-11-30', due: P2.end }),
        ],
        {
          periods: two,
          teams: [team(10, [1], every(pts(20), 2))],
          people: [person(1, every(null, 2), [0, 0])],
          links: [{ from: 2, to: 9 }],
        },
      ),
    );
    expect(entry(out, 2)).toMatchObject({
      reason: 'would_make_late',
      args: { ticketId: 9, why: 'past_end', until: P2.end },
    });
    expect(why(out, 1)).toEqual(['placed', 'moved_off_over']);
  });

  it('[PLN-011] says still over when no later period has room up to the run’s end', () => {
    const two = PERIODS.slice(0, 2);
    const out = evenOut(
      input([ticket(1), ticket(2), ticket(3)], {
        periods: two,
        teams: [team(10, [1], every(pts(20), 2))],
        // The second period is full already: work elsewhere.
        people: [person(1, every(null, 2), [0, pts(15)])],
      }),
    );
    expect(out.proposals.every((p) => entry(out, p.id)?.reason === 'already')).toBe(true);
    for (const id of [1, 2, 3]) {
      expect(entry(out, id)).toMatchObject({
        outcome: 'not_placed',
        reason: 'still_over',
        args: { teamId: 10, until: P2.end },
      });
    }
    expect(out.overLeft).toEqual([
      { teamId: 10, periodStart: P1.start, periodEnd: P1.end, over: 10, onlyFixed: false },
    ]);
  });

  it('[PLN-011] evens out a team and its member when both are over', () => {
    const out = evenOut(
      input([ticket(1), ticket(2), ticket(3)], {
        people: [person(1, every(pts(15)))],
      }),
    );
    // The team (20) first: SPA-3 moves. Then the person (15): SPA-2 moves, to the third period,
    // since 20 points in the second would put the person over there.
    expect(entry(out, 3)).toMatchObject({ reason: 'moved_off_over', args: { teamId: 10 } });
    expect(entry(out, 2)).toMatchObject({
      reason: 'moved_off_over',
      args: { userId: 1, toPeriod: P3.start, over: 5 },
    });
    expect(days(out, 2)?.[1]).toBe(P3.start);
    expect(why(out, 1)).toEqual(['placed', 'already']);
    expect(out.overLeft).toEqual([]);
  });

  it('[PLN-011] treats a capacity of 0 as full, and never moves work without a size or a due day', () => {
    const out = evenOut(
      input(
        [
          ticket(1),
          ticket(2, { estimate: 0 }),
          ticket(3, { estimate: null }),
          ticket(4, { due: null }),
        ],
        { teams: [team(10, [1], [0, ...every(pts(20), 5)])] },
      ),
    );
    expect(why(out, 1)).toEqual(['placed', 'moved_off_over']);
    for (const id of [2, 3, 4]) expect(why(out, id)).toEqual(['placed', 'already']);
    expect(days(out, 4)).toEqual(['2026-11-16', null]);
    expect(out.overLeft).toEqual([]);
  });

  it('[PLN-011] moves no ticket in a circle or behind a blocker the runner may not see', () => {
    const out = evenOut(
      input(
        [ticket(1), ticket(2, { hiddenBlocker: true }), ticket(3), ticket(4, { assigneeId: null })],
        {
          links: [
            { from: 3, to: 4 },
            { from: 4, to: 3 },
          ],
        },
      ),
    );
    expect(entry(out, 3)).toMatchObject({ reason: 'cycle', args: { ticketIds: [4], size: 2 } });
    expect(why(out, 2)).toEqual(['not_placed', 'hidden_blocker']);
    // Only SPA-1 may move, so it does.
    expect(why(out, 1)).toEqual(['placed', 'moved_off_over']);
  });

  it('[PLN-011] warns when a moved ticket is due after its target release', () => {
    const out = evenOut(
      input([ticket(1), ticket(2), ticket(3, { release: { id: 70, date: '2026-11-28' } })]),
    );
    expect(entry(out, 3)?.warnings).toEqual([
      {
        kind: 'after_release',
        args: { releaseId: 70, releaseDate: '2026-11-28', days: 2 },
      },
    ]);
    expect(out.counts.warnings.after_release).toBe(1);
  });

  it('[PLN-011] counts the cells over capacity before a run, for readiness', () => {
    expect(countOverCells(input([ticket(1), ticket(2)]))).toBe(0);
    expect(countOverCells(input([ticket(1), ticket(2), ticket(3)]))).toBe(1);
    expect(
      countOverCells(
        input([ticket(1), ticket(2), ticket(3)], { people: [person(1, every(pts(15)))] }),
      ),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Properties (a) to (f) of ADR-122 stage 9, over random plans.

const DAY0 = dayNumber('2026-11-02');
const isoOf = (n: number) => isoDay(n);
/**
 * A ticket's first day: most work starts in the first weeks, so later periods have room to take
 * it, and a ticket with a higher id tends to start later, so links from lower ids are seldom late
 * and a move often pushes what they block.
 */
const ownDay = (id: number) =>
  fc.option(
    fc.integer({ min: 0, max: 12 }).map((n) => isoOf(DAY0 + id * 2 + n)),
    { nil: null, freq: 8 },
  );
/** One time in `n`, or never in a calm plan. */
const rarely = (calm: boolean, n = 8) =>
  calm ? fc.constant(false) : fc.integer({ min: 1, max: n }).map((x) => x === 1);

/**
 * Random plans with tight capacity, so many cells are over; links mostly from lower ids. Half are
 * calm (no rule keeps or leaves out a ticket), so that moves push long chains; half are messy.
 */
const planArb = fc
  .record({
    calm: fc.boolean(),
    n: fc.integer({ min: 2, max: 24 }),
    periods: fc.integer({ min: 1, max: 6 }),
    fromOffset: fc.integer({ min: 0, max: 10 }),
  })
  .chain(({ calm, n, periods, fromOffset }) => {
    const ticketArb = (id: number) =>
      fc
        .record({
          rank: fc.string({
            unit: fc.constantFrom('0', '9', 'A', 'Z', 'a', 'z'),
            minLength: 1,
            maxLength: 3,
          }),
          level: rarely(calm, 10).map((x) => (x ? 1 : 0)),
          typeId: rarely(calm, 10).map((x) => (x ? 2 : 1)),
          stage: (calm
            ? fc.constantFrom('new', 'new', 'new', 'new', 'closed')
            : fc.constantFrom(
                'new',
                'new',
                'new',
                'new',
                'new',
                'new',
                'active',
                'closed',
              )) as fc.Arbitrary<ScheduleTicket['stage']>,
          assigneeId: fc.option(fc.integer({ min: 1, max: 4 }), { nil: null, freq: 10 }),
          estimate: fc.option(fc.integer({ min: 0, max: 800 }), { nil: null, freq: 10 }),
          start: ownDay(id),
          length: fc.integer({ min: 0, max: 6 }),
          dueOnly: rarely(calm, 6),
          sprint: fc.option(
            fc.integer({ min: 0, max: 80 }).map((n) => ({
              start: isoOf(DAY0 + n),
              end: isoOf(DAY0 + n + 13),
            })),
            { nil: null, freq: 4 },
          ),
          inActiveSprint: rarely(calm, 10),
          release: fc.option(
            fc.integer({ min: 0, max: 90 }).map((n) => ({ id: 70, date: isoOf(DAY0 + n) })),
            { nil: null, freq: 3 },
          ),
          personDraft: rarely(calm, 10),
          maySchedule: rarely(calm, 12).map((x) => !x),
          leftOutByQuery: rarely(calm, 12),
          keptByQuery: rarely(calm, 12),
          hiddenBlocker: rarely(calm, 15),
        })
        .map(({ start, length, dueOnly, ...r }): ScheduleTicket => {
          const due = start === null ? null : isoOf(dayNumber(start) + length);
          return {
            ...r,
            id,
            key: `SPA-${id}`,
            typeId: r.typeId,
            releaseIds: [],
            start: dueOnly ? null : start,
            due,
          };
        });
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    return fc.record({
      tickets: fc.tuple(...ids.map(ticketArb)),
      links: fc.array(
        fc
          .record({
            a: fc.integer({ min: 1, max: n }),
            b: fc.integer({ min: 1, max: n }),
            back: rarely(calm, 12),
          })
          .map(({ a, b, back }) =>
            back ? { from: a, to: b } : { from: Math.min(a, b), to: Math.max(a, b) },
          ),
        { minLength: n, maxLength: n * 3 },
      ),
      teams: fc.array(
        fc.record({
          id: fc.integer({ min: 10, max: 12 }),
          members: fc.subarray([1, 2, 3, 4], { minLength: 1 }),
          capacity: fc.array(
            fc.option(
              fc.integer({ min: 0, max: 30 }).map((x) => x * 100),
              { nil: null, freq: 6 },
            ),
            { minLength: periods, maxLength: periods },
          ),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      people: fc.tuple(
        ...[1, 2, 3, 4].map((id) =>
          fc.record({
            id: fc.constant(id),
            capacity: fc.array(
              fc.option(
                fc.integer({ min: 0, max: 20 }).map((x) => x * 100),
                { nil: null, freq: 2 },
              ),
              { minLength: periods, maxLength: periods },
            ),
            load: fc.array(fc.integer({ min: 0, max: 400 }), {
              minLength: periods,
              maxLength: periods,
            }),
          }),
        ),
      ),
      from: fc.constant(isoOf(DAY0 + fromOffset)),
      periods: fc.constant(periods),
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
      leaveOut: { typeIds: [2], releaseIds: [] },
      keep: { inProgress: true, inActiveSprint: true },
    }),
  );

/** The class each ticket falls in, by the ADR's rules, computed apart from the engine. */
function classOf(run: ScheduleInput, t: ScheduleTicket) {
  if (t.stage === 'closed') return 'closed';
  if (t.level !== 0 || run.leaveOut.typeIds.includes(t.typeId) || t.leftOutByQuery)
    return 'left_out';
  if (t.personDraft || !t.maySchedule || t.keptByQuery || t.stage === 'active' || t.inActiveSprint)
    return 'kept';
  return 'movable';
}

/** The run's input with each proposal's days in place of the ticket's. */
function applied(run: ScheduleInput, out: EvenOutOutput): ScheduleInput {
  const at = new Map(out.proposals.map((p) => [p.id, p]));
  return {
    ...run,
    tickets: run.tickets.map((t) => {
      const p = at.get(t.id);
      return p ? { ...t, start: p.start, due: p.due } : t;
    }),
  };
}

/** The bar of a ticket by the one bar rule: its own days, else its sprint's. */
const bar = (t: ScheduleTicket) =>
  barDays(t.start, t.due) ??
  (t.sprint ? { start: dayNumber(t.sprint.start), end: dayNumber(t.sprint.end) } : null);

/** Every cell over capacity, as `team:<id>@<period start>` or `user:<id>@<period start>`. */
function overCells(run: ScheduleInput): Set<string> {
  const P = run.periods.length;
  const periodOf = (d: string) => {
    const n = dayNumber(d);
    return run.periods.findIndex((p) => n >= dayNumber(p.start) && n <= dayNumber(p.end));
  };
  const load = new Map<string, number>();
  const add = (key: string, v: number) => load.set(key, (load.get(key) ?? 0) + v);
  for (const person of run.people) {
    for (let p = 0; p < P; p++) {
      add(`user:${person.id}@${p}`, person.load[p] ?? 0);
      for (const t of run.teams)
        if (new Set(t.members).has(person.id)) add(`team:${t.id}@${p}`, person.load[p] ?? 0);
    }
  }
  for (const t of run.tickets) {
    if (t.due === null || t.assigneeId === null) continue;
    const p = periodOf(t.due);
    if (p < 0) continue;
    const est = t.estimate ?? 0;
    add(`user:${t.assigneeId}@${p}`, est);
    for (const team of run.teams)
      if (team.members.includes(t.assigneeId)) add(`team:${team.id}@${p}`, est);
  }
  const over = new Set<string>();
  for (let p = 0; p < P; p++) {
    const start = (run.periods[p] as Period).start;
    for (const t of run.teams) {
      const c = t.capacity[p] ?? null;
      if (c !== null && (load.get(`team:${t.id}@${p}`) ?? 0) > c) over.add(`team:${t.id}@${start}`);
    }
    for (const person of run.people) {
      const c = person.capacity[p] ?? null;
      if (c !== null && (load.get(`user:${person.id}@${p}`) ?? 0) > c)
        over.add(`user:${person.id}@${start}`);
    }
  }
  return over;
}

const shuffled = <T>(list: readonly T[], seed: number) => {
  const out = [...list];
  let x = seed;
  for (let i = out.length - 1; i > 0; i--) {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

describe('what evening out promises (PLN-011, properties)', () => {
  it('[PLN-011] draws random plans that move, push, undo and leave cells over', () => {
    const runs = fc.sample(planArb, { numRuns: 400, seed: 11 });
    const outs = runs.map(evenOut);
    const reason = (r: string) =>
      outs.reduce((n, o) => n + o.tickets.filter((t) => t.reason === r).length, 0);
    expect(reason('moved_off_over')).toBeGreaterThan(100);
    expect(reason('pushed_by_move')).toBeGreaterThan(40);
    expect(reason('would_make_late')).toBeGreaterThan(30);
    expect(reason('still_over')).toBeGreaterThan(100);
    expect(
      outs.reduce((n, o) => n + o.overLeft.filter((c) => c.onlyFixed).length, 0),
    ).toBeGreaterThan(10);
  });

  it('[PLN-011] (a) gives no kept, closed, left-out or other-level ticket a proposal (acceptance 2)', () => {
    fc.assert(
      fc.property(planArb, (run) => {
        const out = evenOut(run);
        const proposed = new Set(out.proposals.map((p) => p.id));
        for (const t of run.tickets) {
          if (classOf(run, t) !== 'movable') expect(proposed.has(t.id), `${t.id}`).toBe(false);
        }
      }),
    );
  });

  it('[PLN-011] (b) moves no ticket earlier, and each moved ticket keeps its length', () => {
    fc.assert(
      fc.property(planArb, (run) => {
        const out = evenOut(run);
        const byId = new Map(run.tickets.map((t) => [t.id, t]));
        for (const p of out.proposals) {
          const t = byId.get(p.id) as ScheduleTicket;
          // A day it had not stays so; both days it has move by the same number of days.
          expect(p.start === null, `${p.id} start`).toBe(t.start === null);
          expect(p.due === null, `${p.id} due`).toBe(t.due === null);
          const shifts = [
            t.start === null ? null : dayNumber(p.start as string) - dayNumber(t.start),
            t.due === null ? null : dayNumber(p.due as string) - dayNumber(t.due),
          ].filter((x): x is number => x !== null);
          for (const s of shifts) expect(s, `${p.id}`).toBeGreaterThanOrEqual(0);
          if (shifts.length === 2) expect(shifts[0], `${p.id}`).toBe(shifts[1]);
        }
      }),
    );
  });

  it('[PLN-011] [PLN-006] (c) makes no link late that was not late before (acceptance 2)', () => {
    fc.assert(
      fc.property(planArb, (run) => {
        const after = applied(run, evenOut(run));
        const was = new Map(run.tickets.map((t) => [t.id, t]));
        const now = new Map(after.tickets.map((t) => [t.id, t]));
        for (const l of run.links) {
          if (l.from === l.to) continue;
          const a0 = was.get(l.from) as ScheduleTicket;
          const b0 = was.get(l.to) as ScheduleTicket;
          if (a0.stage === 'closed' || b0.stage === 'closed') continue;
          const before = [bar(a0), bar(b0)];
          const later = [
            bar(now.get(l.from) as ScheduleTicket),
            bar(now.get(l.to) as ScheduleTicket),
          ];
          if (!before[0] || !before[1] || !later[0] || !later[1]) continue;
          if (isLate(before[0].end, before[1].start)) continue;
          expect(isLate(later[0].end, later[1].start), `${l.from} -> ${l.to}`).toBe(false);
        }
      }),
    );
  });

  it('[PLN-011] (d) leaves every cell within capacity or reported in overLeft (acceptance 3)', () => {
    fc.assert(
      fc.property(planArb, (run) => {
        const out = evenOut(run);
        const over = overCells(applied(run, out));
        const reported = new Set(
          out.overLeft.map((c) =>
            c.teamId !== undefined
              ? `team:${c.teamId}@${c.periodStart}`
              : `user:${c.userId}@${c.periodStart}`,
          ),
        );
        expect([...reported].sort()).toEqual([...over].sort());
        expect(countOverCells(applied(run, out))).toBe(over.size);
      }),
    );
  });

  it('[PLN-011] (e) answers the same in any input order, and a second run on its own output moves nothing', () => {
    fc.assert(
      fc.property(planArb, fc.integer({ min: 1, max: 1_000_000 }), (run, seed) => {
        const out = evenOut(run);
        const other = evenOut({
          ...run,
          tickets: shuffled(run.tickets, seed),
          links: shuffled(run.links, seed + 1),
          teams: shuffled(run.teams, seed + 2),
          people: shuffled(run.people, seed + 3),
        });
        expect(other).toEqual(out);
        const next = applied(run, out);
        const again = evenOut(next);
        expect(
          again.tickets.filter((t) => t.outcome === 'placed' && t.reason !== 'already'),
        ).toEqual([]);
        const byId = new Map(next.tickets.map((t) => [t.id, t]));
        for (const p of again.proposals) {
          const t = byId.get(p.id) as ScheduleTicket;
          expect([p.start, p.due], `${p.id}`).toEqual([t.start, t.due]);
        }
        expect(again.overLeft).toEqual(out.overLeft);
      }),
    );
  });

  it('[PLN-011] (f) drafts nothing in a plan with no cell over capacity', () => {
    fc.assert(
      fc.property(planArb, (tight) => {
        // The same plan with room to spare wherever a capacity is set.
        const roomy = (row: (number | null)[]) => row.map((c) => (c === null ? null : 10 ** 9));
        const run: ScheduleInput = {
          ...tight,
          teams: tight.teams.map((t) => ({ ...t, capacity: roomy(t.capacity) })),
          people: tight.people.map((p) => ({ ...p, capacity: roomy(p.capacity) })),
        };
        expect(countOverCells(run)).toBe(0);
        const out = evenOut(run);
        const byId = new Map(run.tickets.map((t) => [t.id, t]));
        for (const p of out.proposals) {
          const t = byId.get(p.id) as ScheduleTicket;
          expect([p.start, p.due], `${p.id}`).toEqual([t.start, t.due]);
        }
        expect(out.overLeft).toEqual([]);
      }),
    );
  });
});
