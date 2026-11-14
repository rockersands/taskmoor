import { expectWithinBudget } from '@taskmoor/testkit/budget';
import { describe, expect, it } from 'vitest';
import { periodsFrom } from './periods';
import {
  movableCount,
  type ScheduleInput,
  type SchedulePerson,
  type ScheduleTeam,
  type ScheduleTicket,
  schedule,
} from './scheduler';

/**
 * The engine alone at size (PLN-012; ADR-122 stage 7, "Limits and performance"): 10,000 movable
 * tickets, 20,000 links, 50 teams, 300 people and 12 periods, under 300 ms. Made from a fixed
 * seed, so every run schedules the same plan.
 */
const TICKETS = 10_000;
const LINKS = 20_000;
const TEAMS = 50;
const PEOPLE = 300;
const PERIODS = 12;
const RUNS = 3;
const median = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] as number;

function plan(): ScheduleInput {
  let seed = 20_261_114;
  const next = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed % n;
  };
  const from = '2026-11-16';
  const periods = periodsFrom({ kind: 'weeks', weeks: 2, anchor: from }, from, PERIODS);
  const people: SchedulePerson[] = Array.from({ length: PEOPLE }, (_, i) => ({
    id: i + 1,
    capacity: new Array<number | null>(PERIODS).fill(i % 3 === 0 ? 4_000 : null),
    load: Array.from({ length: PERIODS }, () => next(800)),
  }));
  const teams: ScheduleTeam[] = Array.from({ length: TEAMS }, (_, t) => ({
    id: 1_000 + t,
    // Six members each; every tenth person is in a second team too.
    members: [
      ...Array.from({ length: PEOPLE / TEAMS }, (_, m) => t * (PEOPLE / TEAMS) + m + 1),
      ((t + 1) * 10) % PEOPLE || PEOPLE,
    ],
    capacity: Array.from({ length: PERIODS }, () => 8_000 + next(8_000)),
  }));
  const tickets: ScheduleTicket[] = Array.from({ length: TICKETS }, (_, i) => ({
    id: i + 1,
    key: `BIG-${i + 1}`,
    rank: `a${String(next(1_000_000)).padStart(6, '0')}`,
    level: 0,
    typeId: 1,
    stage: 'new',
    assigneeId: next(PEOPLE) + 1,
    estimate: 100 * (1 + next(13)),
    start: null,
    due: null,
    sprint: null,
    inActiveSprint: false,
    releaseIds: [],
    release: next(10) === 0 ? { id: 1, date: '2027-01-15' } : null,
    personDraft: false,
    maySchedule: true,
    leftOutByQuery: false,
    keptByQuery: false,
    hiddenBlocker: false,
  }));
  // Links from a lower id to a higher one nearby, so chains are long and circles none.
  const links = Array.from({ length: LINKS }, () => {
    const a = next(TICKETS - 1) + 1;
    const b = Math.min(TICKETS, a + 1 + next(200));
    return { from: a, to: b };
  });
  return {
    from,
    periods,
    tickets,
    links,
    teams,
    people,
    leaveOut: { typeIds: [], releaseIds: [] },
    keep: { inProgress: true, inActiveSprint: true },
  };
}

describe(`the auto-scheduler's engine on ${TICKETS.toLocaleString('en')} tickets (PLN-004, PLN-012)`, () => {
  it('[PLN-004] [PLN-012] schedules 10,000 tickets, 20,000 links, 50 teams, 300 people and 12 periods under 300 ms', () => {
    const input = plan();
    // Once to warm the code up, then the median of the timed runs.
    const first = schedule(input);
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      const out = schedule(input);
      samples.push(performance.now() - t0);
      expect(out.counts).toEqual(first.counts);
    }
    const c = first.counts;
    expect(movableCount(c)).toBe(TICKETS);
    expect(first.tickets).toHaveLength(TICKETS);
    expect(c.placed).toBeGreaterThan(1_000);
    expect(c.notPlaced.no_room).toBeGreaterThan(0);
    expectWithinBudget(median(samples), 300, 'the auto-scheduler on 10,000 tickets');
  });
});
