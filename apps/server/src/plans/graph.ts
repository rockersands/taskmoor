/**
 * Graph code the plans' engines share (ADR-122 stage 9, "Shared code"): the auto-scheduler
 * (`schedule()`), evening out (`evenOut()`) and the critical path (`criticalPath()`). Pure, no
 * database; nodes are the indexes `0..n-1`.
 */

/**
 * Tarjan's strongly connected components over `out` (edges `v -> out[v]`), iteratively, so a long
 * chain cannot overflow the stack. Answers each node's component and the components, sinks first:
 * the reverse topological order of the components.
 */
export function stronglyConnected(
  n: number,
  out: readonly (readonly number[])[],
): { component: number[]; components: number[][] } {
  const component = new Array<number>(n).fill(-1);
  const components: number[][] = [];
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  let counter = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work: [number, number][] = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (work.length > 0) {
      const frame = work[work.length - 1] as [number, number];
      const [v, next] = frame;
      const edges = (out[v] ?? []) as readonly number[];
      if (next < edges.length) {
        frame[1] = next + 1;
        const w = edges[next] as number;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = true;
          work.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v] as number, index[w] as number);
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low[parent[0]] = Math.min(low[parent[0]] as number, low[v] as number);
      if (low[v] === index[v]) {
        const members: number[] = [];
        for (;;) {
          const w = stack.pop() as number;
          onStack[w] = false;
          component[w] = components.length;
          members.push(w);
          if (w === v) break;
        }
        components.push(members);
      }
    }
  }
  return { component, components };
}

/** A binary heap of indexes under a comparator: `pop` answers the least. */
export class Heap {
  private readonly items: number[] = [];
  constructor(private readonly less: (a: number, b: number) => boolean) {}
  get size() {
    return this.items.length;
  }
  push(x: number) {
    const a = this.items;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(a[i] as number, a[parent] as number)) break;
      [a[i], a[parent]] = [a[parent] as number, a[i] as number];
      i = parent;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0] as number;
    const last = a.pop() as number;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l] as number, a[m] as number)) m = l;
        if (r < a.length && this.less(a[r] as number, a[m] as number)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m] as number, a[i] as number];
        i = m;
      }
    }
    return top;
  }
}
