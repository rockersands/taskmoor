import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  type CriticalLink,
  type CriticalPathInput,
  type CriticalTicket,
  criticalPath,
} from './criticalPath';
import { dayNumber } from './periods';

const d = (day: string) => dayNumber(day);
const bar = (id: number, start: string, end: string): CriticalTicket => ({
  id,
  start: d(start),
  end: d(end),
});
const link = (from: number, to: number): CriticalLink => ({ from, to });
const slackOf = (input: CriticalPathInput) => Object.fromEntries(criticalPath(input).slack);

describe('criticalPath (PLN-011; ADR-122 stage 9)', () => {
  it('[PLN-011] gives every ticket of a chain that ends the plan slack 0, and a ticket beside it its slack', () => {
    // Acceptance 4: 1 -> 2 -> 3 ends the plan with no dependency late; 4 sits beside it.
    const input = {
      tickets: [
        bar(1, '2026-12-01', '2026-12-04'),
        bar(2, '2026-12-05', '2026-12-10'),
        bar(3, '2026-12-11', '2027-02-12'),
        bar(4, '2026-12-01', '2026-12-20'),
      ],
      links: [link(1, 2), link(2, 3)],
    };
    const path = criticalPath(input);
    expect(path.planEnd).toBe(d('2027-02-12'));
    expect(slackOf(input)).toEqual({ 1: 0, 2: 0, 3: 0, 4: d('2027-02-12') - d('2026-12-20') });
    expect(path.critical).toEqual([1, 2, 3]);
    expect(path.chains).toEqual([[1, 2, 3]]);
    expect(path.cycles).toEqual([]);
  });

  it('[PLN-011] gives a parallel blocker the days until the ticket it blocks must start', () => {
    // 4 blocks 3, which may start no later than 11 Dec: 4 may end as late as 10 Dec.
    const input = {
      tickets: [
        bar(1, '2026-12-01', '2026-12-04'),
        bar(2, '2026-12-05', '2026-12-10'),
        bar(3, '2026-12-11', '2026-12-20'),
        bar(4, '2026-12-01', '2026-12-03'),
      ],
      links: [link(1, 2), link(2, 3), link(4, 3)],
    };
    expect(slackOf(input)).toEqual({ 1: 0, 2: 0, 3: 0, 4: 7 });
  });

  it('[PLN-011] counts a gap on the chain as slack for the tickets before it', () => {
    // Two free days between 1 and 2: 1 may slip by two days.
    const input = {
      tickets: [bar(1, '2026-12-01', '2026-12-04'), bar(2, '2026-12-07', '2026-12-10')],
      links: [link(1, 2)],
    };
    const path = criticalPath(input);
    expect(Object.fromEntries(path.slack)).toEqual({ 1: 2, 2: 0 });
    expect(path.chains).toEqual([[2]]);
  });

  it('[PLN-011] reads a ticket dated by its sprint by the sprint’s days, crossing a year’s end', () => {
    // The route hands a sprint-dated ticket its sprint's days: 2 is in a sprint of 21 Dec to 3 Jan.
    const input = {
      tickets: [bar(1, '2026-12-14', '2026-12-20'), bar(2, '2026-12-21', '2027-01-03')],
      links: [link(1, 2)],
    };
    const path = criticalPath(input);
    expect(path.planEnd).toBe(d('2027-01-03'));
    expect(path.chains).toEqual([[1, 2]]);
  });

  it('[PLN-011] gives the tickets of a circle no slack and counts them', () => {
    const input = {
      tickets: [
        bar(1, '2026-12-01', '2026-12-04'),
        bar(2, '2026-12-05', '2026-12-10'),
        bar(3, '2026-12-11', '2026-12-20'),
        bar(4, '2026-12-01', '2026-12-02'),
      ],
      links: [link(1, 2), link(2, 1), link(2, 3), link(4, 4)],
    };
    const path = criticalPath(input);
    expect(path.cycles).toEqual([1, 2, 4]);
    expect(Object.fromEntries(path.slack)).toEqual({ 3: 0 });
    expect(path.critical).toEqual([3]);
    expect(path.chains).toEqual([[3]]);
  });

  it('[PLN-011] lets a blocker that is not read (a closed one) hold nothing', () => {
    // 9 is closed, so the route leaves it out: its link is dropped and 2 is not held by it.
    const input = {
      tickets: [bar(1, '2026-12-01', '2026-12-20'), bar(2, '2026-12-01', '2026-12-04')],
      links: [link(9, 2), link(2, 9)],
    };
    expect(slackOf(input)).toEqual({ 1: 0, 2: 16 });
  });

  it('[PLN-011] gives negative slack where a dependency is already late', () => {
    // 2 starts before 1 ends: the chain is three days late.
    const input = {
      tickets: [bar(1, '2026-12-01', '2026-12-10'), bar(2, '2026-12-08', '2026-12-12')],
      links: [link(1, 2)],
    };
    const path = criticalPath(input);
    expect(Object.fromEntries(path.slack)).toEqual({ 1: -3, 2: 0 });
    expect(path.chains).toEqual([[1, 2]]);
  });

  it('[PLN-011] lists two tied chains, the earlier first, and a branch as a chain of its own', () => {
    const input = {
      tickets: [
        // 1 -> 2 and 3 -> 4 both end on 10 Dec; 3 starts first.
        bar(1, '2026-12-02', '2026-12-05'),
        bar(2, '2026-12-06', '2026-12-10'),
        bar(3, '2026-12-01', '2026-12-05'),
        bar(4, '2026-12-06', '2026-12-10'),
        // 5 -> 6 -> 7 and 5 -> 8, every link tight.
        bar(5, '2026-11-20', '2026-11-25'),
        bar(6, '2026-11-26', '2026-11-30'),
        bar(7, '2026-12-01', '2026-12-10'),
        bar(8, '2026-11-26', '2026-12-10'),
      ],
      links: [link(1, 2), link(3, 4), link(5, 6), link(6, 7), link(5, 8)],
    };
    const path = criticalPath(input);
    expect(path.critical).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(path.chains).toEqual([[5, 6, 7], [3, 4], [1, 2], [8]]);
  });

  it('[PLN-011] answers nothing for no tickets, and takes a single day as both start and end', () => {
    expect(criticalPath({ tickets: [], links: [] })).toEqual({
      planEnd: null,
      slack: new Map(),
      critical: [],
      chains: [],
      cycles: [],
    });
    const path = criticalPath({ tickets: [bar(1, '2026-12-01', '2026-12-01')], links: [] });
    expect(path.chains).toEqual([[1]]);
  });

  // Plans with no late link: tickets in index order, a link only from an earlier ticket to a
  // later one that starts after it ends. Ids differ from indexes and the input is shuffled.
  const planArb = fc
    .array(fc.tuple(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 10 })), {
      minLength: 1,
      maxLength: 25,
    })
    .chain((bars) =>
      fc
        .array(fc.tuple(fc.nat(bars.length - 1), fc.nat(bars.length - 1)), { maxLength: 60 })
        .map((pairs) => {
          const tickets = bars.map(([start, length], i) => ({
            id: 100 + i * 7,
            start,
            end: start + length,
          }));
          const links = pairs.flatMap(([a, b]) => {
            const [x, y] = a < b ? [a, b] : [b, a];
            const from = tickets[x] as CriticalTicket;
            const to = tickets[y] as CriticalTicket;
            return x !== y && to.start > from.end ? [{ from: from.id, to: to.id }] : [];
          });
          return { tickets, links };
        }),
    )
    .chain((plan) =>
      fc
        .tuple(fc.shuffledSubarray(plan.tickets, { minLength: plan.tickets.length }), fc.nat())
        .map(([shuffled, pick]) => ({ ...plan, shuffled, pick })),
    );

  /** Delays one ticket and pushes what it blocks by the least amount; answers the plan's end. */
  const delayed = (input: CriticalPathInput, id: number, days: number): number => {
    const tickets = [...input.tickets].sort((a, b) => a.id - b.id);
    const at = new Map(tickets.map((t) => [t.id, { ...t }]));
    const moved = at.get(id) as CriticalTicket;
    moved.start += days;
    moved.end += days;
    for (const t of tickets) {
      const now = at.get(t.id) as CriticalTicket;
      let earliest = Number.NEGATIVE_INFINITY;
      for (const l of input.links)
        if (l.to === t.id)
          earliest = Math.max(earliest, (at.get(l.from) as CriticalTicket).end + 1);
      if (now.start < earliest) {
        const shift = earliest - now.start;
        now.start += shift;
        now.end += shift;
      }
    }
    return Math.max(...[...at.values()].map((t) => t.end));
  };

  it('[PLN-011] delays the plan’s end by exactly one day when a ticket of slack 0 slips a day', () => {
    fc.assert(
      fc.property(planArb, ({ tickets, links, pick }) => {
        const input = { tickets, links };
        const path = criticalPath(input);
        const zero = [...path.slack].filter(([, s]) => s === 0).map(([id]) => id);
        const id = zero[pick % zero.length] as number;
        expect(delayed(input, id, 1)).toBe((path.planEnd as number) + 1);
      }),
    );
  });

  it('[PLN-011] leaves the plan’s end where it is when a ticket slips by its slack', () => {
    fc.assert(
      fc.property(planArb, ({ tickets, links, pick }) => {
        const input = { tickets, links };
        const path = criticalPath(input);
        const all = [...path.slack];
        const [id, s] = all[pick % all.length] as [number, number];
        expect(s).toBeGreaterThanOrEqual(0);
        expect(delayed(input, id, s)).toBe(path.planEnd);
        if (s > 0) expect(delayed(input, id, s + 1)).toBe((path.planEnd as number) + 1);
      }),
    );
  });

  it('[PLN-011] puts each critical ticket in one chain of tight links, whatever the input order', () => {
    fc.assert(
      fc.property(planArb, ({ tickets, links, shuffled }) => {
        const path = criticalPath({ tickets, links });
        const again = criticalPath({ tickets: shuffled, links: [...links].reverse() });
        expect(again).toEqual(path);
        expect(path.chains.flat().sort((a, b) => a - b)).toEqual(path.critical);
        const byId = new Map(tickets.map((t) => [t.id, t]));
        const linked = new Set(links.map((l) => `${l.from}>${l.to}`));
        for (const chain of path.chains) {
          for (let i = 1; i < chain.length; i++) {
            const a = chain[i - 1] as number;
            const b = chain[i] as number;
            expect(linked.has(`${a}>${b}`)).toBe(true);
            const gap =
              (byId.get(b) as CriticalTicket).start - (byId.get(a) as CriticalTicket).end - 1;
            expect(gap).toBe((path.slack.get(a) as number) - (path.slack.get(b) as number));
          }
        }
        // With no late link, some chain ends on the plan's end.
        expect(path.chains.some((c) => byId.get(c.at(-1) as number)?.end === path.planEnd)).toBe(
          true,
        );
      }),
    );
  });
});
