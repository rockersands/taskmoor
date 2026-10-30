import { localDate } from '@taskmoor/query';
import { apply, byTime, emptyState, type ReportEvent, type ReportState } from './events';
import { dayEnd, nextDay } from './flow';
import { type Statistic, ticketValue } from './sprint-charts';

/**
 * Burndowns of a body of work across sprints (M1-062; RPT-001; ADR-059): a release (the tickets
 * that target it) or an outcome (the tickets under it), measured by a Scrum board's estimation
 * statistic and done statuses, from the report events alone.
 *
 * - **Per sprint** of the board, in start order: the work remaining at its start and end, the
 *   work completed during it, the work added (tickets joining, estimates raised, done tickets
 *   reopened) and removed (tickets leaving, estimates lowered). Changes between sprints count in
 *   no sprint but show in the next one's start.
 * - **Velocity** is the average completed over the last three completed sprints of the report;
 *   the forecast is the sprints still needed at that pace (none when there is no pace yet).
 * - **By day** (the release report): the scope and the completed work at the end of each local
 *   day, and a forecast date from the pace of the last 14 days.
 *
 * Each ticket's contribution is kept as it changes, so a step costs one ticket, not the scope.
 */
export interface ScopeInput {
  /** Whether a ticket belongs to the body of work as it stands. */
  member: (state: ReportState) => boolean;
  estimation: Statistic;
  /** The remaining estimate burns down instead of the original (time tracking on). */
  burnRemaining: boolean;
  done: ReadonlySet<number>;
  /** Events of every ticket that ever belonged. */
  events: readonly ReportEvent[];
  now: Date;
}

export interface ScopeSprint {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
}

export interface SprintWork {
  sprintId: number;
  /** Remaining at the start and at the end (now while it runs). */
  start: number;
  end: number;
  completed: number;
  added: number;
  removed: number;
}

export interface ScopeBurndown {
  sprints: SprintWork[];
  now: { scope: number; completed: number; remaining: number };
  velocity: number;
  /** Sprints still needed at the velocity; null without one. */
  forecast: number | null;
}

interface Contribution {
  value: number;
  done: boolean;
}

/** The running totals of a body of work, changed one ticket at a time. */
class Tally {
  private readonly states = new Map<number, ReportState>();
  private readonly contributions = new Map<number, Contribution | null>();
  scope = 0;
  completed = 0;
  remaining = 0;
  constructor(private readonly input: ScopeInput) {}

  private contribution(s: ReportState): Contribution | null {
    if (s.inTrash || !this.input.member(s)) return null;
    return {
      value: ticketValue(s, this.input),
      done: s.statusId !== null && this.input.done.has(s.statusId),
    };
  }

  /** Applies one event; returns what it did to the remaining work. */
  apply(e: ReportEvent): { completed: number; added: number; removed: number } {
    let s = this.states.get(e.ticketId);
    if (!s) {
      s = emptyState();
      this.states.set(e.ticketId, s);
    }
    const before = this.contributions.get(e.ticketId) ?? null;
    apply(s, e);
    const after = this.contribution(s);
    this.contributions.set(e.ticketId, after);
    const out = { completed: 0, added: 0, removed: 0 };
    for (const [c, sign] of [
      [before, -1],
      [after, 1],
    ] as const) {
      if (!c) continue;
      this.scope += sign * c.value;
      if (c.done) this.completed += sign * c.value;
      else this.remaining += sign * c.value;
    }
    const open = (c: Contribution | null) => (c && !c.done ? c.value : 0);
    if (before && after && !before.done && after.done) {
      out.completed = before.value;
      return out;
    }
    const change = open(after) - open(before);
    if (change > 0) out.added = change;
    else if (change < 0) out.removed = -change;
    return out;
  }
}

/** Velocity over the last three completed sprints. */
const VELOCITY_SPRINTS = 3;

export function scopeBurndown(
  input: ScopeInput & { sprints: readonly ScopeSprint[] },
): ScopeBurndown {
  const events = [...input.events].sort(byTime);
  const tally = new Tally(input);
  const nowMs = input.now.getTime();
  const sprints = [...input.sprints].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id - b.id,
  );
  const work: SprintWork[] = sprints.map((s) => ({
    sprintId: s.id,
    start: 0,
    end: 0,
    completed: 0,
    added: 0,
    removed: 0,
  }));
  // Moments in order: each sprint's start and end, and every event.
  const marks = sprints.flatMap((s, i) => [
    { at: s.startedAt.getTime(), i, kind: 'start' as const },
    { at: Math.min(s.completedAt?.getTime() ?? nowMs, nowMs), i, kind: 'end' as const },
  ]);
  marks.sort((a, b) => a.at - b.at || (a.kind === b.kind ? a.i - b.i : a.kind === 'end' ? -1 : 1));
  const running = new Set<number>();
  let m = 0;
  const pass = (at: number) => {
    // Only marks strictly earlier: a change at a sprint's start is part of what it starts with,
    // one at its end counts in it.
    while (m < marks.length && (marks[m]?.at ?? 0) < at) {
      const mark = marks[m++] as (typeof marks)[number];
      const w = work[mark.i] as SprintWork;
      if (mark.kind === 'start') {
        w.start = tally.remaining;
        running.add(mark.i);
      } else {
        w.end = tally.remaining;
        running.delete(mark.i);
      }
    }
  };
  for (const e of events) {
    const at = e.at.getTime();
    if (at > nowMs) break;
    pass(at);
    const changed = tally.apply(e);
    for (const i of running) {
      const w = work[i] as SprintWork;
      w.completed += changed.completed;
      w.added += changed.added;
      w.removed += changed.removed;
    }
  }
  pass(Number.POSITIVE_INFINITY);
  const completedSprints = sprints
    .map((s, i) => ({ s, w: work[i] as SprintWork }))
    .filter(({ s }) => s.completedAt !== null && s.completedAt.getTime() <= nowMs)
    .slice(-VELOCITY_SPRINTS);
  const velocity =
    completedSprints.length === 0
      ? 0
      : completedSprints.reduce((sum, { w }) => sum + w.completed, 0) / completedSprints.length;
  const remaining = tally.remaining;
  return {
    sprints: work,
    now: { scope: tally.scope, completed: tally.completed, remaining },
    velocity,
    forecast: remaining === 0 ? 0 : velocity > 0 ? Math.ceil(remaining / velocity) : null,
  };
}

export interface ScopeDay {
  date: string;
  scope: number;
  completed: number;
}

export interface ScopeByDay {
  days: ScopeDay[];
  /** Completed per day over the last 14 days (or fewer, when the report is shorter). */
  pace: number;
  /** The local date the work would be complete at that pace; null without pace. */
  forecast: string | null;
}

const PACE_DAYS = 14;

/** Scope and completed work at the end of each local day from `from` to today. */
export function scopeByDay(input: ScopeInput & { from: string; timeZone: string }): ScopeByDay {
  const events = [...input.events].sort(byTime);
  const tally = new Tally(input);
  const nowMs = input.now.getTime();
  const today = localDate(input.now, input.timeZone);
  const days: ScopeDay[] = [];
  let day = input.from;
  let i = 0;
  while (day <= today) {
    const end = Math.min(dayEnd(day, input.timeZone), nowMs);
    for (; i < events.length && (events[i] as ReportEvent).at.getTime() < end; i++) {
      tally.apply(events[i] as ReportEvent);
    }
    days.push({ date: day, scope: tally.scope, completed: tally.completed });
    day = nextDay(day);
  }
  const last = days[days.length - 1];
  const span = Math.min(PACE_DAYS, days.length - 1);
  const earlier = days[days.length - 1 - span];
  const pace = last && earlier && span > 0 ? (last.completed - earlier.completed) / span : 0;
  const left = last ? last.scope - last.completed : 0;
  let forecast: string | null = null;
  if (last && left <= 0) forecast = last.date;
  else if (last && pace > 0) {
    forecast = last.date;
    for (let n = Math.ceil(left / pace); n > 0; n--) forecast = nextDay(forecast);
  }
  return { days, pace, forecast };
}
