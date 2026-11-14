import { z } from 'zod';
import { isCalendarDay } from '../tickets/model';
import { Heap, stronglyConnected } from './graph';
import { MAX_PERIODS } from './model';
import { dayNumber, isoDay, type Period } from './periods';

/**
 * The auto-scheduler's engine (T-089f; PLN-004; ADR-122 stage 7): a pure function, no database.
 * Given a plan's open tickets as the runner sees them, the links between them, the plan's periods
 * and each person's and team's capacity and load, it proposes a start and due day for each
 * ticket it may move, by rules a person can follow, and says of each ticket why it landed where
 * it did, why it was kept, or why it was not placed.
 *
 * - Days are `YYYY-MM-DD` in and out, whole numbers from `dayNumber` inside.
 * - Amounts (estimates, capacities, loads) are whole hundredths of the plan's unit, so no floating
 *   point decides a fit; `hundredths` makes one from a value in the unit, rounding half up as the
 *   Capacity tab does. Amounts in reasons are back in the unit.
 * - Ranks compare by UTF-16 code unit (`a < b`), as the "C" collation orders them, then by id.
 * - The same input, in any order, gives the same output.
 */

const MAX_INT = 2_147_483_647;
const idNum = z.number().int().positive().max(MAX_INT);
const day = z.string().refine(isCalendarDay, 'a calendar day as YYYY-MM-DD');

/** Periods a run looks ahead when the request names none. */
export const DEFAULT_RUN_PERIODS = 6;
/** Movable tickets one run places at most (`MAX_DRAFTED_TICKETS`): more refuse the run. */
export const MAX_TO_SCHEDULE = 10_000;
/** Open tickets one run reads at most (PLN-001's plan size): more refuse the run. */
export const MAX_OPEN_READ = 50_000;
/** Ticket types, and releases, one run leaves out at most. */
export const MAX_LEFT_OUT = 20;
/** The longest query condition a run takes, in characters. */
export const MAX_QUERY = 2_000;
/** Tickets a run's answer lists; `more` counts the rest. */
export const MAX_LISTED = 2_000;
/** Changes one `writeDrafts` call takes (13 bound values a row, 65,535 a statement). */
export const DRAFT_CHUNK = 2_000;
/** Entries one `plan.drafts_set` event holds. */
export const EVENT_CHUNK = 1_000;

const query = z
  .string()
  .trim()
  .max(MAX_QUERY)
  .transform((v) => (v === '' ? undefined : v))
  .optional();

/** The body of `POST /api/v1/plans/:id/schedule`. */
export const scheduleBody = z
  .object({
    /** A scenario of the plan, or a new one made by the run (copied from `from`, as `POST /scenarios`). */
    into: z.union([
      z.object({ scenarioId: idNum }).strict(),
      z
        .object({
          newScenario: z
            .object({ name: z.string().trim().min(1).max(100), from: idNum.optional() })
            .strict(),
        })
        .strict(),
    ]),
    /** The first day: the person's own today; the server takes today in UTC without it. */
    from: day.optional(),
    periods: z.number().int().min(1).max(MAX_PERIODS).default(DEFAULT_RUN_PERIODS),
    leaveOut: z
      .object({
        typeIds: z.array(idNum).max(MAX_LEFT_OUT).default([]),
        releaseIds: z.array(idNum).max(MAX_LEFT_OUT).default([]),
        query,
      })
      .strict()
      .default({ typeIds: [], releaseIds: [] }),
    keep: z
      .object({
        inProgress: z.boolean().default(true),
        inActiveSprint: z.boolean().default(true),
        query,
      })
      .strict()
      .default({ inProgress: true, inActiveSprint: true }),
  })
  .strict();
export type ScheduleBody = z.infer<typeof scheduleBody>;

/** One open ticket of the plan that the runner is shown, at any level. */
export interface ScheduleTicket {
  id: number;
  key: string;
  /** `ticket.rank`. */
  rank: string;
  /** The rank of its type's hierarchy level: only level 0 is scheduled. */
  level: number;
  typeId: number;
  /** A closed ticket may be passed: its load counts, and nothing else. */
  stage: 'new' | 'active' | 'closed';
  assigneeId: number | null;
  /** In whole hundredths of the plan's unit (`hundredths`); null when it has none in that unit. */
  estimate: number | null;
  /** Its days now in the scenario: live days with people's drafts, never the scheduler's own. */
  start: string | null;
  due: string | null;
  /** The sprint it is dated by when it has no days of its own (`sprintDay`), else null. */
  sprint: { start: string; end: string } | null;
  /** In an open sprint that is active on a Scrum board. */
  inActiveSprint: boolean;
  /** The releases it targets (role `target`), for `leaveOut.releaseIds`. */
  releaseIds: number[];
  /** Its earliest target release neither shipped nor archived that has a date, else null. */
  release: { id: number; date: string } | null;
  /** A person drafted its start or due day in this scenario. */
  personDraft: boolean;
  /** The runner may set its days (`schedule_tickets`). */
  maySchedule: boolean;
  /** It matches the run's `leaveOut.query`. */
  leftOutByQuery: boolean;
  /** It matches the run's `keep.query`. */
  keptByQuery: boolean;
  /** One of its blockers, open or closed, is outside the plan or hidden from the runner. */
  hiddenBlocker: boolean;
}

/** `from` blocks `to` (it finishes first); links with an end not among the tickets are ignored. */
export interface ScheduleLink {
  from: number;
  to: number;
}

/** A plan team: its members and its capacity per period of the run, resolved as Capacity does. */
export interface ScheduleTeam {
  id: number;
  members: number[];
  /** Hundredths per period, in the order of `periods`; null where none is set. */
  capacity: (number | null)[];
}

/** A person: their capacity per period, and the load already there. */
export interface SchedulePerson {
  id: number;
  /** Hundredths per period, in the order of `periods`; null where none is set. */
  capacity: (number | null)[];
  /**
   * Hundredths per period: what `GET .../capacity` counts for them in this scenario (the plan's
   * tickets due in the period, closed ones included, and their work elsewhere by whole weeks),
   * less every ticket in `tickets`, whose load the engine adds itself. A team's load is the sum
   * of its members'.
   */
  load: number[];
}

export interface ScheduleInput {
  /** The run's first day. */
  from: string;
  /** `periodsFrom(periodOf(plan), from, periods)`. */
  periods: Period[];
  tickets: ScheduleTicket[];
  links: ScheduleLink[];
  teams: ScheduleTeam[];
  people: SchedulePerson[];
  leaveOut: { typeIds: number[]; releaseIds: number[] };
  keep: { inProgress: boolean; inActiveSprint: boolean };
}

export type ScheduleOutcome = 'placed' | 'kept' | 'not_placed';
export const PLACED_REASONS = [
  'fits',
  'after_blocker',
  'after_higher_ranked',
  'first_for_blocked',
  'already',
] as const;
export const KEPT_REASONS = [
  'person_draft',
  'may_not_schedule',
  'kept_by_query',
  'in_progress',
  'in_sprint',
] as const;
export const NOT_PLACED_REASONS = [
  'no_estimate',
  'no_assignee',
  'no_team',
  'no_capacity',
  'too_big',
  'cycle',
  'hidden_blocker',
  'blocker_undated',
  'blocker_not_placed',
  'no_room',
] as const;
export const LEFT_OUT_REASONS = ['level', 'type', 'release', 'query'] as const;
export const WARNINGS = ['after_release', 'late_against_kept', 'over_where_kept'] as const;
export type PlacedReason = (typeof PLACED_REASONS)[number];
export type KeptReason = (typeof KEPT_REASONS)[number];
export type NotPlacedReason = (typeof NOT_PLACED_REASONS)[number];
export type LeftOutReason = (typeof LEFT_OUT_REASONS)[number];
export type ScheduleWarningKind = (typeof WARNINGS)[number];
export type ScheduleReason = PlacedReason | KeptReason | NotPlacedReason;

/**
 * What a reason or warning names: ids, days and amounts only. A subject is `teamId` or `userId`;
 * days are `YYYY-MM-DD`; amounts are in the plan's unit. Keys by reason:
 * - `fits`: subject, `periodStart`, `periodEnd`, `free` and `capacity` (the tightest subject's,
 *   before this ticket), `before` (tickets this run placed in that cell before it);
 * - `after_blocker`: `blockerId`, `blockerEnd`; `after_higher_ranked`: subject, `periodStart`;
 * - `first_for_blocked`: `ticketId` (the higher-ranked ticket it holds up); `already`: none;
 * - kept reasons and `no_estimate`, `no_assignee`, `hidden_blocker`: none;
 * - `no_team`: `userId`; `no_capacity`: `teamIds`; `too_big`: subject, `capacity` (the largest
 *   seen that it is bigger than); `cycle`: `ticketIds` (up to five others, in rank order),
 *   `size`; `blocker_undated`, `blocker_not_placed`: `blockerId`; `no_room`: subject, `until`;
 * - warnings: `after_release`: `releaseId`, `releaseDate`, `days`; `late_against_kept`:
 *   `ticketIds` (up to five), `count`; `over_where_kept`: subject, `periodStart`.
 */
export type ScheduleArgs = Record<string, number | string | number[]>;

export interface ScheduleWarning {
  kind: ScheduleWarningKind;
  args: ScheduleArgs;
}

export interface ScheduleEntry {
  id: number;
  key: string;
  outcome: ScheduleOutcome;
  reason: ScheduleReason;
  args: ScheduleArgs;
  warnings: ScheduleWarning[];
}

export interface ScheduleCounts {
  /** Placed tickets, `already` ones included. */
  placed: number;
  /** Placed where they already are: nothing to draft. */
  already: number;
  kept: Record<KeptReason, number>;
  notPlaced: Record<NotPlacedReason, number>;
  leftOut: Record<LeftOutReason, number>;
  /** Tickets carrying each warning. */
  warnings: Record<ScheduleWarningKind, number>;
}

export interface ScheduleOutput {
  /** Every placed ticket's days, `already` ones included, by id; the route diffs them per field. */
  proposals: { id: number; start: string; due: string }[];
  /** Every open ticket not left out: not placed, placed with a warning, kept, placed; then rank. */
  tickets: ScheduleEntry[];
  counts: ScheduleCounts;
}

/** The movable tickets a run tried: placed or not placed (`too_many_to_schedule` counts them). */
export function movableCount(counts: ScheduleCounts): number {
  return counts.placed + Object.values(counts.notPlaced).reduce((a, b) => a + b, 0);
}

/** A value in the plan's unit as whole hundredths, rounded half up (1.005 is 101, not 100). */
export function hundredths(value: number): number {
  return Math.round(Number.parseFloat((value * 100).toPrecision(12)));
}

/**
 * Whether a dependency is late (PLN-006): the blocked ticket starts on or before the day its
 * blocker ends. The server's twin of the web's `dependencyState` (`timeline/dependencies.ts`),
 * held to the same table of cases (`plans/__cases__/late-rule.json`).
 */
export function isLate(blockerEnd: number, blockedStart: number): boolean {
  return blockedStart <= blockerEnd;
}

/**
 * A ticket's bar from its own days, as the web's `barOf` reads it: a single day counts as both
 * start and end, and the end is never before the start. Null without days.
 */
export function barDays(
  start: string | null,
  due: string | null,
): { start: number; end: number } | null {
  if (start === null && due === null) return null;
  const s = dayNumber(start ?? (due as string));
  const e = dayNumber(due ?? (start as string));
  return { start: s, end: Math.max(s, e) };
}

const before = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** How a run sorts a ticket (ADR-122 stage 7): closed, left out, kept or movable. */
export type TicketClass =
  | { kind: 'closed' }
  | { kind: 'left_out'; reason: LeftOutReason }
  | { kind: 'kept'; reason: KeptReason }
  | { kind: 'movable' };
type Klass = TicketClass;

/**
 * Sorts the tickets of a run: closed, left out, kept, movable, by the first rule that matches.
 * `schedule()` and `evenOut()` share it, so both keep the same tickets.
 */
export function classify(
  input: Pick<ScheduleInput, 'leaveOut' | 'keep'>,
): (t: ScheduleTicket) => TicketClass {
  const leaveTypes = new Set(input.leaveOut.typeIds);
  const leaveReleases = new Set(input.leaveOut.releaseIds);
  return (t) => {
    if (t.stage === 'closed') return { kind: 'closed' };
    if (t.level !== 0) return { kind: 'left_out', reason: 'level' };
    if (leaveTypes.has(t.typeId)) return { kind: 'left_out', reason: 'type' };
    if (t.releaseIds.some((r) => leaveReleases.has(r)))
      return { kind: 'left_out', reason: 'release' };
    if (t.leftOutByQuery) return { kind: 'left_out', reason: 'query' };
    if (t.personDraft) return { kind: 'kept', reason: 'person_draft' };
    if (!t.maySchedule) return { kind: 'kept', reason: 'may_not_schedule' };
    if (t.keptByQuery) return { kind: 'kept', reason: 'kept_by_query' };
    if (t.stage === 'active' && input.keep.inProgress)
      return { kind: 'kept', reason: 'in_progress' };
    if (t.inActiveSprint && input.keep.inActiveSprint) return { kind: 'kept', reason: 'in_sprint' };
    return { kind: 'movable' };
  };
}

interface Decision {
  outcome: ScheduleOutcome;
  reason: ScheduleReason;
  args: ScheduleArgs;
  warnings: ScheduleWarning[];
}

const zeroes = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** Runs the auto-scheduler's rules over one plan (ADR-122 stage 7, "The rules"). */
export function schedule(input: ScheduleInput): ScheduleOutput {
  const P = input.periods.length;
  const pStart = input.periods.map((p) => dayNumber(p.start));
  const pEnd = input.periods.map((p) => dayNumber(p.end));
  const fromDay = dayNumber(input.from);
  const periodOfDay = (d: number) => {
    if (P === 0 || d < (pStart[0] as number)) return -1;
    for (let p = 0; p < P; p++) if (d <= (pEnd[p] as number)) return p;
    return P;
  };

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

  // Subjects: plan teams by id, then people by id.
  const teams = [...new Map(input.teams.map((t) => [t.id, t])).values()].sort(
    (a, b) => a.id - b.id,
  );
  const peopleIn = new Map(input.people.map((p) => [p.id, p]));
  const personIds = new Set<number>(peopleIn.keys());
  for (const t of teams) for (const m of t.members) personIds.add(m);
  for (const t of tickets) if (t.assigneeId !== null) personIds.add(t.assigneeId);
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
  const subjectArgs = (s: number): ScheduleArgs =>
    s < T ? { teamId: (teams[s] as ScheduleTeam).id } : { userId: people[s - T] as number };
  const subjectsOf = tickets.map((t) => {
    if (t.assigneeId === null) return [] as number[];
    // Teams first, so a reason names the team when a team and its member tie.
    return [...(teamsOf.get(t.assigneeId) ?? []), personSubject.get(t.assigneeId) as number];
  });
  const placedIn: number[][] = Array.from({ length: S }, () => new Array<number>(P).fill(0));
  const amount = (h: number) => h / 100;

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

  // Sorting the tickets: closed, left out, kept, movable, by the first rule that matches.
  const klass: Klass[] = tickets.map(classify(input));
  const movable = klass.map((k) => k.kind === 'movable');

  /** Where a ticket that is not placed ends: its later day, else its sprint's end. */
  const endOf = (i: number): number | null => {
    const t = tickets[i] as ScheduleTicket;
    const bar = barDays(t.start, t.due);
    if (bar) return bar.end;
    return t.sprint ? dayNumber(t.sprint.end) : null;
  };
  const startOf = (i: number): number | null => {
    const t = tickets[i] as ScheduleTicket;
    const bar = barDays(t.start, t.due);
    if (bar) return bar.start;
    return t.sprint ? dayNumber(t.sprint.start) : null;
  };

  /** Adds a ticket's load where its due day puts it; says which cells it took over a full one. */
  const addLoadAtDue = (i: number): number[] => {
    const t = tickets[i] as ScheduleTicket;
    if (t.due === null) return [];
    const p = periodOfDay(dayNumber(t.due));
    if (p < 0 || p >= P) return [];
    const est = t.estimate === null ? 0 : Math.round(t.estimate);
    const over: number[] = [];
    for (const s of subjectsOf[i] as number[]) {
      const row = load[s] as number[];
      row[p] = (row[p] as number) + est;
      const c = cap[s]?.[p];
      if (c !== null && c !== undefined && est > 0 && (row[p] as number) > c)
        if ((placedIn[s]?.[p] as number) > 0) over.push(s);
    }
    return over;
  };

  // Cycles: Tarjan's strongly connected components over every link between open tickets. It
  // gives them sinks first, the reverse topological order the effective ranks are computed in.
  const { component, components } = stronglyConnected(N, out);
  const inCycle = (i: number) =>
    selfLinked[i] === true || (components[component[i] as number]?.length ?? 0) > 1;

  // Effective rank: the best (rank, id) among a movable ticket and every movable ticket it
  // blocks, directly or through other movable tickets.
  const eff = new Array<number>(N);
  for (const members of components) {
    let best = -1;
    for (const u of members) {
      if (!movable[u]) continue;
      let b = u;
      for (const v of out[u] as number[]) {
        if (!movable[v] || component[v] === component[u]) continue;
        const e = eff[v] as number;
        if (byRank(e, b) < 0) b = e;
      }
      eff[u] = b;
      if (best === -1 || byRank(b, best) < 0) best = b;
    }
    if (members.length > 1) for (const u of members) if (movable[u]) eff[u] = best;
  }

  const decided: (Decision | null)[] = new Array(N).fill(null);
  const placedDue = new Array<number | null>(N).fill(null);
  const placedStart = new Array<number | null>(N).fill(null);
  const notPlaced = (i: number, reason: NotPlacedReason, args: ScheduleArgs = {}) => {
    decided[i] = { outcome: 'not_placed', reason, args, warnings: [] };
  };

  // Loads that count from the start: closed, left-out and kept tickets where their days are.
  for (let i = 0; i < N; i++) {
    const k = klass[i] as Klass;
    if (k.kind === 'movable') continue;
    addLoadAtDue(i);
    if (k.kind === 'kept')
      decided[i] = { outcome: 'kept', reason: k.reason, args: {}, warnings: [] };
  }

  // Not placed before placing, by the first reason that holds; their load counts from the start.
  for (let i = 0; i < N; i++) {
    if (!movable[i]) continue;
    const t = tickets[i] as ScheduleTicket;
    const subjects = subjectsOf[i] as number[];
    const est = t.estimate === null ? null : Math.round(t.estimate);
    if (est === null) notPlaced(i, 'no_estimate');
    else if (t.assigneeId === null) notPlaced(i, 'no_assignee');
    else if (subjects.length < 2) notPlaced(i, 'no_team', { userId: t.assigneeId });
    else if (!subjects.some((s) => cap[s]?.some((c) => c !== null)))
      notPlaced(i, 'no_capacity', {
        teamIds: subjects.filter((s) => s < T).map((s) => (teams[s] as ScheduleTeam).id),
      });
    else {
      let fitsSomewhere = false;
      let largest: { s: number; c: number } | null = null;
      for (let p = 0; p < P && !fitsSomewhere; p++) {
        let any = false;
        let small = false;
        for (const s of subjects) {
          const c = cap[s]?.[p];
          if (c === null || c === undefined) continue;
          any = true;
          if (est > c) {
            small = true;
            if (!largest || c > largest.c) largest = { s, c };
          }
        }
        if (any && !small) fitsSomewhere = true;
      }
      if (!fitsSomewhere && largest)
        notPlaced(i, 'too_big', { ...subjectArgs(largest.s), capacity: amount(largest.c) });
      else if (inCycle(i)) {
        const others = (components[component[i] as number] as number[])
          .filter((j) => j !== i)
          .sort(byRank);
        notPlaced(i, 'cycle', {
          ticketIds: others.slice(0, 5).map((j) => (tickets[j] as ScheduleTicket).id),
          size: others.length + 1,
        });
      } else if (t.hiddenBlocker) notPlaced(i, 'hidden_blocker');
      else {
        const undated = (into[i] as number[]).find((b) => !movable[b] && endOf(b) === null);
        if (undated !== undefined)
          notPlaced(i, 'blocker_undated', { blockerId: (tickets[undated] as ScheduleTicket).id });
      }
    }
    if (decided[i]) addLoadAtDue(i);
  }

  // Order: Kahn's over the movable tickets outside circles, a heap on (effective rank, rank, id).
  const ordered = (i: number) => movable[i] === true && !inCycle(i);
  const waiting = new Array<number>(N).fill(0);
  for (let i = 0; i < N; i++) {
    if (!ordered(i)) continue;
    for (const b of into[i] as number[]) if (ordered(b)) waiting[i] = (waiting[i] as number) + 1;
  }
  const heap = new Heap((a, b) => {
    const e = byRank(eff[a] as number, eff[b] as number);
    return (e || byRank(a, b)) < 0;
  });
  for (let i = 0; i < N; i++) if (ordered(i) && waiting[i] === 0) heap.push(i);

  const cursors = new Array<number>(S).fill(0);
  const place = (i: number) => {
    const t = tickets[i] as ScheduleTicket;
    const subjects = subjectsOf[i] as number[];
    const est = Math.round(t.estimate as number);
    let earliest = fromDay;
    let pushedBy = -1;
    for (const b of into[i] as number[]) {
      if (klass[b]?.kind === 'closed') continue;
      let end: number | null;
      if (placedDue[b] !== null) end = placedDue[b] as number;
      else {
        end = endOf(b);
        if (end === null) {
          notPlaced(i, 'blocker_not_placed', { blockerId: (tickets[b] as ScheduleTicket).id });
          return;
        }
      }
      if (end + 1 > earliest) {
        earliest = end + 1;
        pushedBy = b;
      }
    }
    const pEarliest = Math.max(0, periodOfDay(earliest));
    let cursor = 0;
    let cursorBy = -1;
    for (const s of subjects) {
      if ((cursors[s] as number) > cursor) {
        cursor = cursors[s] as number;
        cursorBy = s;
      }
    }
    const from = Math.max(pEarliest, cursor);
    for (let p = from; p < P; p++) {
      let any = false;
      let fits = true;
      let tight = -1;
      let tightFree = 0;
      for (const s of subjects) {
        const c = cap[s]?.[p];
        if (c === null || c === undefined) continue;
        any = true;
        const free = c - (load[s]?.[p] as number);
        if (est > free) {
          fits = false;
          break;
        }
        if (tight === -1 || free < tightFree) {
          tight = s;
          tightFree = free;
        }
      }
      if (!any || !fits) continue;
      const start = Math.max(pStart[p] as number, earliest);
      const due = pEnd[p] as number;
      let decision: Decision;
      if (t.start === isoDay(start) && t.due === isoDay(due))
        decision = { outcome: 'placed', reason: 'already', args: {}, warnings: [] };
      else if (pushedBy !== -1 && start === earliest)
        decision = {
          outcome: 'placed',
          reason: 'after_blocker',
          args: {
            blockerId: (tickets[pushedBy] as ScheduleTicket).id,
            blockerEnd: isoDay(earliest - 1),
          },
          warnings: [],
        };
      else if (p === from && cursor > pEarliest && cursorBy !== -1)
        decision = {
          outcome: 'placed',
          reason: 'after_higher_ranked',
          args: { ...subjectArgs(cursorBy), periodStart: isoDay(pStart[p] as number) },
          warnings: [],
        };
      else if (eff[i] !== i)
        decision = {
          outcome: 'placed',
          reason: 'first_for_blocked',
          args: { ticketId: (tickets[eff[i] as number] as ScheduleTicket).id },
          warnings: [],
        };
      else
        decision = {
          outcome: 'placed',
          reason: 'fits',
          args: {
            ...subjectArgs(tight),
            periodStart: isoDay(pStart[p] as number),
            periodEnd: isoDay(due),
            free: amount(tightFree),
            capacity: amount(cap[tight]?.[p] as number),
            before: placedIn[tight]?.[p] as number,
          },
          warnings: [],
        };
      decided[i] = decision;
      placedStart[i] = start;
      placedDue[i] = due;
      for (const s of subjects) {
        (load[s] as number[])[p] = (load[s]?.[p] as number) + est;
        (placedIn[s] as number[])[p] = (placedIn[s]?.[p] as number) + 1;
        cursors[s] = p;
      }
      return;
    }
    // Nothing fits: name the subject with the least room left over the periods it could use.
    let fullest = -1;
    let fullestFree = 0;
    const first = Math.min(from, P - 1);
    for (const s of subjects) {
      let any = false;
      let free = 0;
      for (let p = Math.max(0, first); p < P; p++) {
        const c = cap[s]?.[p];
        if (c === null || c === undefined) continue;
        any = true;
        free += Math.max(0, c - (load[s]?.[p] as number));
      }
      if (any && (fullest === -1 || free < fullestFree)) {
        fullest = s;
        fullestFree = free;
      }
    }
    notPlaced(i, 'no_room', {
      ...(fullest === -1 ? {} : subjectArgs(fullest)),
      until: isoDay(pEnd[P - 1] as number),
    });
  };

  while (heap.size > 0) {
    const i = heap.pop();
    if (decided[i] === null) {
      place(i);
      const d = decided[i] as Decision | null as Decision;
      if (d.outcome === 'not_placed') {
        // It keeps its days, and its load is added where they fall.
        const over = addLoadAtDue(i);
        const s = over[0];
        if (s !== undefined) {
          const p = periodOfDay(dayNumber((tickets[i] as ScheduleTicket).due as string));
          d.warnings.push({
            kind: 'over_where_kept',
            args: { ...subjectArgs(s), periodStart: isoDay(pStart[p] as number) },
          });
        }
      }
    }
    for (const v of out[i] as number[]) {
      if (!ordered(v)) continue;
      waiting[v] = (waiting[v] as number) - 1;
      if (waiting[v] === 0) heap.push(v);
    }
  }

  // Warnings on placed tickets.
  for (let i = 0; i < N; i++) {
    const d = decided[i];
    if (d?.outcome !== 'placed') continue;
    const t = tickets[i] as ScheduleTicket;
    const due = placedDue[i] as number;
    if (t.release && due > dayNumber(t.release.date)) {
      d.warnings.push({
        kind: 'after_release',
        args: {
          releaseId: t.release.id,
          releaseDate: t.release.date,
          days: due - dayNumber(t.release.date),
        },
      });
    }
    const late = (out[i] as number[]).filter((v) => {
      const k = klass[v]?.kind;
      if (k !== 'kept' && k !== 'left_out') return false;
      const s = startOf(v);
      return s !== null && isLate(due, s);
    });
    if (late.length > 0) {
      d.warnings.push({
        kind: 'late_against_kept',
        args: {
          ticketIds: late.slice(0, 5).map((v) => (tickets[v] as ScheduleTicket).id),
          count: late.length,
        },
      });
    }
  }

  // The answer.
  const counts: ScheduleCounts = {
    placed: 0,
    already: 0,
    kept: zeroes(KEPT_REASONS),
    notPlaced: zeroes(NOT_PLACED_REASONS),
    leftOut: zeroes(LEFT_OUT_REASONS),
    warnings: zeroes(WARNINGS),
  };
  const proposals: ScheduleOutput['proposals'] = [];
  const listed: number[] = [];
  for (let i = 0; i < N; i++) {
    const k = klass[i] as Klass;
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
      proposals.push({
        id: (tickets[i] as ScheduleTicket).id,
        start: isoDay(placedStart[i] as number),
        due: isoDay(placedDue[i] as number),
      });
    }
  }
  const group = (i: number) => {
    const d = decided[i] as Decision;
    if (d.outcome === 'not_placed') return 0;
    if (d.outcome === 'placed') return d.warnings.length > 0 ? 1 : 3;
    return 2;
  };
  listed.sort((a, b) => group(a) - group(b) || byRank(a, b));
  return {
    proposals,
    tickets: listed.map((i) => {
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
  };
}
