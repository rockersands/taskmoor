/**
 * Nested groups from a directory (M1-082, IAM-005): Taskmoor keeps group nesting acyclic, but
 * directories do not have to (Active Directory allows a group inside its own member). The sync
 * keeps every edge that closes no loop and drops the rest, deterministically: the same
 * directory content always keeps the same edges, whatever order it was read in.
 *
 * Edges between strongly connected components never form a loop, so only the edges inside a
 * component with a cycle are examined, in the caller's order (by DN): each is kept unless the
 * edges kept so far already lead from its child back to its parent.
 */
export type Edge = readonly [parent: number, child: number];

/** Strongly connected components (Tarjan, iterative so deep nesting cannot overflow the stack). */
export function components(nodes: Iterable<number>, edges: readonly Edge[]): Map<number, number> {
  const out = new Map<number, number[]>();
  for (const [p, c] of edges) {
    const list = out.get(p);
    if (list) list.push(c);
    else out.set(p, [c]);
  }
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const component = new Map<number, number>();
  let counter = 0;
  let componentId = 0;
  const all = new Set<number>(nodes);
  for (const [p, c] of edges) {
    all.add(p);
    all.add(c);
  }
  for (const root of all) {
    if (index.has(root)) continue;
    const work: { node: number; next: number }[] = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: number; next: number };
      const targets = out.get(frame.node) ?? [];
      if (frame.next < targets.length) {
        const target = targets[frame.next] as number;
        frame.next += 1;
        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(target) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low.set(
          parent.node,
          Math.min(low.get(parent.node) as number, low.get(frame.node) as number),
        );
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        for (;;) {
          const member = stack.pop() as number;
          onStack.delete(member);
          component.set(member, componentId);
          if (member === frame.node) break;
        }
        componentId += 1;
      }
    }
  }
  return component;
}

/**
 * Splits edges into the ones to keep, which form no cycle, and the ones dropped to break
 * cycles. `order` decides which edge of a cycle survives: earlier edges win.
 */
export function breakCycles(
  edges: readonly Edge[],
  order: (a: Edge, b: Edge) => number,
): { kept: Edge[]; dropped: Edge[] } {
  const unique = new Map<string, Edge>();
  for (const e of edges) unique.set(`${e[0]}>${e[1]}`, e);
  const list = [...unique.values()];
  const component = components([], list);
  const kept: Edge[] = [];
  const dropped: Edge[] = [];
  const inside = new Map<number, Edge[]>();
  for (const e of list) {
    const [p, c] = e;
    if (p === c) {
      dropped.push(e);
      continue;
    }
    const cp = component.get(p);
    if (cp !== component.get(c)) {
      kept.push(e);
      continue;
    }
    const group = inside.get(cp as number);
    if (group) group.push(e);
    else inside.set(cp as number, [e]);
  }
  for (const group of inside.values()) {
    const adjacency = new Map<number, number[]>();
    const reaches = (from: number, to: number) => {
      const seen = new Set<number>([from]);
      const queue = [from];
      while (queue.length > 0) {
        const node = queue.pop() as number;
        if (node === to) return true;
        for (const next of adjacency.get(node) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return false;
    };
    for (const e of [...group].sort(order)) {
      const [p, c] = e;
      if (reaches(c, p)) {
        dropped.push(e);
        continue;
      }
      kept.push(e);
      const list = adjacency.get(p);
      if (list) list.push(c);
      else adjacency.set(p, [c]);
    }
  }
  return { kept, dropped };
}

/** True when the edges contain no cycle (for tests and assertions). */
export function acyclic(edges: readonly Edge[]): boolean {
  const component = components([], edges);
  const sizes = new Map<number, number>();
  for (const id of component.values()) sizes.set(id, (sizes.get(id) ?? 0) + 1);
  return edges.every(([p, c]) => p !== c && sizes.get(component.get(p) as number) === 1);
}
