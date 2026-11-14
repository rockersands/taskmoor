import { Heap, stronglyConnected } from './graph';
import { dayNumber, isoDay } from './periods';
import {
  classify,
  type DayProposal,
  isLate,
  KEPT_REASONS,
  type KeptReason,
  LEFT_OUT_REASONS,
  NOT_PLACED_REASONS,
  type NotPlacedReason,
  type OverLeftCell,
  type ScheduleArgs,
  type ScheduleCounts,
  type ScheduleEntry,
  type ScheduleInput,
  type ScheduleOutcome,
  type ScheduleOutput,
  type ScheduleReason,
  type ScheduleTeam,
  type ScheduleTicket,
  type ScheduleWarning,
  type TicketClass,
  WARNINGS,
} from './scheduler';

/**
 * Evening out load (T-089a; PLN-011; ADR-122 stage 9, "Evening out load"): the second kind of
 * auto-schedule run. A pure function, no database, with stage 7's input; beside `schedule()`, it
 * shares only the sorting of tickets (`classify`) and the graph code (`graph.ts`).
 *
 * It moves only the tickets that put a person or plan team over capacity in a period of the run,
 * later, by the least shift that puts the due day in the first later period with room, each keeping
 * its own length. What a moved ticket blocks is pushed after it, keeping its length; when a push
 * would reach a ticket that may not move, or past the run's last day, the whole move is undone and
 * the next ticket is tried. A ticket a keep rule holds (fixed dates), a closed or left-out one, and
 * one above level 0 never move. Every cell ends within capacity or is reported in `overLeft`.
 *
 * - Days are whole numbers from `dayNumber` inside, `YYYY-MM-DD` out; a day a ticket has not
 *   stays null in its proposal.
 * - Amounts are whole hundredths, as in `schedule()`; amounts in reasons are back in the unit.
 * - The same input in any order gives the same output, and a run on its own output moves nothing:
 *   passes over the cells repeat until one moves nothing.
 */

/** What stopped a push: the kind of ticket it reached, or the run's last day. */
export const WOULD_MAKE_LATE_WHY = [
  'kept',
  'left_out',
  'cycle',
  'hidden_blocker',
  'sprint',
  'past_end',
] as const;
export type WouldMakeLateWhy = (typeof WOULD_MAKE_LATE_WHY)[number];

/** Evening out's answer: stage 7's, with days that may stay null and the cells left over. */
export interface EvenOutOutput extends Omit<ScheduleOutput, 'proposals' | 'overLeft'> {
  proposals: DayProposal[];
  overLeft: OverLeftCell[];
}

const before = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const zeroes = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const amount = (h: number) => h / 100;

/**
 * The subjects of a run (plan teams by id, then people by id), their capacity per period and the
 * load already there (`person.load`, a team's being its members' sum), as `schedule()` builds them.
 */
function subjectsOfRun(input: ScheduleInput, assignees: readonly (number | null)[]) {
  const P = input.periods.length;
  const pStart = input.periods.map((p) => dayNumber(p.start));
  const pEnd = input.periods.map((p) => dayNumber(p.end));
  /** The period a day falls in: -1 before the run, `P` after it. */
  const periodOfDay = (d: number) => {
    if (P === 0 || d < (pStart[0] as number)) return -1;
    for (let p = 0; p < P; p++) if (d <= (pEnd[p] as number)) return p;
    return P;
  };
  const teams = [...new Map(input.teams.map((t) => [t.id, t])).values()].sort(
    (a, b) => a.id - b.id,
  );
  const peopleIn = new Map(input.people.map((p) => [p.id, p]));
  const personIds = new Set<number>(peopleIn.keys());
  for (const t of teams) for (const m of t.members) personIds.add(m);
  for (const a of assignees) if (a !== null) personIds.add(a);
  const people = [...personIds].sort((a, b) => a - b);
  const T = teams.length;
  const S = T + people.length;
  const personSubject = new Map(people.map((id, i) => [id, T + i]));
  const capOf = (row: (number | null)[] | undefined) =>
    Array.from({ length: P }, (_, p) => {
      const v = row?.[p];
      return v === undefined || v === null ? null : Math.round(v);
    });
  const cap: (number | null)[][] = [];
  const load: number[][] = [];
  for (const t of teams) {
    cap.push(capOf(t.capacity));
    load.push(new Array<number>(P).fill(0));
  }
  for (const id of people) {
    const row = peopleIn.get(id);
    cap.push(capOf(row?.capacity));
    load.push(Array.from({ length: P }, (_, p) => Math.round(row?.load[p] ?? 0)));
  }
  const teamsOf = new Map<number, number[]>();
  for (let ti = 0; ti < T; ti++) {
    for (const m of new Set((teams[ti] as ScheduleTeam).members)) {
      const list = teamsOf.get(m) ?? [];
      list.push(ti);
      teamsOf.set(m, list);
      const own = load[personSubject.get(m) as number] as number[];
      const team = load[ti] as number[];
      for (let p = 0; p < P; p++) team[p] = (team[p] as number) + (own[p] as number);
    }
  }
  const subjectArgs = (s: number): { teamId: number } | { userId: number } =>
    s < T ? { teamId: (teams[s] as ScheduleTeam).id } : { userId: people[s - T] as number };
  /** A ticket's subjects: its assignee's teams first, then the assignee. */
  const subjectsOf = (assigneeId: number | null) =>
    assigneeId === null
      ? ([] as number[])
      : [...(teamsOf.get(assigneeId) ?? []), personSubject.get(assigneeId) as number];
  return { P, pStart, pEnd, periodOfDay, S, cap, load, subjectArgs, subjectsOf };
}

/**
 * How many cells of the run (a team or person in a period) are over capacity with the tickets
 * where they are: the readiness check's `overCells` (ADR-122 stage 9, "Readiness").
 */
export function countOverCells(input: ScheduleInput): number {
  const run = subjectsOfRun(
    input,
    input.tickets.map((t) => t.assigneeId),
  );
  for (const t of new Map(input.tickets.map((x) => [x.id, x])).values()) {
    if (t.due === null) continue;
    const p = run.periodOfDay(dayNumber(t.due));
    if (p < 0 || p >= run.P) continue;
    const est = t.estimate === null ? 0 : Math.round(t.estimate);
    for (const s of run.subjectsOf(t.assigneeId)) {
      const row = run.load[s] as number[];
      row[p] = (row[p] as number) + est;
    }
  }
  let n = 0;
  for (let s = 0; s < run.S; s++) {
    for (let p = 0; p < run.P; p++) {
      const c = run.cap[s]?.[p];
      if (c !== null && c !== undefined && (run.load[s]?.[p] as number) > c) n++;
    }
  }
  return n;
}

interface Moved {
  reason: 'moved_off_over' | 'pushed_by_move';
  args: ScheduleArgs;
}
interface Failed {
  reason: 'still_over' | 'would_make_late';
  args: ScheduleArgs;
}
interface Decision {
  outcome: ScheduleOutcome;
  reason: ScheduleReason;
  args: ScheduleArgs;
  warnings: ScheduleWarning[];
}

/** Evens out the load of a plan's people and teams (ADR-122 stage 9, rules 1 to 7). */
export function evenOut(input: ScheduleInput): EvenOutOutput {
  // Tickets, by id, so no input order shapes the answer.
  const tickets = [...new Map(input.tickets.map((t) => [t.id, t])).values()].sort(
    (a, b) => a.id - b.id,
  );
  const N = tickets.length;
  const indexOf = new Map(tickets.map((t, i) => [t.id, i]));
  const byRank = (a: number, b: number) => {
    const ta = tickets[a] as ScheduleTicket;
    const tb = tickets[b] as ScheduleTicket;
    return before(ta.rank, tb.rank) || ta.id - tb.id;
  };
  const run = subjectsOfRun(
    input,
    tickets.map((t) => t.assigneeId),
  );
  const { P, pStart, pEnd, periodOfDay, S, cap, load, subjectArgs } = run;
  const lastDay = P === 0 ? Number.NEGATIVE_INFINITY : (pEnd[P - 1] as number);
  const subjectsOf = tickets.map((t) => run.subjectsOf(t.assigneeId));
  const est = tickets.map((t) => (t.estimate === null ? 0 : Math.round(t.estimate)));

  // Links: one per pair, both ends among the open tickets.
  const out: number[][] = Array.from({ length: N }, () => []);
  const into: number[][] = Array.from({ length: N }, () => []);
  const selfLinked = new Array<boolean>(N).fill(false);
  {
    const seen = new Set<string>();
    for (const l of input.links) {
      const a = indexOf.get(l.from);
      const b = indexOf.get(l.to);
      if (a === undefined || b === undefined) continue;
      if (tickets[a]?.stage === 'closed' || tickets[b]?.stage === 'closed') continue;
      const k = `${a}:${b}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (a === b) {
        selfLinked[a] = true;
        continue;
      }
      out[a]?.push(b);
      into[b]?.push(a);
    }
    for (let i = 0; i < N; i++) {
      out[i]?.sort(byRank);
      into[i]?.sort(byRank);
    }
  }

  // Rule 1: stage 7's classes; circles as stage 7 finds them.
  const klass: TicketClass[] = tickets.map(classify(input));
  const { component, components } = stronglyConnected(N, out);
  const inCycle = (i: number) =>
    selfLinked[i] === true || (components[component[i] as number]?.length ?? 0) > 1;
  // Topological positions: the components come sinks first, so reversed they run sources first.
  const topo = new Array<number>(N).fill(0);
  {
    let pos = 0;
    for (let c = components.length - 1; c >= 0; c--)
      for (const u of components[c] as number[]) topo[u] = pos++;
  }

  // Days now: each ticket's own, which moves change; its sprint's when it has none.
  const start = tickets.map((t) => (t.start === null ? null : dayNumber(t.start)));
  const due = tickets.map((t) => (t.due === null ? null : dayNumber(t.due)));
  const firstStart = [...start];
  const firstDue = [...due];
  const sprintStart = tickets.map((t) => (t.sprint ? dayNumber(t.sprint.start) : null));
  const sprintEnd = tickets.map((t) => (t.sprint ? dayNumber(t.sprint.end) : null));
  /** A bar's first day from these own days, else the sprint's (the one bar rule). */
  const barStart = (i: number, s = start[i] ?? null, d = due[i] ?? null): number | null =>
    s !== null || d !== null ? ((s ?? d) as number) : (sprintStart[i] ?? null);
  const barEnd = (i: number, s = start[i] ?? null, d = due[i] ?? null): number | null =>
    s !== null || d !== null
      ? Math.max((s ?? d) as number, (d ?? s) as number)
      : (sprintEnd[i] ?? null);
  const shifted = (day: number | null, by: number) => (day === null ? null : day + by);

  /** Why a push may not move this ticket, or null when it may. */
  const fixed = (i: number): WouldMakeLateWhy | null => {
    const k = klass[i] as TicketClass;
    if (k.kind === 'kept') return 'kept';
    if (k.kind !== 'movable') return 'left_out';
    if (inCycle(i)) return 'cycle';
    if ((tickets[i] as ScheduleTicket).hiddenBlocker) return 'hidden_blocker';
    if (start[i] === null && due[i] === null) return 'sprint';
    return null;
  };
  /** A ticket that may leave an over cell: movable, outside circles, with a due day and a size. */
  const candidate = (i: number) =>
    klass[i]?.kind === 'movable' &&
    !inCycle(i) &&
    !(tickets[i] as ScheduleTicket).hiddenBlocker &&
    due[i] !== null &&
    (est[i] as number) > 0 &&
    (subjectsOf[i] as number[]).length > 0;

  // Rule 2: start where things are, every ticket's load at the period of its due day.
  const dueAt = (i: number) => {
    const d = due[i];
    return d === null || d === undefined ? -1 : periodOfDay(d);
  };
  const addLoad = (i: number, sign: 1 | -1) => {
    const p = dueAt(i);
    if (p < 0 || p >= P) return;
    for (const s of subjectsOf[i] as number[]) {
      const row = load[s] as number[];
      row[p] = (row[p] as number) + sign * (est[i] as number);
    }
  };
  for (let i = 0; i < N; i++) addLoad(i, 1);

  const moved: (Moved | null)[] = new Array(N).fill(null);
  // A failed try stands until a later pass moves the ticket or fails it again: it says why a
  // ticket ranked lower stayed while one ranked higher moved.
  const failed: (Failed | null)[] = new Array(N).fill(null);
  let overLeft: OverLeftCell[] = [];
  let buckets: number[][] = [];
  let movedThisPass = false;
  const ticketId = (i: number) => (tickets[i] as ScheduleTicket).id;
  const totalShift = (i: number) =>
    ((due[i] ?? start[i]) as number) - ((firstDue[i] ?? firstStart[i]) as number);

  // Rules 5 and 6: one move of ticket `i` out of cell (s, p), with what it pushes; undone whole.
  const tryMove = (i: number, s: number, p: number, over: number): boolean => {
    const size = est[i] as number;
    let q = -1;
    for (let x = p + 1; x < P && q === -1; x++) {
      let any = false;
      let fits = true;
      for (const t of subjectsOf[i] as number[]) {
        const c = cap[t]?.[x];
        if (c === null || c === undefined) continue;
        any = true;
        if ((load[t]?.[x] as number) + size > c) {
          fits = false;
          break;
        }
      }
      if (any && fits) q = x;
    }
    if (q === -1) {
      failed[i] = {
        reason: 'still_over',
        args: { ...subjectArgs(s), until: isoDay(lastDay) },
      };
      return false;
    }
    const refuse = (v: number, why: WouldMakeLateWhy) => {
      failed[i] = {
        reason: 'would_make_late',
        args: { ticketId: ticketId(v), why, until: isoDay(lastDay) },
      };
      return false;
    };
    const by = (pStart[q] as number) - (due[i] as number);
    const next = new Map<number, { start: number | null; due: number | null; by: number }>();
    next.set(i, { start: shifted(start[i] ?? null, by), due: (due[i] as number) + by, by: -1 });
    {
      const mine = next.get(i) as { start: number | null; due: number | null };
      if ((barEnd(i, mine.start, mine.due) as number) > lastDay) return refuse(i, 'past_end');
    }
    // What it blocks, in topological order, so each ticket sees every changed blocker first.
    const heap = new Heap((a, b) => (topo[a] as number) < (topo[b] as number));
    const queued = new Set<number>();
    const enqueue = (u: number) => {
      for (const v of out[u] as number[]) {
        if (queued.has(v) || next.has(v)) continue;
        queued.add(v);
        heap.push(v);
      }
    };
    enqueue(i);
    while (heap.size > 0) {
      const v = heap.pop();
      let end = Number.NEGATIVE_INFINITY;
      let blocker = -1;
      for (const u of into[v] as number[]) {
        const n = next.get(u);
        if (!n) continue;
        const e = barEnd(u, n.start, n.due) as number;
        if (e > end) {
          end = e;
          blocker = u;
        }
      }
      if (blocker === -1) continue;
      const s0 = barStart(v);
      if (s0 === null || !isLate(end, s0)) continue;
      const why = fixed(v);
      if (why !== null) return refuse(v, why);
      const shift = end + 1 - s0;
      const ns = shifted(start[v] ?? null, shift);
      const nd = shifted(due[v] ?? null, shift);
      if ((barEnd(v, ns, nd) as number) > lastDay) return refuse(v, 'past_end');
      next.set(v, { start: ns, due: nd, by: blocker });
      enqueue(v);
    }
    // The move stands: loads leave and enter, and each ticket says why it moved.
    for (const [j, n] of next) {
      const from = dueAt(j);
      addLoad(j, -1);
      start[j] = n.start;
      due[j] = n.due;
      addLoad(j, 1);
      const to = dueAt(j);
      if (to > p && to < P) buckets[to]?.push(j);
      if (j === i) {
        const first = firstDue[j] === null ? -1 : periodOfDay(firstDue[j] as number);
        const left = first >= 0 && first < P ? first : from;
        moved[j] = {
          reason: 'moved_off_over',
          args: {
            ...subjectArgs(s),
            fromPeriod: isoDay(pStart[left] as number),
            fromPeriodEnd: isoDay(pEnd[left] as number),
            toPeriod: isoDay(pStart[q] as number),
            toPeriodEnd: isoDay(pEnd[q] as number),
            days: totalShift(j),
            over: amount(over),
          },
        };
      } else {
        moved[j] = {
          reason: 'pushed_by_move',
          args: { blockerId: ticketId(n.by), days: totalShift(j) },
        };
      }
    }
    return true;
  };

  // Rules 3, 4 and 7: the over cells in period order, teams before people, then by id; in each,
  // the lowest-ranked candidates first, one at a time until the cell fits.
  const lowestFirst = (a: number, b: number) => byRank(b, a);
  const pass = () => {
    movedThisPass = false;
    overLeft = [];
    buckets = Array.from({ length: P }, () => []);
    for (let i = 0; i < N; i++) {
      const p = dueAt(i);
      if (p >= 0 && p < P) buckets[p]?.push(i);
    }
    for (let p = 0; p < P; p++) {
      const bySubject = new Map<number, number[]>();
      for (const i of new Set(buckets[p])) {
        if (dueAt(i) !== p || !candidate(i)) continue;
        for (const s of subjectsOf[i] as number[]) {
          const list = bySubject.get(s) ?? [];
          list.push(i);
          bySubject.set(s, list);
        }
      }
      for (let s = 0; s < S; s++) {
        const c = cap[s]?.[p];
        if (c === null || c === undefined || (load[s]?.[p] as number) <= c) continue;
        const list = (bySubject.get(s) ?? []).filter((i) => dueAt(i) === p).sort(lowestFirst);
        // Loads in later periods only grow while a cell is worked on, so when no later period has
        // room for a size of an assignee's, none has for a larger one: those fail without a look.
        const noRoomFrom = new Map<number, number>();
        for (const i of list) {
          const now = load[s]?.[p] as number;
          if (now <= c) break;
          if (dueAt(i) !== p) continue;
          const who = (tickets[i] as ScheduleTicket).assigneeId as number;
          const size = est[i] as number;
          if (size >= (noRoomFrom.get(who) ?? Number.POSITIVE_INFINITY)) {
            failed[i] = {
              reason: 'still_over',
              args: { ...subjectArgs(s), until: isoDay(lastDay) },
            };
            continue;
          }
          if (tryMove(i, s, p, now - c)) movedThisPass = true;
          else if (failed[i]?.reason === 'still_over')
            noRoomFrom.set(who, Math.min(size, noRoomFrom.get(who) ?? Number.POSITIVE_INFINITY));
        }
        const left = load[s]?.[p] as number;
        if (left > c) {
          overLeft.push({
            ...subjectArgs(s),
            periodStart: isoDay(pStart[p] as number),
            periodEnd: isoDay(pEnd[p] as number),
            over: amount(left - c),
            onlyFixed: list.length === 0,
          });
        }
      }
    }
  };
  // Passes repeat until one moves nothing, so a run on its own output moves nothing. Each move
  // takes tickets only later and never past the run's last day, so this ends.
  const most = N * Math.max(1, P) + 1;
  for (let n = 0; n < most; n++) {
    pass();
    if (!movedThisPass) break;
  }

  // The answer.
  const decided: Decision[] = tickets.map((t, i) => {
    const k = klass[i] as TicketClass;
    if (k.kind === 'kept') return { outcome: 'kept', reason: k.reason, args: {}, warnings: [] };
    // Closed and left-out tickets are counted, never listed: this decision is not read.
    if (k.kind !== 'movable')
      return { outcome: 'placed', reason: 'already', args: {}, warnings: [] };
    if (inCycle(i)) {
      const others = (components[component[i] as number] as number[])
        .filter((j) => j !== i)
        .sort(byRank);
      return {
        outcome: 'not_placed',
        reason: 'cycle',
        args: { ticketIds: others.slice(0, 5).map(ticketId), size: others.length + 1 },
        warnings: [],
      };
    }
    if (t.hiddenBlocker)
      return { outcome: 'not_placed', reason: 'hidden_blocker', args: {}, warnings: [] };
    const m = moved[i];
    if (m) {
      const warnings: ScheduleWarning[] = [];
      const d = due[i];
      if (t.release && d !== null && d !== undefined && d > dayNumber(t.release.date)) {
        warnings.push({
          kind: 'after_release',
          args: {
            releaseId: t.release.id,
            releaseDate: t.release.date,
            days: d - dayNumber(t.release.date),
          },
        });
      }
      return { outcome: 'placed', reason: m.reason, args: m.args, warnings };
    }
    const f = failed[i];
    if (f) return { outcome: 'not_placed', reason: f.reason, args: f.args, warnings: [] };
    return { outcome: 'placed', reason: 'already', args: {}, warnings: [] };
  });

  const counts: ScheduleCounts = {
    placed: 0,
    already: 0,
    kept: zeroes(KEPT_REASONS),
    notPlaced: zeroes(NOT_PLACED_REASONS),
    leftOut: zeroes(LEFT_OUT_REASONS),
    warnings: zeroes(WARNINGS),
  };
  const proposals: DayProposal[] = [];
  const listed: number[] = [];
  for (let i = 0; i < N; i++) {
    const k = klass[i] as TicketClass;
    if (k.kind === 'closed') continue;
    if (k.kind === 'left_out') {
      counts.leftOut[k.reason]++;
      continue;
    }
    const d = decided[i] as Decision;
    listed.push(i);
    for (const w of d.warnings) counts.warnings[w.kind]++;
    if (d.outcome === 'kept') counts.kept[d.reason as KeptReason]++;
    else if (d.outcome === 'not_placed') counts.notPlaced[d.reason as NotPlacedReason]++;
    else {
      counts.placed++;
      if (d.reason === 'already') counts.already++;
      const s = start[i] ?? null;
      const e = due[i] ?? null;
      proposals.push({
        id: ticketId(i),
        start: s === null ? null : isoDay(s),
        due: e === null ? null : isoDay(e),
      });
    }
  }
  // Not moved first, then moved (with a warning first), kept, and those left where they are.
  const group = (i: number) => {
    const d = decided[i] as Decision;
    if (d.outcome === 'not_placed') return 0;
    if (d.outcome === 'kept') return 3;
    if (d.reason === 'already') return 4;
    return d.warnings.length > 0 ? 1 : 2;
  };
  listed.sort((a, b) => group(a) - group(b) || byRank(a, b));
  return {
    proposals,
    tickets: listed.map((i): ScheduleEntry => {
      const t = tickets[i] as ScheduleTicket;
      const d = decided[i] as Decision;
      return {
        id: t.id,
        key: t.key,
        outcome: d.outcome,
        reason: d.reason,
        args: d.args,
        warnings: d.warnings,
      };
    }),
    counts,
    overLeft,
  };
}
