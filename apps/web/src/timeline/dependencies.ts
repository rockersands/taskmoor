import { dayNumber, type TimelineItem } from './client';

/**
 * Dependencies on a timeline (ADR-064; PLN-006, ADR-122): a blocking link joins a blocker to the
 * ticket it blocks. One rule decides when one is late, for the lines, the badges and the list.
 */

/** A ticket's bar: its own (or its sprint's) days, or the span rolled up from its children. */
export function barOf(
  item: TimelineItem,
): { start: number; due: number; kind: 'own' | 'rollup' } | null {
  if (item.start !== null || item.due !== null) {
    const start = dayNumber(item.start ?? (item.due as string));
    const due = dayNumber(item.due ?? (item.start as string));
    return { start, due: Math.max(start, due), kind: 'own' };
  }
  const r = item.rollup;
  if (r && (r.start !== null || r.due !== null)) {
    const start = dayNumber(r.start ?? (r.due as string));
    return { start, due: Math.max(start, dayNumber(r.due ?? (r.start as string))), kind: 'rollup' };
  }
  return null;
}

/**
 * Where a dependency stands:
 * - `late`: the blocker ends on or after the day the ticket it blocks starts, both still open;
 * - `closed`: the blocker is closed, so it holds nothing up whatever its days;
 * - `undated`: one of the two has no days to compare;
 * - `onTime`: the blocker ends before the other starts, or the blocked ticket is already closed.
 */
export type DependencyState = 'late' | 'closed' | 'undated' | 'onTime';

export function dependencyState(blocker: TimelineItem, blocked: TimelineItem): DependencyState {
  if (blocker.status.stage === 'closed') return 'closed';
  const a = barOf(blocker);
  const b = barOf(blocked);
  if (!a || !b) return 'undated';
  if (blocked.status.stage === 'closed') return 'onTime';
  return b.start <= a.due ? 'late' : 'onTime';
}

/** Blockers a timeline does not list, only counted (`GET /plans/:id/timeline`). */
export interface BlockersElsewhere {
  /** The blocked ticket. */
  id: number;
  /** Outside the plan, or hidden from the viewer: never named. */
  outside: number;
  /** In the plan, but left out by the filters or the first 10,000. */
  unlisted: number;
}

/** A ticket's blockers: those listed with their state, and the others as counts. */
export interface Blocked {
  item: TimelineItem;
  blockers: { item: TimelineItem; state: DependencyState }[];
  outside: number;
  unlisted: number;
  /** How many of the listed blockers are late. */
  late: number;
}

/** Every listed ticket with a blocker, in the timeline's order (rank), by its id. */
export function dependenciesOf(
  items: readonly TimelineItem[],
  links: readonly { from: number; to: number }[],
  elsewhere: readonly BlockersElsewhere[] = [],
): Map<number, Blocked> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const order = new Map(items.map((i, index) => [i.id, index]));
  const found = new Map<number, Blocked>();
  const entry = (item: TimelineItem) => {
    const known = found.get(item.id);
    if (known) return known;
    const made: Blocked = { item, blockers: [], outside: 0, unlisted: 0, late: 0 };
    found.set(item.id, made);
    return made;
  };
  for (const l of links) {
    const blocker = byId.get(l.from);
    const blocked = byId.get(l.to);
    if (!blocker || !blocked) continue;
    const state = dependencyState(blocker, blocked);
    const e = entry(blocked);
    e.blockers.push({ item: blocker, state });
    if (state === 'late') e.late++;
  }
  for (const o of elsewhere) {
    const blocked = byId.get(o.id);
    if (!blocked || o.outside + o.unlisted === 0) continue;
    const e = entry(blocked);
    e.outside += o.outside;
    e.unlisted += o.unlisted;
  }
  const rank = (id: number) => order.get(id) ?? 0;
  for (const e of found.values()) e.blockers.sort((a, b) => rank(a.item.id) - rank(b.item.id));
  return new Map([...found].sort((a, b) => rank(a[0]) - rank(b[0])));
}

/** How many blockers a ticket has in all: listed or not. */
export const blockerCount = (b: Blocked) => b.blockers.length + b.outside + b.unlisted;
