import { stronglyConnected } from './graph';

/**
 * The critical path of a plan (PLN-011; ADR-122 stage 9, "The critical path"): a pure function,
 * no database, O(V + E).
 *
 * - Days are whole numbers from `dayNumber`; a ticket's bar is `start..end`, both days included,
 *   read by the one bar rule (`barDays`, or its sprint's days).
 * - A link `from -> to` says `from` finishes first: `to` may start the day after `from` ends.
 * - The **plan's end** is the latest end among the tickets.
 * - A ticket's **latest end** is the least of the plan's end and, for each ticket it blocks, that
 *   ticket's latest start less one day; its latest start is its latest end less its length. Its
 *   **slack** is its latest end less its end, in calendar days. Negative slack says a dependency
 *   on that chain is already late.
 * - The **critical** tickets have slack of 0 or less.
 * - Tickets in a circle of links (one linked to itself included) get no slack, are listed in
 *   `cycles`, and links into or out of them constrain nothing.
 * - **Chains** join critical tickets through their tight links: those where the days between the
 *   two bars equal the difference of their slack (with slack 0 on both, the second starts the day
 *   after the first ends). Each critical ticket is in exactly one chain, listed from its first
 *   ticket to its last; a ticket with two tight links onward follows the longer, and the other
 *   starts a chain of its own. Chains come longest first, then by their first ticket's start, then
 *   its id.
 * - The same input, in any order, gives the same output.
 */
export interface CriticalTicket {
  id: number;
  /** Day numbers; `end` is never before `start`. */
  start: number;
  end: number;
}

export interface CriticalLink {
  /** The blocker: it finishes first. */
  from: number;
  /** The ticket that waits for it. */
  to: number;
}

export interface CriticalPathInput {
  tickets: readonly CriticalTicket[];
  links: readonly CriticalLink[];
}

export interface CriticalPath {
  /** The latest end among the tickets; null without any. */
  planEnd: number | null;
  /** Each ticket's slack in days, except the ones in a circle. */
  slack: Map<number, number>;
  /** The tickets with slack of 0 or less, by id. */
  critical: number[];
  /** The critical tickets joined by their tight links, each from first to last. */
  chains: number[][];
  /** The tickets in a circle of links, by id. */
  cycles: number[];
}

export function criticalPath(input: CriticalPathInput): CriticalPath {
  // Tickets by id, so no input order shapes the answer; the first of an id wins.
  const byId = new Map<number, CriticalTicket>();
  for (const t of input.tickets) if (!byId.has(t.id)) byId.set(t.id, t);
  const tickets = [...byId.values()].sort((a, b) => a.id - b.id);
  const N = tickets.length;
  const indexOf = new Map(tickets.map((t, i) => [t.id, i]));
  const start = tickets.map((t) => t.start);
  const end = tickets.map((t) => Math.max(t.start, t.end));
  if (N === 0) return { planEnd: null, slack: new Map(), critical: [], chains: [], cycles: [] };

  // Links: one per pair, both ends among the tickets.
  const out: number[][] = Array.from({ length: N }, () => []);
  const selfLinked = new Array<boolean>(N).fill(false);
  {
    const seen = new Set<number>();
    for (const l of input.links) {
      const a = indexOf.get(l.from);
      const b = indexOf.get(l.to);
      if (a === undefined || b === undefined) continue;
      if (a === b) {
        selfLinked[a] = true;
        continue;
      }
      const k = a * N + b;
      if (seen.has(k)) continue;
      seen.add(k);
      (out[a] as number[]).push(b);
    }
    for (const edges of out) edges.sort((x, y) => x - y);
  }

  let planEnd = end[0] as number;
  for (let i = 1; i < N; i++) if ((end[i] as number) > planEnd) planEnd = end[i] as number;

  // Components come sinks first: the reverse topological order the latest days are computed in.
  const { component, components } = stronglyConnected(N, out);
  const inCycle = (i: number) =>
    selfLinked[i] === true || (components[component[i] as number]?.length ?? 0) > 1;

  const latestEnd = new Array<number>(N).fill(0);
  const latestStart = new Array<number>(N).fill(0);
  const slackOf = new Array<number>(N).fill(0);
  for (const members of components) {
    if (members.length > 1) continue;
    const u = members[0] as number;
    if (inCycle(u)) continue;
    let latest = planEnd;
    for (const v of out[u] as number[]) {
      if (inCycle(v)) continue;
      const bound = (latestStart[v] as number) - 1;
      if (bound < latest) latest = bound;
    }
    latestEnd[u] = latest;
    latestStart[u] = latest - ((end[u] as number) - (start[u] as number));
    slackOf[u] = latest - (end[u] as number);
  }

  const slack = new Map<number, number>();
  const cycles: number[] = [];
  const isCritical = new Array<boolean>(N).fill(false);
  const critical: number[] = [];
  for (let i = 0; i < N; i++) {
    const id = (tickets[i] as CriticalTicket).id;
    if (inCycle(i)) {
      cycles.push(id);
      continue;
    }
    slack.set(id, slackOf[i] as number);
    if ((slackOf[i] as number) <= 0) {
      isCritical[i] = true;
      critical.push(id);
    }
  }

  // Tight links between critical tickets: the gap between the bars equals the slack's difference.
  const tight: number[][] = Array.from({ length: N }, () => []);
  const hasTightIn = new Array<boolean>(N).fill(false);
  for (let u = 0; u < N; u++) {
    if (!isCritical[u]) continue;
    for (const v of out[u] as number[]) {
      if (!isCritical[v]) continue;
      const gap = (start[v] as number) - (end[u] as number) - 1;
      if (gap === (slackOf[u] as number) - (slackOf[v] as number)) {
        (tight[u] as number[]).push(v);
        hasTightIn[v] = true;
      }
    }
  }
  // How many tickets the longest tight run from each ticket holds, and which link it follows.
  // Components are sinks first, so every ticket a critical ticket links to is done before it.
  const depth = new Array<number>(N).fill(0);
  const next = new Array<number>(N).fill(-1);
  const earlier = (a: number, b: number) => (start[a] as number) - (start[b] as number) || a - b;
  for (const members of components) {
    const u = members[0] as number;
    if (members.length > 1 || !isCritical[u]) continue;
    let best = -1;
    for (const v of tight[u] as number[]) {
      if (
        best === -1 ||
        (depth[v] as number) > (depth[best] as number) ||
        ((depth[v] as number) === (depth[best] as number) && earlier(v, best) < 0)
      )
        best = v;
    }
    next[u] = best;
    depth[u] = 1 + (best === -1 ? 0 : (depth[best] as number));
  }
  // Chains: from each ticket no tight link reaches, longest first; then from what is left, in
  // topological order (components reversed), each following its chosen links while unused.
  const used = new Array<boolean>(N).fill(false);
  const chainsAt: number[][] = [];
  const walk = (from: number) => {
    const chain: number[] = [];
    for (let u = from; u !== -1 && !used[u]; u = next[u] as number) {
      used[u] = true;
      chain.push(u);
    }
    if (chain.length > 0) chainsAt.push(chain);
  };
  const heads: number[] = [];
  for (let i = 0; i < N; i++) if (isCritical[i] && !hasTightIn[i]) heads.push(i);
  heads.sort((a, b) => (depth[b] as number) - (depth[a] as number) || earlier(a, b));
  for (const h of heads) walk(h);
  for (let c = components.length - 1; c >= 0; c--) {
    const members = components[c] as number[];
    const u = members[0] as number;
    if (members.length === 1 && isCritical[u] && !used[u]) walk(u);
  }
  chainsAt.sort((a, b) => b.length - a.length || earlier(a[0] as number, b[0] as number));
  return {
    planEnd,
    slack,
    critical,
    chains: chainsAt.map((chain) => chain.map((i) => (tickets[i] as CriticalTicket).id)),
    cycles,
  };
}
