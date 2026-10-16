import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  applyChange,
  BUILTIN_LEVELS,
  breaksTickets,
  checkParent,
  checkTypeChange,
  forestProblems,
  type Hierarchy,
  type HierarchyChange,
  hierarchyImpact,
  type Level,
  ladderProblem,
  type ParentRules,
  parentLevelAllowed,
  SUBTICKET_RANK,
  type TicketNode,
  typeRanks,
} from './hierarchy';

/** The default ladder plus `custom` levels above the Outcome level. */
function ladder(custom: number): Level[] {
  const levels: Level[] = [
    { id: 1, kind: 'subticket', rank: -1 },
    { id: 2, kind: 'standard', rank: 0 },
    { id: 3, kind: 'outcome', rank: 1 },
  ];
  for (let i = 0; i < custom; i++) levels.push({ id: 4 + i, kind: 'custom', rank: 2 + i });
  return levels;
}

/** A ladder with one ticket type per level and up to six more at random levels. */
const hierarchyArb: fc.Arbitrary<Hierarchy> = fc.integer({ min: 0, max: 4 }).chain((custom) => {
  const levels = ladder(custom);
  return fc.array(fc.constantFrom(...levels.map((l) => l.id)), { maxLength: 6 }).map((extra) => ({
    levels,
    types: [...levels.map((l) => l.id), ...extra].map((levelId, i) => ({ id: 100 + i, levelId })),
  }));
});

const rulesArb: fc.Arbitrary<ParentRules> = fc.boolean().map((skipLevels) => ({ skipLevels }));

interface TicketSpec {
  type: number;
  parent: number;
  wantsParent: boolean;
}
const ticketSpecs = fc.array(
  fc.record({ type: fc.nat(), parent: fc.nat(), wantsParent: fc.boolean() }),
  { maxLength: 30 },
);

const rankIn = (ranks: Map<number, number>, typeId: number) => ranks.get(typeId) as number;

/**
 * A valid forest built from random specs: tickets are placed top level first, each under a
 * random ticket its level may hang under (or none), and subtickets with no possible parent
 * are left out.
 */
function buildForest(
  hierarchy: Hierarchy,
  specs: readonly TicketSpec[],
  rules: ParentRules,
): Map<number, TicketNode> {
  const ranks = typeRanks(hierarchy);
  const typeIds = hierarchy.types.map((t) => t.id);
  const planned = specs.map((spec, i) => ({
    id: 1000 + i,
    typeId: typeIds[spec.type % typeIds.length] as number,
    spec,
  }));
  planned.sort((a, b) => rankIn(ranks, b.typeId) - rankIn(ranks, a.typeId) || a.id - b.id);
  const placed: TicketNode[] = [];
  for (const { id, typeId, spec } of planned) {
    const rank = rankIn(ranks, typeId);
    const candidates = placed.filter((p) =>
      parentLevelAllowed(rank, rankIn(ranks, p.typeId), rules),
    );
    let parentId: number | null = null;
    if (candidates.length > 0 && (spec.wantsParent || rank === SUBTICKET_RANK)) {
      parentId = (candidates[spec.parent % candidates.length] as TicketNode).id;
    }
    if (parentId === null && rank === SUBTICKET_RANK) continue;
    placed.push({ id, typeId, parentId });
  }
  return new Map(placed.map((t) => [t.id, t]));
}

const worldArb = fc.tuple(hierarchyArb, ticketSpecs, rulesArb).map(([hierarchy, specs, rules]) => ({
  hierarchy,
  rules,
  tickets: buildForest(hierarchy, specs, rules),
}));

type Op =
  | { kind: 'move'; ticket: number; parent: number | null }
  | { kind: 'type'; ticket: number; type: number };
const opsArb: fc.Arbitrary<Op[]> = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant('move' as const),
      ticket: fc.nat(),
      parent: fc.option(fc.nat(), { nil: null }),
    }),
    fc.record({ kind: fc.constant('type' as const), ticket: fc.nat(), type: fc.nat() }),
  ),
  { maxLength: 40 },
);

const pick = <T>(list: readonly T[], n: number) => list[n % list.length] as T;

function withParent(tickets: Map<number, TicketNode>, id: number, parentId: number | null) {
  const next = new Map(tickets);
  next.set(id, { ...(tickets.get(id) as TicketNode), parentId });
  return next;
}
function withType(tickets: Map<number, TicketNode>, id: number, typeId: number) {
  const next = new Map(tickets);
  next.set(id, { ...(tickets.get(id) as TicketNode), typeId });
  return next;
}

/** Walks every ticket to its root; a cycle never reaches one. */
function acyclic(tickets: ReadonlyMap<number, TicketNode>): boolean {
  for (const start of tickets.values()) {
    let current: TicketNode | undefined = start;
    for (let steps = 0; current?.parentId != null; steps++) {
      if (steps > tickets.size) return false;
      current = tickets.get(current.parentId);
    }
  }
  return true;
}

function isDescendant(tickets: ReadonlyMap<number, TicketNode>, of: number, id: number): boolean {
  let current = tickets.get(id);
  for (let steps = 0; current && steps <= tickets.size; steps++) {
    if (current.id === of) return true;
    current = current.parentId === null ? undefined : tickets.get(current.parentId);
  }
  return false;
}

const problemSet = (problems: { ticketId: number; problem: string }[]) =>
  problems.map((p) => `${p.ticketId}:${p.problem}`).sort();

describe('hierarchy levels (CORE-006)', () => {
  const changeArb = (hierarchy: Hierarchy) =>
    fc.oneof(
      fc.record({
        kind: fc.constant('insert' as const),
        levelId: fc.integer({ min: 50, max: 99 }),
        rank: fc.option(fc.integer({ min: -2, max: 9 }), { nil: undefined }),
      }),
      fc.record({
        kind: fc.constant('move' as const),
        levelId: fc.constantFrom(...hierarchy.levels.map((l) => l.id), 999),
        rank: fc.integer({ min: -2, max: 9 }),
      }),
      fc.record({
        kind: fc.constant('remove' as const),
        levelId: fc.constantFrom(...hierarchy.levels.map((l) => l.id), 999),
      }),
      fc.record({
        kind: fc.constant('retype' as const),
        typeId: fc.constantFrom(...hierarchy.types.map((t) => t.id)),
        levelId: fc.constantFrom(...hierarchy.levels.map((l) => l.id)),
      }),
    ) as fc.Arbitrary<HierarchyChange>;

  it('[CORE-006] seeds the subticket, standard and Outcome levels at -1, 0 and 1', () => {
    expect(ladderProblem(ladder(0))).toBeNull();
    expect(BUILTIN_LEVELS).toEqual({
      subticket: { rank: -1, name: 'Subticket' },
      standard: { rank: 0, name: 'Standard' },
      outcome: { rank: 1, name: 'Outcome' },
    });
    expect(ladderProblem(ladder(0).filter((l) => l.kind !== 'outcome'))).toBe('missing_builtin');
    expect(ladderProblem([...ladder(1), { id: 9, kind: 'custom', rank: 4 }])).toBe('gap');
    expect(ladderProblem([...ladder(1), { id: 9, kind: 'custom', rank: 2 }])).toBe(
      'duplicate_rank',
    );
  });

  it('[CORE-006] keeps the ladder gapless with fixed built-in levels under random level changes', () => {
    fc.assert(
      fc.property(
        hierarchyArb.chain((h) =>
          fc.tuple(fc.constant(h), fc.array(changeArb(h), { maxLength: 25 })),
        ),
        ([start, changes]) => {
          let hierarchy = start;
          let nextId = 200;
          for (const raw of changes) {
            // New levels get fresh ids; other changes may name levels removed by now.
            const change: HierarchyChange =
              raw.kind === 'insert' ? { ...raw, levelId: nextId++ } : raw;
            const result = applyChange(hierarchy, change);
            if (!result.ok) {
              if (change.kind === 'remove' || change.kind === 'move') {
                const level = hierarchy.levels.find((l) => l.id === change.levelId);
                if (level && level.kind !== 'custom') expect(result.problem).toBe('builtin_level');
              }
              continue;
            }
            hierarchy = result.hierarchy;
            expect(ladderProblem(hierarchy.levels)).toBeNull();
            // Every type still sits at a level that exists; none is lost.
            expect(hierarchy.types.map((t) => t.id)).toEqual(start.types.map((t) => t.id));
            const ids = new Set(hierarchy.levels.map((l) => l.id));
            for (const type of hierarchy.types) expect(ids.has(type.levelId)).toBe(true);
          }
        },
      ),
    );
  });

  it('[CORE-006] adds levels 2 and 3, and a level-3 ticket parents level-2 tickets only', () => {
    let h: Hierarchy = { levels: ladder(0), types: [] };
    for (const id of [4, 5]) {
      const added = applyChange(h, { kind: 'insert', levelId: id });
      if (!added.ok) throw new Error(added.problem);
      h = added.hierarchy;
    }
    expect(h.levels.map((l) => [l.id, l.rank])).toEqual([
      [1, -1],
      [2, 0],
      [3, 1],
      [4, 2],
      [5, 3],
    ]);
    // Several types per level: two at level 2.
    h = {
      ...h,
      types: [
        { id: 10, levelId: 5 },
        { id: 11, levelId: 4 },
        { id: 12, levelId: 4 },
        { id: 13, levelId: 3 },
      ],
    };
    const tickets = new Map<number, TicketNode>([
      [1, { id: 1, typeId: 10, parentId: null }],
      [2, { id: 2, typeId: 11, parentId: null }],
      [3, { id: 3, typeId: 12, parentId: null }],
      [4, { id: 4, typeId: 13, parentId: null }],
    ]);
    expect(checkParent(h, tickets, 2, 1)).toBeNull();
    expect(checkParent(h, tickets, 3, 1)).toBeNull();
    expect(checkParent(h, tickets, 4, 1)).toBe('wrong_level');
    expect(checkParent(h, tickets, 4, 1, { skipLevels: true })).toBeNull();
    expect(checkParent(h, tickets, 1, 2)).toBe('wrong_level');
    expect(checkParent(h, tickets, 1, 1)).toBe('self');
  });

  it('[CORE-006] refuses to move or remove the built-in levels and keeps custom ranks above 1', () => {
    const h: Hierarchy = { levels: ladder(2), types: [] };
    for (const levelId of [1, 2, 3]) {
      expect(applyChange(h, { kind: 'remove', levelId })).toEqual({
        ok: false,
        problem: 'builtin_level',
      });
      expect(applyChange(h, { kind: 'move', levelId, rank: 2 })).toEqual({
        ok: false,
        problem: 'builtin_level',
      });
    }
    for (const rank of [-1, 0, 1, 5]) {
      expect(applyChange(h, { kind: 'insert', levelId: 9, rank })).toEqual({
        ok: false,
        problem: 'rank_out_of_range',
      });
    }
    expect(applyChange(h, { kind: 'move', levelId: 4, rank: 4 })).toEqual({
      ok: false,
      problem: 'rank_out_of_range',
    });
  });
});

describe('parent rules under random moves (CORE-006, M1-007 done-when)', () => {
  it('[CORE-006] accepts exactly the parent changes that keep every rule', () => {
    fc.assert(
      fc.property(worldArb, fc.nat(), fc.option(fc.nat(), { nil: null }), (world, t, p) => {
        const { hierarchy, rules, tickets } = world;
        fc.pre(tickets.size > 0);
        expect(forestProblems(hierarchy, tickets, rules)).toEqual([]);
        const ids = [...tickets.keys()];
        const ticketId = pick(ids, t);
        const parentId = p === null ? null : pick(ids, p);
        const verdict = checkParent(hierarchy, tickets, ticketId, parentId, rules);
        const after = forestProblems(hierarchy, withParent(tickets, ticketId, parentId), rules);
        expect(verdict === null, `${verdict} vs ${JSON.stringify(after)}`).toBe(after.length === 0);
      }),
    );
  });

  it('[CORE-006] reports a cycle for every parent that is the ticket or one of its descendants', () => {
    fc.assert(
      fc.property(worldArb, fc.nat(), fc.nat(), (world, t, p) => {
        const { hierarchy, rules, tickets } = world;
        fc.pre(tickets.size > 0);
        const ids = [...tickets.keys()];
        const ticketId = pick(ids, t);
        const parentId = pick(ids, p);
        const verdict = checkParent(hierarchy, tickets, ticketId, parentId, rules);
        if (parentId === ticketId) expect(verdict).toBe('self');
        else expect(verdict === 'cycle').toBe(isDescendant(tickets, ticketId, parentId));
      }),
    );
  });

  it('[CORE-006] accepts exactly the type changes that keep every rule', () => {
    fc.assert(
      fc.property(worldArb, fc.nat(), fc.nat(), (world, t, k) => {
        const { hierarchy, rules, tickets } = world;
        fc.pre(tickets.size > 0);
        const ticketId = pick([...tickets.keys()], t);
        const typeId = pick(hierarchy.types, k).id;
        const verdict = checkTypeChange(hierarchy, tickets, ticketId, typeId, rules);
        const after = forestProblems(hierarchy, withType(tickets, ticketId, typeId), rules);
        expect(verdict === null, `${verdict} vs ${JSON.stringify(after)}`).toBe(after.length === 0);
      }),
    );
  });

  it('[CORE-006] keeps the forest free of cycles and level breaches under random moves', () => {
    fc.assert(
      fc.property(worldArb, opsArb, (world, ops) => {
        const { hierarchy, rules } = world;
        let tickets = world.tickets;
        fc.pre(tickets.size > 0);
        const ids = [...tickets.keys()];
        for (const op of ops) {
          const ticketId = pick(ids, op.ticket);
          if (op.kind === 'move') {
            const parentId = op.parent === null ? null : pick(ids, op.parent);
            if (checkParent(hierarchy, tickets, ticketId, parentId, rules) !== null) continue;
            tickets = withParent(tickets, ticketId, parentId);
          } else {
            const typeId = pick(hierarchy.types, op.type).id;
            if (checkTypeChange(hierarchy, tickets, ticketId, typeId, rules) !== null) continue;
            tickets = withType(tickets, ticketId, typeId);
          }
          expect(acyclic(tickets)).toBe(true);
          expect(forestProblems(hierarchy, tickets, rules)).toEqual([]);
        }
        // Every ticket's parent still sits where the rules say.
        const ranks = typeRanks(hierarchy);
        for (const ticket of tickets.values()) {
          const rank = rankIn(ranks, ticket.typeId);
          if (ticket.parentId === null) {
            expect(rank).not.toBe(SUBTICKET_RANK);
          } else {
            const parent = tickets.get(ticket.parentId) as TicketNode;
            expect(parentLevelAllowed(rank, rankIn(ranks, parent.typeId), rules)).toBe(true);
          }
        }
      }),
    );
  });
});

describe('safe hierarchy changes (CORE-007)', () => {
  const changeFor = (h: Hierarchy, n: number, rank: number, type: number): HierarchyChange[] => {
    const custom = h.levels.filter((l) => l.kind === 'custom');
    const out: HierarchyChange[] = [{ kind: 'insert', levelId: 500, rank }];
    if (custom.length > 0) {
      out.push({ kind: 'move', levelId: pick(custom, n).id, rank });
      out.push({ kind: 'remove', levelId: pick(custom, n).id });
    }
    out.push({ kind: 'retype', typeId: pick(h.types, type).id, levelId: pick(h.levels, n).id });
    return out;
  };

  it('[CORE-007] reports exactly the parent links and parentless subtickets a change breaks', () => {
    fc.assert(
      fc.property(
        worldArb,
        fc.nat(),
        fc.integer({ min: 2, max: 7 }),
        fc.nat(),
        fc.nat(),
        (world, n, rank, type, which) => {
          const { hierarchy, rules, tickets } = world;
          const change = pick(changeFor(hierarchy, n, rank, type), which);
          const result = applyChange(hierarchy, change);
          fc.pre(result.ok);
          if (!result.ok) return;
          const impact = hierarchyImpact(hierarchy, result.hierarchy, tickets, rules);
          const expected = [
            ...impact.brokenLinks.map((l) => ({ ticketId: l.ticketId, problem: 'wrong_level' })),
            ...impact.ticketsNeedingParent.map((id) => ({
              ticketId: id,
              problem: 'parent_required',
            })),
          ];
          expect(problemSet(forestProblems(result.hierarchy, tickets, rules))).toEqual(
            problemSet(expected),
          );
          expect(breaksTickets(impact)).toBe(expected.length > 0);
          // Removing a level reports its types as falling to the standard level.
          if (change.kind === 'remove') {
            expect(impact.typesToStandard).toEqual(
              hierarchy.types
                .filter((t) => t.levelId === change.levelId)
                .map((t) => t.id)
                .sort((a, b) => a - b),
            );
          } else {
            expect(impact.typesToStandard).toEqual([]);
          }
        },
      ),
    );
  });

  it('[CORE-007] breaks nothing when a level is added on top, and a move undone restores every rank', () => {
    fc.assert(
      fc.property(worldArb, fc.nat(), fc.nat(), (world, n, r) => {
        const { hierarchy, rules, tickets } = world;
        const top = applyChange(hierarchy, { kind: 'insert', levelId: 500 });
        if (!top.ok) throw new Error(top.problem);
        const impact = hierarchyImpact(hierarchy, top.hierarchy, tickets, rules);
        expect(breaksTickets(impact)).toBe(false);
        expect(impact.levels).toEqual([]);
        const custom = top.hierarchy.levels.filter((l) => l.kind === 'custom');
        const level = pick(custom, n);
        const to = 2 + (r % custom.length);
        const moved = applyChange(top.hierarchy, { kind: 'move', levelId: level.id, rank: to });
        if (!moved.ok) throw new Error(moved.problem);
        const back = applyChange(moved.hierarchy, {
          kind: 'move',
          levelId: level.id,
          rank: level.rank,
        });
        if (!back.ok) throw new Error(back.problem);
        const ranks = (h: Hierarchy) =>
          h.levels.map((l) => [l.id, l.rank] as const).sort((a, b) => a[0] - b[0]);
        expect(ranks(back.hierarchy)).toEqual(ranks(top.hierarchy));
        // Removing the empty level just added gives the original ladder back.
        const removed = applyChange(top.hierarchy, { kind: 'remove', levelId: 500 });
        if (!removed.ok) throw new Error(removed.problem);
        expect(ranks(removed.hierarchy)).toEqual(ranks(hierarchy));
      }),
    );
  });

  it('[CORE-007] lists the broken links and the types that fall to level 0 before a level goes', () => {
    // Levels: 2 "Objective" holds type 20; Outcome holds 10; standard holds 0.
    const h: Hierarchy = {
      levels: ladder(1),
      types: [
        { id: 20, levelId: 4 },
        { id: 10, levelId: 3 },
        { id: 0, levelId: 2 },
        { id: -1, levelId: 1 },
      ],
    };
    const tickets = new Map<number, TicketNode>(
      [
        { id: 1, typeId: 20, parentId: null },
        { id: 2, typeId: 10, parentId: 1 },
        { id: 3, typeId: 10, parentId: 1 },
        { id: 4, typeId: 0, parentId: 2 },
        { id: 5, typeId: -1, parentId: 4 },
        { id: 6, typeId: 0, parentId: null },
      ].map((t) => [t.id, t]),
    );
    const result = applyChange(h, { kind: 'remove', levelId: 4 });
    if (!result.ok) throw new Error(result.problem);
    const impact = hierarchyImpact(h, result.hierarchy, tickets);
    expect(impact.typesToStandard).toEqual([20]);
    expect(impact.levels).toEqual([{ levelId: 4, from: 2, to: null }]);
    expect(impact.types).toEqual([{ typeId: 20, from: 2, to: 0 }]);
    expect(impact.ticketsChangingLevel).toBe(1);
    // Both Outcome tickets lose their parent; the lower links hold.
    expect(impact.brokenLinks).toEqual([
      { ticketId: 2, parentId: 1 },
      { ticketId: 3, parentId: 1 },
    ]);
    expect(impact.ticketsNeedingParent).toEqual([]);

    // Inserting a level between Outcome and level 2 breaks the same links.
    const between = applyChange(h, { kind: 'insert', levelId: 9, rank: 2 });
    if (!between.ok) throw new Error(between.problem);
    expect(hierarchyImpact(h, between.hierarchy, tickets).brokenLinks).toHaveLength(2);

    // Moving the standard type to the subticket level breaks the links around its tickets and
    // leaves its parentless ticket needing a parent.
    const retyped = applyChange(h, { kind: 'retype', typeId: 0, levelId: 1 });
    if (!retyped.ok) throw new Error(retyped.problem);
    const down = hierarchyImpact(h, retyped.hierarchy, tickets);
    expect(down.brokenLinks).toEqual([
      { ticketId: 4, parentId: 2 },
      { ticketId: 5, parentId: 4 },
    ]);
    expect(down.ticketsNeedingParent).toEqual([6]);
    expect(down.ticketsChangingLevel).toBe(2);
  });
});
