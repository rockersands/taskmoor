import type {
  CapacityCell,
  CapacityEntry,
  CapacityOf,
  CapacityPerson,
  CapacityUnit,
  CapacityWork,
  PlanCapacity,
  PlanFilters,
  PlanPeriod,
  PlanTimelineItem,
} from './client';

/**
 * Teams and capacity for the fake plan (PLN-005, PLN-009): "Spring launch" plans with Web (Ana
 * and Bo) and Ops (Cy), in two-week periods from Monday 2026-11-02, in points. SHOP-2 (5 points)
 * and OPS-4 (3) are Ana's, SHOP-3 (8) is Bo's; OPS-5 has no due day. Ana also has 13 points
 * elsewhere (outside the plan or hidden) in the first period, so with 10 a period she is over.
 * Capacity set is kept, so a story or test sees its change after saving.
 */
const DAY = 86_400_000;
const day = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const num = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / DAY);

export const PLAN_PERIOD: PlanPeriod = { kind: 'weeks', weeks: 2, anchor: '2026-11-02' };
export const PLAN_TEAMS = [
  { id: 3, name: 'Web' },
  { id: 4, name: 'Ops' },
];
const MEMBERS: Record<number, { id: number; name: string; active: boolean }[]> = {
  3: [
    { id: 7, name: 'Ana Ruiz', active: true },
    { id: 8, name: 'Bo Lindqvist', active: true },
  ],
  4: [{ id: 9, name: 'Cy Okafor', active: true }],
};
const POINTS: Record<string, number> = { 'SHOP-2': 5, 'SHOP-3': 8, 'OPS-4': 3 };
/** Ana's work elsewhere, by period index: hidden from the viewer or outside the plan. */
const ELSEWHERE: Record<number, Record<number, { count: number; amount: number }>> = {
  7: { 0: { count: 1, amount: 13 } },
};

/** The periods of the fake plan, from the one holding `from`. */
function periodsFrom(from: string, count: number) {
  const anchor = num('2026-11-02');
  const first = anchor + Math.floor((num(from) - anchor) / 14) * 14;
  return Array.from({ length: count }, (_, i) => {
    const start = first + i * 14;
    return { start: day(start), end: day(start + 13) };
  });
}

export function fakeCapacity() {
  /** Capacity set, by `team:3@2026-11-02` (or `@*` for every period). */
  const set = new Map<string, { amount: number; note: string }>([
    ['team:3@*', { amount: 20, note: '' }],
    ['user:7@*', { amount: 10, note: '' }],
    ['user:7@2026-11-16', { amount: 0, note: 'Leave' }],
  ]);
  const saved: CapacityEntry[][] = [];

  function answer(
    items: PlanTimelineItem[],
    query: string | null,
    filters: PlanFilters,
    from: string,
    count: number,
    editable: boolean,
    unit: CapacityUnit = 'points',
  ): PlanCapacity {
    void filters;
    const periods = periodsFrom(from, count);
    const work = (who: (i: PlanTimelineItem) => boolean, p?: { start: string; end: string }) => {
      const found = items.filter(
        (i) =>
          who(i) &&
          (p ? i.due !== null && i.due >= p.start && i.due <= p.end : i.due === null) &&
          (p || i.status.stage !== 'closed'),
      );
      return {
        count: found.length,
        amount: found.reduce((s, i) => s + (POINTS[i.key] ?? 0), 0),
        unestimated: found.filter((i) => POINTS[i.key] === undefined).length,
      };
    };
    const capacityOf = (key: string): CapacityOf => {
      const fallback = set.get(`${key}@*`) ?? null;
      return {
        default: fallback,
        periods: periods.map((p) => {
          const own = set.get(`${key}@${p.start}`);
          const c = own ?? fallback;
          return {
            amount: c?.amount ?? null,
            note: c?.note ?? '',
            from: own ? 'period' : fallback ? 'default' : null,
          };
        }),
      };
    };
    const cells = (
      w: CapacityWork[],
      elsewhere: { count: number; amount: number }[],
      c: CapacityOf,
    ): CapacityCell[] =>
      w.map((x, i) => {
        const e = elsewhere[i] ?? { count: 0, amount: 0 };
        const load = x.amount + e.amount;
        const limit = c.periods[i]?.amount ?? null;
        return { ...x, elsewhere: e, load, over: limit !== null && load > limit };
      });
    const person = (m: { id: number; name: string; active: boolean }): CapacityPerson => {
      const mine = (i: PlanTimelineItem) => i.assignee?.id === m.id;
      const c = capacityOf(`user:${m.id}`);
      return {
        ...m,
        clause: `assignee = ${m.id}`,
        capacity: c,
        cells: cells(
          periods.map((p) => work(mine, p)),
          periods.map((_, i) => ELSEWHERE[m.id]?.[i] ?? { count: 0, amount: 0 }),
          c,
        ),
        unscheduled: work(mine),
      };
    };
    const add = (a: CapacityWork, b: CapacityWork) => ({
      count: a.count + b.count,
      amount: a.amount + b.amount,
      unestimated: a.unestimated + b.unestimated,
    });
    const zero = { count: 0, amount: 0, unestimated: 0 };
    const teams = PLAN_TEAMS.map((team) => {
      const members = (MEMBERS[team.id] ?? []).map(person);
      const own = capacityOf(`team:${team.id}`);
      const capacity: CapacityOf = {
        default: own.default,
        periods: own.periods.map((c, i) => {
          if (c.amount !== null) return c;
          const of = members.flatMap((m) => {
            const x = m.capacity.periods[i]?.amount;
            return x === null || x === undefined ? [] : [x];
          });
          return of.length === 0
            ? c
            : { amount: of.reduce((a, b) => a + b, 0), note: '', from: 'members' as const };
        }),
      };
      const w = periods.map((_, i) =>
        members.reduce((s, m) => add(s, m.cells[i] as CapacityWork), zero),
      );
      const e = periods.map((_, i) =>
        members.reduce(
          (s, m) => ({
            count: s.count + (m.cells[i]?.elsewhere.count ?? 0),
            amount: s.amount + (m.cells[i]?.elsewhere.amount ?? 0),
          }),
          { count: 0, amount: 0 },
        ),
      );
      return {
        id: team.id,
        name: team.name,
        clause: `assignee IN membersOf("id:${team.id}")`,
        capacity,
        cells: cells(w, e, capacity),
        unscheduled: members.reduce((s, m) => add(s, m.unscheduled), zero),
        members,
      };
    });
    const inTeams = new Set(Object.values(MEMBERS).flatMap((list) => list.map((m) => m.id)));
    const nobody = (i: PlanTimelineItem) => i.assignee === null;
    const others = (i: PlanTimelineItem) => i.assignee !== null && !inTeams.has(i.assignee.id);
    const first = periods[0]?.start as string;
    const last = periods.at(-1)?.end as string;
    return structuredClone({
      query,
      editable,
      unit,
      pointsField: { id: 10, name: 'Points' },
      period: PLAN_PERIOD,
      periods: periods.map((p) => ({
        ...p,
        clause: `due >= "${p.start}" AND due <= "${p.end}"`,
      })),
      previous: day(num(first) - 14 * count),
      next: day(num(last) + 1),
      unscheduledClause: 'stage != closed AND due IS EMPTY',
      teams,
      unassigned: {
        clause: 'assignee IS EMPTY',
        cells: periods.map((p) => work(nobody, p)),
        unscheduled: work(nobody),
      },
      others: {
        clause: 'assignee NOT IN membersOf("id:3") AND assignee NOT IN membersOf("id:4")',
        cells: periods.map((p) => work(others, p)),
        unscheduled: work(others),
      },
    });
  }

  async function setCapacity(entries: CapacityEntry[]): Promise<true | string> {
    saved.push(entries);
    for (const e of entries) {
      const key = `${e.teamId ? `team:${e.teamId}` : `user:${e.userId}`}@${e.period ?? '*'}`;
      if (e.amount === null) set.delete(key);
      else set.set(key, { amount: e.amount, note: e.note ?? set.get(key)?.note ?? '' });
    }
    return true;
  }

  return { answer, setCapacity, saved };
}
