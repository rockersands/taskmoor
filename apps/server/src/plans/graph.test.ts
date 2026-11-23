import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { Heap, stronglyConnected } from './graph';

const sorted = (groups: number[][]) =>
  groups
    .map((g) => [...g].sort((a, b) => a - b))
    .sort((a, b) => (a[0] as number) - (b[0] as number));

describe('stronglyConnected (ADR-122 stage 9, shared code)', () => {
  it('[PLN-011] finds a circle and leaves the other nodes alone', () => {
    // 0 -> 1 -> 2 -> 0, 2 -> 3, 4 alone.
    const out = [[1], [2], [0, 3], [], []];
    const { component, components } = stronglyConnected(5, out);
    expect(sorted(components)).toEqual([[0, 1, 2], [3], [4]]);
    expect(component[0]).toBe(component[1]);
    expect(component[1]).toBe(component[2]);
    expect(component[3]).not.toBe(component[0]);
  });

  it('[PLN-011] gives the components sinks first', () => {
    // A chain 0 -> 1 -> 2 -> 3: the last comes first.
    const { components } = stronglyConnected(4, [[1], [2], [3], []]);
    expect(components).toEqual([[3], [2], [1], [0]]);
  });

  it('[PLN-011] walks a long chain without overflowing the stack', () => {
    const n = 200_000;
    const out = Array.from({ length: n }, (_, i) => (i + 1 < n ? [i + 1] : []));
    const { components } = stronglyConnected(n, out);
    expect(components.length).toBe(n);
    expect(components[0]).toEqual([n - 1]);
  });

  it('[PLN-011] orders every edge between components from a later to an earlier component', () => {
    const graph = fc
      .integer({ min: 1, max: 30 })
      .chain((n) =>
        fc
          .array(fc.tuple(fc.nat(n - 1), fc.nat(n - 1)), { maxLength: 80 })
          .map((edges) => ({ n, edges })),
      );
    fc.assert(
      fc.property(graph, ({ n, edges }) => {
        const out: number[][] = Array.from({ length: n }, () => []);
        for (const [a, b] of edges) out[a]?.push(b);
        const { component, components } = stronglyConnected(n, out);
        expect(components.flat().sort((a, b) => a - b)).toEqual(
          Array.from({ length: n }, (_, i) => i),
        );
        for (const [a, b] of edges) {
          // Sinks first: an edge never points to a component listed after its own.
          expect(component[b] as number).toBeLessThanOrEqual(component[a] as number);
        }
      }),
    );
  });
});

describe('Heap (ADR-122 stage 9, shared code)', () => {
  it('[PLN-011] pops in the order of its comparator', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1000, max: 1000 })), (values) => {
        const heap = new Heap((a, b) => (values[a] as number) < (values[b] as number));
        values.forEach((_, i) => {
          heap.push(i);
        });
        const popped: number[] = [];
        while (heap.size > 0) popped.push(values[heap.pop()] as number);
        expect(popped).toEqual([...values].sort((a, b) => a - b));
      }),
    );
  });
});
