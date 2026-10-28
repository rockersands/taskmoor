import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { acyclic, breakCycles, components, type Edge } from './nesting';

const byPair = (a: Edge, b: Edge) => a[0] - b[0] || a[1] - b[1];

/** Every node reachable from `from` over `edges`. */
function reachable(edges: readonly Edge[], from: number): Set<number> {
  const seen = new Set<number>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.pop() as number;
    for (const [p, c] of edges) {
      if (p === node && !seen.has(c)) {
        seen.add(c);
        queue.push(c);
      }
    }
  }
  return seen;
}

describe('nested groups from a directory (M1-082)', () => {
  it('[IAM-005] keeps a chain nested four and more levels deep as it is', () => {
    const chain: Edge[] = [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
    ];
    const { kept, dropped } = breakCycles(chain, byPair);
    expect(dropped).toEqual([]);
    expect([...kept].sort(byPair)).toEqual(chain);
    expect(reachable(kept, 1).has(6)).toBe(true);
  });

  it('[IAM-005] breaks a loop by dropping the edge that closes it, in DN order', () => {
    const loop: Edge[] = [
      [3, 1],
      [1, 2],
      [2, 3],
    ];
    const { kept, dropped } = breakCycles(loop, byPair);
    // [1,2] and [2,3] come first and stay; [3,1] would lead back to 1.
    expect(dropped).toEqual([[3, 1]]);
    expect(acyclic(kept)).toBe(true);
    // A group inside itself never stays.
    expect(breakCycles([[7, 7]], byPair).dropped).toEqual([[7, 7]]);
  });

  it('[IAM-005] finds strongly connected components without recursion on deep chains', () => {
    const deep: Edge[] = Array.from({ length: 20_000 }, (_, i) => [i, i + 1] as const);
    deep.push([20_000, 0]);
    const component = components([], deep);
    expect(new Set(component.values()).size).toBe(1);
    const { dropped } = breakCycles(deep, byPair);
    expect(dropped).toHaveLength(1);
  });

  it('[IAM-005] always keeps an acyclic subset that preserves every edge between components, whatever the input order', () => {
    const edge = fc.tuple(fc.integer({ min: 0, max: 12 }), fc.integer({ min: 0, max: 12 }));
    fc.assert(
      fc.property(fc.array(edge, { maxLength: 60 }), fc.integer(), (raw, seed) => {
        const edges = raw as Edge[];
        const { kept, dropped } = breakCycles(edges, byPair);
        expect(acyclic(kept)).toBe(true);
        const unique = new Set(edges.map(([p, c]) => `${p}>${c}`));
        expect(kept.length + dropped.length).toBe(unique.size);
        // A dropped edge really would have closed a loop with the kept ones.
        for (const [p, c] of dropped) expect(p === c || reachable(kept, c).has(p)).toBe(true);
        // The same edges in another order keep the same set.
        const shuffled = [...edges].sort(
          (a, b) => ((a[0] * 31 + a[1] + seed) % 7) - ((b[0] * 31 + b[1] + seed) % 7),
        );
        const again = breakCycles(shuffled, byPair);
        expect([...again.kept].sort(byPair)).toEqual([...kept].sort(byPair));
      }),
    );
  });
});
