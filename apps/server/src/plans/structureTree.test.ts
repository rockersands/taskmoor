import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  appendTo,
  type BuiltStructure,
  buildStructure,
  cutLinks,
  type ExpandLevel,
  type StructureInput,
  type TreeTicket,
  VIA_CHILD,
  VIA_INSERTED,
  VIA_LINKS,
} from './structureTree';

/** A ticket ranked by its id unless told otherwise. */
const tk = (
  id: number,
  parent: number | null = null,
  extra: Partial<TreeTicket> = {},
): TreeTicket => ({
  id,
  parent,
  rank: `r${String(id).padStart(6, '0')}`,
  key: `K-${id}`,
  track: 1,
  level: 0,
  inPlan: true,
  closed: false,
  ...extra,
});
const map = (list: TreeTicket[]) => new Map(list.map((t) => [t.id, t]));
const edges = (pairs: [number, number][]) => {
  const out = new Map<number, number[]>();
  for (const [from, to] of pairs) out.set(from, [...(out.get(from) ?? []), to]);
  return out;
};
const expand = (
  pairs: [number, number][],
  depth: number,
  hidden: [number, number][] = [],
): ExpandLevel => ({
  edges: edges(pairs),
  hidden: new Map(hidden),
  depth,
});
const input = (over: Partial<StructureInput>): StructureInput => ({
  tickets: new Map(),
  inserted: [],
  groups: [],
  children: null,
  links: [],
  limit: 100_000,
  ...over,
});
/** The rows as `key@depth` in preorder; group rows as `[label]@depth`. */
const outline = (built: BuiltStructure) =>
  built.rows.ticket.map((t, i) => {
    const group = built.groups.find((g) => g.row === i);
    const name = t === 0 ? `[${group?.label ?? 'No value'}]` : built.rows.key[i];
    return `${name}@${built.rows.depth[i]}`;
  });

describe('buildStructure (PLN-010; ADR-122 stage 10)', () => {
  it('[PLN-010] nests an inserted ticket under its inserted parent, by rank then id, in preorder', () => {
    const tickets = map([
      tk(1),
      tk(2, 1),
      tk(3, 1, { rank: 'r000000' }),
      tk(4, 99), // a parent not inserted (or hidden): a top row
      tk(5, 2),
    ]);
    const built = buildStructure(input({ tickets, inserted: [5, 4, 3, 2, 1] }));
    expect(outline(built)).toEqual(['K-1@0', 'K-3@1', 'K-2@1', 'K-5@2', 'K-4@0']);
    expect(built.rows.parent).toEqual([-1, 0, 0, 2, -1]);
    expect(built.rows.via.every((v) => v === VIA_INSERTED)).toBe(true);
    expect(built.more).toBe(false);
    expect(built.total).toBe(5);
  });

  it('[PLN-010] breaks a loop of parents that bad data could make', () => {
    const tickets = map([tk(1, 2), tk(2, 1), tk(3, 3)]);
    const built = buildStructure(input({ tickets, inserted: [1, 2, 3] }));
    expect(outline(built)).toEqual(['K-1@0', 'K-2@1', 'K-3@0']);
  });

  it('[PLN-010] adds children at every level, breadth first, with hidden ones counted', () => {
    const tickets = map([tk(1), tk(10, 1), tk(11, 1), tk(20, 10), tk(30, 20)]);
    const built = buildStructure(
      input({
        tickets,
        inserted: [1],
        children: expand(
          [
            [1, 11],
            [1, 10],
            [10, 20],
            [20, 30],
          ],
          32,
          [
            [1, 2],
            [30, 1],
          ],
        ),
      }),
    );
    expect(outline(built)).toEqual(['K-1@0', 'K-10@1', 'K-20@2', 'K-30@3', 'K-11@1']);
    expect(built.rows.via).toEqual([VIA_INSERTED, VIA_CHILD, VIA_CHILD, VIA_CHILD, VIA_CHILD]);
    expect(built.rows.notShown).toEqual([2, 0, 0, 1, 0]);
  });

  it('[PLN-010] stops children at the depth guard', () => {
    const chain = Array.from({ length: 40 }, (_, i) => tk(i + 1, i === 0 ? null : i));
    const pairs = chain.slice(1).map((t): [number, number] => [t.parent as number, t.id]);
    const built = buildStructure(
      input({ tickets: map(chain), inserted: [1], children: expand(pairs, 32) }),
    );
    expect(built.total).toBe(33);
    expect(Math.max(...built.rows.depth)).toBe(32);
  });

  it('[PLN-010] places a ticket reached twice once, where first reached, and counts the other reach', () => {
    // 3 is inserted and a top row (its parent 2 is not inserted); the children step reaches it
    // again under 2, which counts it as shown elsewhere.
    const tickets = map([tk(1), tk(2, 1), tk(3, 2)]);
    const built = buildStructure(
      input({
        tickets,
        inserted: [1, 3],
        children: expand(
          [
            [1, 2],
            [2, 3],
          ],
          32,
        ),
      }),
    );
    expect(outline(built)).toEqual(['K-1@0', 'K-2@1', 'K-3@0']);
    expect(built.rows.elsewhere).toEqual([0, 1, 0]);
    expect(new Set(built.rows.ticket).size).toBe(3);
  });

  it('[PLN-010] adds linked tickets per step, depth levels down; a cycle through links stops', () => {
    const tickets = map([tk(1), tk(2), tk(3), tk(4), tk(5)]);
    const built = buildStructure(
      input({
        tickets,
        inserted: [1, 2],
        // 1 -> 3 -> 4 -> 1 (a cycle), and 2 -> 3 (reached first under 1), 4 -> 5 at depth 3.
        links: [
          expand(
            [
              [1, 3],
              [2, 3],
              [3, 4],
              [4, 1],
              [4, 5],
            ],
            2,
            [[2, 4]],
          ),
        ],
      }),
    );
    expect(outline(built)).toEqual(['K-1@0', 'K-3@1', 'K-4@2', 'K-2@0']);
    expect(built.rows.via).toEqual([VIA_INSERTED, VIA_LINKS, VIA_LINKS, VIA_INSERTED]);
    // 2 reached 3 after 1 did; 4 is at the last level and not expanded, so 5 is not reached.
    expect(built.rows.elsewhere).toEqual([0, 0, 0, 1]);
    expect(built.rows.notShown).toEqual([0, 0, 0, 4]);
    const deeper = buildStructure(
      input({
        tickets,
        inserted: [1, 2],
        links: [
          expand(
            [
              [1, 3],
              [3, 4],
              [4, 1],
              [4, 5],
            ],
            3,
          ),
        ],
      }),
    );
    // 4 reaches 1 again: already a row, counted; and 5 at the third level.
    expect(outline(deeper)).toEqual(['K-1@0', 'K-3@1', 'K-4@2', 'K-5@3', 'K-2@0']);
    expect(deeper.rows.elsewhere).toEqual([0, 0, 1, 0, 0]);
  });

  it('[PLN-010] numbers each links step, and the second expands rows the first added', () => {
    const tickets = map([tk(1), tk(2), tk(3)]);
    const built = buildStructure(
      input({
        tickets,
        inserted: [1],
        links: [expand([[1, 2]], 1), expand([[2, 3]], 1)],
      }),
    );
    expect(outline(built)).toEqual(['K-1@0', 'K-2@1', 'K-3@2']);
    expect(built.rows.via).toEqual([VIA_INSERTED, VIA_LINKS, VIA_LINKS + 1]);
  });

  it('[PLN-010] groups the top rows by label, "No value" last, and nests a second grouping', () => {
    const tickets = map([tk(1), tk(2), tk(3), tk(4), tk(5, 1)]);
    const built = buildStructure(
      input({
        tickets,
        inserted: [1, 2, 3, 4, 5],
        groups: [
          {
            field: 'status',
            values: new Map<number, string | null>([
              [1, '20'],
              [2, '10'],
              [3, null],
              [4, '20'],
              [5, '10'],
            ]),
            labels: new Map([
              ['10', 'zeta'],
              ['20', 'Alpha'],
            ]),
          },
          {
            field: 'assignee',
            values: new Map<number, string | null>([
              [1, '7'],
              [4, null],
            ]),
            labels: new Map([['7', 'Mo']]),
          },
        ],
      }),
    );
    // 5 is under its inserted parent 1: grouping takes top rows, and rows below follow them.
    expect(outline(built)).toEqual([
      '[Alpha]@0',
      '[Mo]@1',
      'K-1@2',
      'K-5@3',
      '[No value]@1',
      'K-4@2',
      '[zeta]@0',
      '[No value]@1',
      'K-2@2',
      '[No value]@0',
      '[No value]@1',
      'K-3@2',
    ]);
    expect(built.groups.map((g) => [g.field, g.value])).toEqual([
      ['status', '20'],
      ['assignee', '7'],
      ['assignee', null],
      ['status', '10'],
      ['assignee', null],
      ['status', null],
      ['assignee', null],
    ]);
  });

  it('[PLN-010] stops at the row limit and says so, keeping every row’s parent', () => {
    const tickets = map(Array.from({ length: 10 }, (_, i) => tk(i + 1, i === 0 ? null : 1)));
    const pairs = Array.from({ length: 9 }, (_, i): [number, number] => [1, i + 2]);
    const built = buildStructure(
      input({ tickets, inserted: [1], children: expand(pairs, 32), limit: 4 }),
    );
    expect(built.more).toBe(true);
    expect(built.total).toBe(4);
    expect(outline(built)).toEqual(['K-1@0', 'K-2@1', 'K-3@1', 'K-4@1']);
  });

  /** A random forest of tickets with random links, some inserted. */
  const forest = fc
    .record({
      n: fc.integer({ min: 1, max: 60 }),
      seed: fc.array(fc.nat(1000), { minLength: 200, maxLength: 200 }),
    })
    .map(({ n, seed }) => {
      const at = (i: number) => seed[i % seed.length] as number;
      const list = Array.from({ length: n }, (_, i) =>
        // A parent among the earlier tickets, or none; now and then a bad one (a loop).
        tk(i + 1, at(i) % 4 === 0 ? null : (at(i + 7) % n) + 1, { rank: `r${at(i + 3) % 50}` }),
      );
      const inserted = list.filter((_, i) => at(i + 11) % 3 !== 0).map((t) => t.id);
      const childPairs = list.flatMap((t): [number, number][] =>
        t.parent !== null ? [[t.parent, t.id]] : [],
      );
      const linkPairs = Array.from({ length: at(5) % 40 }, (_, i): [number, number] => [
        (at(i + 20) % n) + 1,
        (at(i + 60) % n) + 1,
      ]);
      return {
        tickets: map(list),
        inserted,
        childPairs,
        linkPairs,
        depth: (at(9) % 3) + 1,
        limit: at(13) % 3 === 0 ? (at(17) % 30) + 1 : 100_000,
      };
    });
  const shuffle = <T>(list: readonly T[], seed: number): T[] =>
    list
      .map((x, i) => ({ x, k: (i * 7919 + seed * 104_729) % 1_000_003 }))
      .sort((a, b) => a.k - b.k)
      .map((v) => v.x);

  it('[PLN-010] every ticket at most once, parents before children, the same for a shuffled input', () => {
    fc.assert(
      fc.property(forest, fc.nat(1000), (f, seed) => {
        const make = (s: number) =>
          buildStructure(
            input({
              tickets: new Map(shuffle([...f.tickets], s)),
              inserted: shuffle(f.inserted, s),
              children: expand(shuffle(f.childPairs, s), 32),
              links: [expand(shuffle(f.linkPairs, s), f.depth)],
              limit: f.limit,
            }),
          );
        const built = make(0);
        const ids = built.rows.ticket.filter((t) => t !== 0);
        expect(new Set(ids).size).toBe(ids.length);
        built.rows.parent.forEach((p, i) => {
          expect(p).toBeLessThan(i);
          expect(built.rows.depth[i]).toBe(p === -1 ? 0 : (built.rows.depth[p] as number) + 1);
        });
        expect(built.total).toBeLessThanOrEqual(f.limit);
        expect(make(seed)).toEqual(built);
      }),
    );
  });

  it('[PLN-010] stops at 100,000 rows', () => {
    const n = 100_050;
    const list = Array.from({ length: n }, (_, i) => tk(i + 1));
    const built = buildStructure(
      input({ tickets: map(list), inserted: list.map((t) => t.id), limit: 100_000 }),
    );
    expect(built.total).toBe(100_000);
    expect(built.more).toBe(true);
    expect(built.rows.ticket.at(-1)).toBe(100_000);
  });

  // A copy of a list per entry made these quadratic: 17 s for 100,000 rows in two groups, longer
  // for one parent with 100,000 children. Linear, each takes well under a second. The timeout
  // fails a synchronous test that runs past it, so the test needs no speed budget.
  it('[PLN-010] groups 100,000 top rows into two values in linear time', { timeout: 8_000 }, () => {
    const n = 100_000;
    const list = Array.from({ length: n }, (_, i) => tk(i + 1));
    const built = buildStructure(
      input({
        tickets: map(list),
        inserted: list.map((t) => t.id),
        groups: [
          {
            field: 'track',
            values: new Map(list.map((t) => [t.id, t.id % 2 === 0 ? 'b' : 'a'])),
            labels: new Map([
              ['a', 'Apps'],
              ['b', 'Back'],
            ]),
          },
        ],
        limit: n + 2,
      }),
    );
    expect(built.total).toBe(n + 2);
    expect(built.more).toBe(false);
    expect(built.groups.map((g) => [g.row, g.label])).toEqual([
      [0, 'Apps'],
      [n / 2 + 1, 'Back'],
    ]);
  });

  it('[PLN-010] nests 100,000 inserted children under one parent in linear time', {
    timeout: 8_000,
  }, () => {
    const n = 100_000;
    const list = Array.from({ length: n }, (_, i) => tk(i + 1, i === 0 ? null : 1));
    const built = buildStructure(input({ tickets: map(list), inserted: list.map((t) => t.id) }));
    expect(built.total).toBe(n);
    expect(built.rows.depth.filter((d) => d === 1)).toHaveLength(n - 1);
  });

  it('[PLN-010] appendTo grows a list in place, 100,000 entries under one key', {
    timeout: 8_000,
  }, () => {
    const lists = new Map<number, number[]>();
    for (let i = 0; i < 100_000; i++) appendTo(lists, 7, i);
    const list = lists.get(7);
    appendTo(lists, 7, -1);
    expect(lists.get(7)).toBe(list);
    expect(list).toHaveLength(100_001);
  });

  it('[PLN-010] cuts a links step by the tickets it adds, not by its link pairs', () => {
    const pair = (src: number, dst: number) => ({ src, dst, depth: 1 });
    // Three known tickets linked to each other: six pairs, no ticket added, nothing cut.
    const among = [pair(1, 2), pair(1, 3), pair(2, 1), pair(2, 3), pair(3, 1), pair(3, 2)];
    expect(cutLinks(among, new Set([1, 2, 3]), 2, 100)).toEqual({ pairs: among, more: false });
    // Three tickets added past a limit of two: the one of highest id goes, with all its pairs.
    const out = [pair(1, 9), pair(2, 9), pair(1, 7), pair(2, 8), pair(3, 8)];
    expect(cutLinks(out, new Set([1, 2, 3]), 2, 100)).toEqual({
      pairs: [pair(1, 7), pair(2, 8), pair(3, 8)],
      more: true,
    });
    // The guard on pairs read says so too.
    expect(cutLinks(among, new Set([1, 2, 3]), 2, 4)).toEqual({
      pairs: among.slice(0, 4),
      more: true,
    });
  });
});
