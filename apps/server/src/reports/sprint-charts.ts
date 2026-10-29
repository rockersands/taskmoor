import { instantOf, localDate } from '@taskmoor/query';
import { apply, byTime, type ReportEvent, type ReportState } from './events';

/**
 * Sprint burndown and burnup (M1-060; RPT-001; ADR-057), computed from the report events alone
 * (M1-059), so a chart replays identically and a past day never changes.
 *
 * - **The value of a ticket** follows the board's estimation statistic: 1 per ticket, the
 *   original time estimate, or a number field (story points). With time tracking on and the
 *   original estimate as the statistic, the remaining estimate burns down instead, so logged
 *   work lowers the line. A ticket without an estimate counts 0 (1 for ticket count).
 * - **Remaining** is the sum over the sprint's tickets that are not done; done is a status of
 *   the board's rightmost column. **Scope** is the sum over all of the sprint's tickets;
 *   **completed** the sum over the done ones (burnup).
 * - **Steps**: every change after the start that moves remaining or scope, with its cause:
 *   added or removed (scope change after the start), completed or reopened (a status into or
 *   out of done), estimate (a value changed).
 * - **Days**: the values at the end of each day of the sprint on the viewer's time zone, up to
 *   the end (the completion, or now while it runs; the planned end when that is earlier). The
 *   guideline runs from the remaining at the start to 0 at the planned end.
 */
export type Statistic =
  | { statistic: 'ticketCount' }
  | { statistic: 'originalEstimate' }
  | { statistic: 'field'; fieldId: number };

export interface ChartInput {
  sprintId: number;
  startedAt: Date;
  /** The planned end. */
  endAt: Date;
  completedAt: Date | null;
  estimation: Statistic;
  /** Remaining estimate burns down instead of the original (time tracking on). */
  burnRemaining: boolean;
  done: ReadonlySet<number>;
  /** Events of every ticket that was ever in the sprint, up to now. */
  events: readonly ReportEvent[];
  now: Date;
  timeZone: string;
}

export type StepCause = 'added' | 'removed' | 'completed' | 'reopened' | 'estimate';

export interface Step {
  at: string;
  ticketId: number;
  cause: StepCause;
  remaining: number;
  scope: number;
  completed: number;
}

export interface Day {
  /** The local date. */
  date: string;
  remaining: number;
  scope: number;
  completed: number;
}

export interface SprintChart {
  /** Every local date from the start to the planned end, or to the last day when later. */
  dates: string[];
  start: { at: string; remaining: number; scope: number };
  /** From the remaining at the start to 0 at the planned end, with their local dates. */
  guideline: {
    from: { at: string; date: string; value: number };
    to: { at: string; date: string; value: number };
  };
  steps: Step[];
  days: Day[];
  end: { at: string; remaining: number; scope: number; completed: number };
}

const fresh = (): ReportState => ({
  trackId: null,
  typeId: null,
  statusId: null,
  closeReasonId: null,
  assigneeId: null,
  parentId: null,
  originalEstimate: null,
  remainingEstimate: null,
  timeSpent: 0,
  inTrash: false,
  numbers: {},
  sprints: new Set(),
});

/** One ticket's value by the board's statistic. */
export function ticketValue(
  state: ReportState,
  input: Pick<ChartInput, 'estimation' | 'burnRemaining'>,
) {
  const e = input.estimation;
  if (e.statistic === 'ticketCount') return 1;
  if (e.statistic === 'originalEstimate') {
    return (input.burnRemaining ? state.remainingEstimate : state.originalEstimate) ?? 0;
  }
  return state.numbers[e.fieldId] ?? 0;
}

const DAY = 86_400_000;

export function sprintChart(input: ChartInput): SprintChart {
  const states = new Map<number, ReportState>();
  const stateOf = (id: number) => {
    let s = states.get(id);
    if (!s) {
      s = fresh();
      states.set(id, s);
    }
    return s;
  };
  const inSprint = (s: ReportState) => s.sprints.has(input.sprintId) && !s.inTrash;
  const isDone = (s: ReportState) => s.statusId !== null && input.done.has(s.statusId);
  const totals = () => {
    let remaining = 0;
    let scope = 0;
    let completed = 0;
    for (const s of states.values()) {
      if (!inSprint(s)) continue;
      const v = ticketValue(s, input);
      scope += v;
      if (isDone(s)) completed += v;
      else remaining += v;
    }
    return { remaining, scope, completed };
  };

  const events = [...input.events].sort(byTime);
  const startMs = input.startedAt.getTime();
  // Up to the end: the completion; while the sprint runs, now.
  const until = input.completedAt ?? input.now;
  const untilMs = until.getTime();
  let i = 0;
  // Everything up to the start, membership at the start included.
  for (; i < events.length && (events[i] as ReportEvent).at.getTime() <= startMs; i++) {
    const e = events[i] as ReportEvent;
    apply(stateOf(e.ticketId), e);
  }
  const atStart = totals();

  const steps: Step[] = [];
  const days: Day[] = [];
  const zone = input.timeZone;
  const lastDay = localDate(until, zone);
  let day = localDate(input.startedAt, zone);
  const closeDaysBefore = (ms: number) => {
    // Each local day that ends before `ms` is closed with the totals as they stand.
    while (day < lastDay && dayEnd(day, zone) <= ms) {
      days.push({ date: day, ...totals() });
      day = nextDay(day);
    }
  };
  for (; i < events.length; i++) {
    const e = events[i] as ReportEvent;
    const at = e.at.getTime();
    if (at > untilMs) break;
    // The completion closes every membership; it is the end, not a change of scope.
    if (isCompletion(e, input.sprintId)) continue;
    closeDaysBefore(at);
    const s = stateOf(e.ticketId);
    const wasIn = inSprint(s);
    const wasDone = isDone(s);
    const totalsBefore = totals();
    apply(s, e);
    const nowIn = inSprint(s);
    const nowDone = isDone(s);
    const after = totals();
    if (
      after.remaining === totalsBefore.remaining &&
      after.scope === totalsBefore.scope &&
      after.completed === totalsBefore.completed
    ) {
      continue;
    }
    const cause: StepCause =
      !wasIn && nowIn
        ? 'added'
        : wasIn && !nowIn
          ? 'removed'
          : !wasDone && nowDone
            ? 'completed'
            : wasDone && !nowDone
              ? 'reopened'
              : 'estimate';
    steps.push({ at: e.at.toISOString(), ticketId: e.ticketId, cause, ...after });
  }
  closeDaysBefore(untilMs);
  days.push({ date: day, ...totals() });
  const end = totals();
  const dates: string[] = [];
  const plannedLast = localDate(input.endAt, zone);
  const lastDate = plannedLast > lastDay ? plannedLast : lastDay;
  for (let d = localDate(input.startedAt, zone); d <= lastDate; d = nextDay(d)) dates.push(d);
  return {
    dates,
    start: {
      at: input.startedAt.toISOString(),
      remaining: atStart.remaining,
      scope: atStart.scope,
    },
    guideline: {
      from: {
        at: input.startedAt.toISOString(),
        date: localDate(input.startedAt, zone),
        value: atStart.remaining,
      },
      to: { at: input.endAt.toISOString(), date: plannedLast, value: 0 },
    },
    steps,
    days,
    end: { at: until.toISOString(), ...end },
  };
}

const isCompletion = (e: ReportEvent, sprintId: number) =>
  e.kind === 'sprint' &&
  e.sprintId === sprintId &&
  (e.change === 'completed' || e.change === 'carried_over');

/** The instant a local day ends: the next day's midnight on the zone's clock, in milliseconds. */
function dayEnd(date: string, timeZone: string): number {
  const [year, month, day] = nextDay(date).split('-').map(Number) as [number, number, number];
  return instantOf({ year, month, day, hour: 0, minute: 0, second: 0, ms: 0 }, timeZone).getTime();
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
}
