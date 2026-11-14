import { ApiError, api } from '../api/client';
import { type CapacityUnit, filterParams, type PlanFilters, type ScenarioInView } from './client';

export type { ScenarioInView };

/**
 * Scenarios and draft changes of a plan (T-089e; PLN-002, PLN-003; ADR-122 stage 6). A scenario
 * is a named set of drafts to a plan's tickets: their start and due days and Team values. Nothing
 * changes a ticket until its drafts are applied, which is the ticket's own change with the
 * applier's permissions. A scenario gives no access: drafts on tickets the plan does not show the
 * viewer are only counted (`notShown`).
 */

/** One row of `GET /plans/:id/scenarios`. */
export interface ScenarioRow extends ScenarioInView {
  /** An apply holds it now. */
  applying: boolean;
  createdBy: { id: number; name: string };
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ScenarioLimits {
  scenarios: number;
  draftedTickets: number;
  perRequest: number;
  perApply: number;
}

export interface ScenarioList {
  plan: { id: number; name: string };
  /** Whether the viewer may draft, apply and manage scenarios: the plan's owner and site admins. */
  editable: boolean;
  /** Main first, then by name. */
  scenarios: ScenarioRow[];
  limits: ScenarioLimits;
}

/** A drafted value: a day as text, a team's id, or null for none. */
export type DraftValue = string | number | null;

/** One drafted field of a change: its value when drafted (`was`), now, and drafted. */
export interface ChangeField {
  /** `startDate`, `dueDate` or `cf:<id>` for a Team field. */
  field: string;
  teamFieldId: number | null;
  was: DraftValue;
  now: DraftValue;
  draft: DraftValue;
  state: 'ready' | 'changed' | 'already';
}

/** Why an apply left a ticket unchanged (PLN-002 (3)). */
export type RefusalReason =
  | 'no_permission'
  | 'locked'
  | 'track_archived'
  | 'gone'
  | 'changed_meanwhile'
  | 'invalid'
  | 'failed';

export interface ChangeRefusal {
  reason: RefusalReason;
  permission?: string;
  locks?: unknown;
  fields?: Record<string, string>;
  /** The drafted fields' values now, by field, for `changed_meanwhile`. */
  now?: Record<string, DraftValue>;
}

export type ChangeState = 'ready' | 'changed' | 'already' | 'refused';

/** One ticket's drafts in a scenario: the unit of the change list, of choosing and of applying. */
export interface PlanChange {
  ticketId: number;
  key: string;
  summary: string;
  trackId: number;
  version: number;
  state: ChangeState;
  fields: ChangeField[];
  /** Whether the reader holds what applying it needs. */
  mayApply: boolean;
  /** The permission the reader lacks: "Schedule tickets" for days, "Edit tickets" for a team. */
  needs: 'schedule_tickets' | 'edit_tickets' | null;
  refusal: ChangeRefusal | null;
  refusedAt: string | null;
  origin: 'person' | 'scheduler';
  updatedBy: { id: number; name: string };
  updatedAt: string;
}

/** A page of the change list, or the tickets a write named. */
export interface ChangePage {
  changes: PlanChange[];
  /** Shown tickets per state; `already` ones go on with the ready ones. */
  counts: { ready: number; already: number; changed: number; refused: number };
  /** Drafted tickets shown to the reader. */
  drafts: number;
  notShown: number;
  /** The names of the teams and Team fields the page's values name. */
  teams: { id: number; name: string }[];
  teamFields: { id: number; name: string }[];
  /** The cursor of the next page; null on the last. */
  next: number | null;
}

/** `GET /plans/:id/scenarios/:sid/changes`. */
export interface ChangeList extends ChangePage {
  scenario: { id: number; name: string; main: boolean };
  editable: boolean;
  /** An apply holds the scenario now. */
  applying: boolean;
}

/** One ticket's drafts to write: days (null clears one) and Team values by the field's id. */
export interface DraftInput {
  ticketId: number;
  startDate?: string | null;
  dueDate?: string | null;
  fields?: Record<string, number | null>;
}

/** What an apply answers: those changed, those refused with why, and the next page's cursor. */
export interface ApplyResult {
  applied: { ticketId: number; key: string }[];
  /** `key` is null for `gone`: the answer never says whether a hidden ticket held a draft. */
  refused: ({ ticketId: number; key: string | null } & ChangeRefusal)[];
  next: number | null;
  notShown: number;
}

/** A plan's end, or a team's: the latest due day of open tickets, and those without one. */
export interface ComparedEnd {
  due: string | null;
  ticket: { id: number; key: string; summary: string } | null;
  undated: number;
}

export interface ComparedSide {
  side: string;
  /** Null for the tickets as they are (Live). */
  scenario: ScenarioInView | null;
  end: ComparedEnd;
  /** Each plan team's end, then "other or no team" (`team: null`). */
  teams: ({ team: { id: number; name: string } | null } & ComparedEnd)[];
}

/** `GET /plans/:id/compare?a=&b=`. */
export interface Comparison {
  plan: { id: number; name: string };
  query: string | null;
  teamField: { id: number; name: string } | null;
  teamFields: { id: number; name: string }[];
  a: ComparedSide;
  b: ComparedSide;
  /** Tickets ending later, and earlier, in B than in A. */
  later: number;
  earlier: number;
  differing: {
    count: number;
    /** The first 200, with both sides' values. */
    tickets: {
      id: number;
      key: string;
      summary: string;
      a: { start: string | null; due: string | null; team: number | null };
      b: { start: string | null; due: string | null; team: number | null };
    }[];
  };
}

/** A write's answer: its value, or the refusal's code and the fields it names. */
export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; fields: Record<string, string>; permission?: string };

/*
 * The auto-scheduler (T-089f; PLN-004; ADR-122 stage 7). A run proposes start and due days for the
 * plan's open level-0 tickets the runner is shown, as drafts of origin `scheduler` in a scenario,
 * and says of each ticket why it was placed, kept or not placed. Reasons and warnings are codes
 * with ids, days and amounts; `scheduleWords.ts` says them in words.
 */

export const PLACED_REASONS = [
  'fits',
  'after_blocker',
  'after_higher_ranked',
  'first_for_blocked',
  'already',
  // Evening out load (ADR-122 stage 9).
  'moved_off_over',
  'pushed_by_move',
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
  // Evening out load (ADR-122 stage 9).
  'still_over',
  'would_make_late',
] as const;
export const LEFT_OUT_REASONS = ['level', 'type', 'release', 'query'] as const;
export const SCHEDULE_WARNINGS = ['after_release', 'late_against_kept', 'over_where_kept'] as const;
export type PlacedReason = (typeof PLACED_REASONS)[number];
export type KeptReason = (typeof KEPT_REASONS)[number];
export type NotPlacedReason = (typeof NOT_PLACED_REASONS)[number];
export type LeftOutReason = (typeof LEFT_OUT_REASONS)[number];
export type ScheduleWarningKind = (typeof SCHEDULE_WARNINGS)[number];
export type ScheduleReason = PlacedReason | KeptReason | NotPlacedReason;
export type ScheduleOutcome = 'placed' | 'kept' | 'not_placed';
/** What a run does: place work in rank order, or even out load (ADR-122 stage 9). */
export type ScheduleMode = 'fill' | 'even_out';

/**
 * What a reason or warning names: ids, days (`YYYY-MM-DD`) and amounts in the plan's unit only.
 * A subject is `teamId` or `userId`. Keys by reason, as the engine gives them
 * (`apps/server/src/plans/scheduler.ts`): `fits` subject, `periodStart`, `periodEnd`, `free`,
 * `capacity`, `before`; `after_blocker` `blockerId`, `blockerEnd`; `after_higher_ranked` subject,
 * `periodStart`; `first_for_blocked` `ticketId`; `no_team` `userId`; `no_capacity` `teamIds`;
 * `too_big` subject, `capacity`; `cycle` `ticketIds`, `size`; `blocker_undated` and
 * `blocker_not_placed` `blockerId`; `no_room` subject (when one has capacity), `until`. Warnings:
 * `after_release` `releaseId`, `releaseDate`, `days`; `late_against_kept` `ticketIds`, `count`;
 * `over_where_kept` subject, `periodStart`. Evening out (`apps/server/src/plans/evenOut.ts`):
 * `moved_off_over` subject, `fromPeriod`, `fromPeriodEnd`, `toPeriod`, `toPeriodEnd`, `days`,
 * `over`; `pushed_by_move` `blockerId`, `days`; `still_over` subject, `until`; `would_make_late`
 * `ticketId`, `why` (`kept`, `left_out`, `cycle`, `hidden_blocker`, `sprint` or `past_end`),
 * `until`.
 */
export type ScheduleArgs = Record<string, number | string | number[]>;

export interface ScheduleWarning {
  kind: ScheduleWarningKind;
  args: ScheduleArgs;
}

/** One ticket of a run's answer. */
export interface ScheduleEntry {
  id: number;
  key: string;
  /** Its summary, for the result's rows. */
  summary?: string;
  outcome: ScheduleOutcome;
  reason: ScheduleReason;
  args: ScheduleArgs;
  warnings: ScheduleWarning[];
  /** It changed while the run worked, so nothing was written for it: run again. */
  changedMeanwhile?: true;
}

/** The names the answer's ids stand for, as far as the reader is shown them. */
export interface ScheduleNames {
  teams: { id: number; name: string }[];
  people: { id: number; name: string }[];
  releases: { id: number; name: string }[];
  /** Tickets named by a reason that are not among the listed ones (a left-out blocker). */
  tickets: { id: number; key: string }[];
}

export interface ScheduleLimits {
  /** Periods a run looks ahead at most (12). */
  periods: number;
  /** Movable tickets one run places at most (10,000). */
  toSchedule: number;
  /** Ticket types, and releases, one run leaves out at most (20). */
  leftOut: number;
  /** The longest condition, in characters (2,000). */
  query: number;
  /** Periods a run looks ahead when the request names none (6). */
  defaultPeriods?: number;
  /** Tickets an answer lists (2,000); `more` counts the rest. */
  listed?: number;
}

/**
 * `GET /plans/:id/schedule?scenario=&from=&periods=`: whether a run can place anything, counted
 * over the tickets the reader is shown; no ticket is named.
 */
export interface ScheduleReadiness {
  unit: CapacityUnit;
  /** The Points field sizing tickets in points; null when none exists. */
  pointsField: { id: number; name: string } | null;
  /** The run's periods for `from` and `periods`. */
  periods: { start: string; end: string }[];
  /** The plan's teams, in its order, and whether each has capacity in any of those periods. */
  teams: { id: number; name: string; withCapacity: boolean }[];
  people: { withCapacity: number; without: number };
  tickets: { open: number; unestimated: number; unassigned: number; noTeam: number };
  /** Whether the reader may run it: the plan's editors, its owner and site administrators. */
  editable: boolean;
  limits: ScheduleLimits;
  /** The ticket types among the reader's open tickets, for Leave out ticket types. */
  types?: { id: number; name: string }[];
  /** The releases those tickets target, neither shipped nor archived, for Leave out releases. */
  releases?: { id: number; name: string; date: string | null }[];
  /**
   * In `scenario`: the auto-scheduler's drafted tickets the reader is shown, people's, and drafted
   * tickets the reader is not shown.
   */
  scenario?: { proposals: number; drafts: number; notShown?: number } | null;
  /** How many scenarios the plan has. */
  scenarios?: number;
  /**
   * How many cells (a team or person in a period of the run) are over capacity now, over the
   * reader's tickets: what evening out would work on.
   */
  overCells?: number;
}

/** The body of `POST /plans/:id/schedule`. */
export interface ScheduleRequest {
  /** The open scenario, or a new one (a copy of `from`'s drafts when given). */
  into: { scenarioId: number } | { newScenario: { name: string; from?: number } };
  /** The first day, the person's own today by default. */
  from?: string;
  /** 1 to 12, 6 by default. */
  periods?: number;
  leaveOut?: { typeIds?: number[]; releaseIds?: number[]; query?: string };
  /** The two flags are on by default. */
  keep?: { inProgress?: boolean; inActiveSprint?: boolean; query?: string };
  /** `fill` (the default) or `even_out`. */
  mode?: ScheduleMode;
}

/** A cell still over capacity after evening out, in the plan's unit. */
export interface ScheduleOverLeft {
  teamId?: number;
  userId?: number;
  periodStart: string;
  periodEnd: string;
  over: number;
  /** Only tickets that may not move were in it. */
  onlyFixed: boolean;
}

/** A run's counts: tickets by outcome and reason, and what the write did. */
export interface ScheduleCounts {
  /** Placed tickets, those already where proposed included. */
  placed: number;
  /** Placed where they already are: nothing drafted. */
  already?: number;
  /**
   * Evening out only: the tickets moved later (or pushed) whose proposal stands. The list of
   * tickets is cut at 2,000, with those moved after those not moved, so it cannot be counted.
   */
  moved?: number;
  /** Proposals already drafted as they are now. */
  unchanged: number;
  /** Earlier proposals removed. */
  withdrawn: number;
  /** Tickets that changed while the run worked, left out of the write. */
  changedMeanwhile: number;
  kept: Record<KeptReason, number>;
  notPlaced: Record<NotPlacedReason, number>;
  leftOut: Record<LeftOutReason, number>;
  /** Tickets carrying each warning. */
  warnings: Record<ScheduleWarningKind, number>;
  /** Earlier proposals on tickets the runner is not shown, left as they were. */
  notShown: number;
}

/** `POST /plans/:id/schedule`'s answer: 200, or 201 when the run made the scenario. */
export interface ScheduleResult {
  scenario: { id: number; name: string; main: boolean; version: number };
  created: boolean;
  from: string;
  periods: { start: string; end: string }[];
  counts: ScheduleCounts;
  /** At most 2,000: not placed, placed with a warning, kept, placed; then by rank. */
  tickets: ScheduleEntry[];
  /** Tickets not listed. */
  more: number;
  names?: ScheduleNames;
  /** What the run did; `fill` when the answer does not say. */
  mode?: ScheduleMode;
  /** Evening out only: the cells still over capacity, every one of them. */
  overLeft?: ScheduleOverLeft[];
}

/** A run's answer, or its refusal with the limit and count it names. */
export type ScheduleRun =
  | { ok: true; value: ScheduleResult }
  | {
      ok: false;
      code: string;
      fields: Record<string, string>;
      permission?: string;
      limit?: number;
      count?: number;
    };

export interface ScenarioClient {
  list(planId: number): Promise<ScenarioList>;
  /** A new scenario, empty or a copy of `from`'s drafts the maker is shown; the first is main. */
  create(
    planId: number,
    name: string,
    from?: number,
  ): Promise<Outcome<{ scenario: ScenarioRow; left: { notShown: number } }>>;
  rename(planId: number, sid: number, name: string, version: number): Promise<Outcome<ScenarioRow>>;
  /** It and all its drafts, hidden ones too. */
  remove(planId: number, sid: number, version: number): Promise<Outcome<null>>;
  /** Makes it main; the former main stays a scenario with its drafts. */
  promote(planId: number, sid: number, version: number): Promise<Outcome<ScenarioRow[]>>;
  changes(
    planId: number,
    sid: number,
    page?: { cursor?: number; only?: 'ready' | 'refused' | 'changed' },
  ): Promise<ChangeList>;
  /**
   * Writes drafts, 1 to 200 tickets, all or nothing; a field set back to live loses its draft, and
   * a drafted value sent again stays as drafted. `keep` (Keep my draft) takes the values now as
   * the values when drafted.
   */
  draft(
    planId: number,
    sid: number,
    changes: DraftInput[],
    options?: { keep?: boolean },
  ): Promise<Outcome<ChangePage>>;
  /** Removes the chosen tickets' drafts the person is shown, or all of them. */
  discard(
    planId: number,
    sid: number,
    which: { tickets: number[] } | { all: true },
  ): Promise<Outcome<{ discarded: number; notShown: number }>>;
  /** Applies the main scenario's drafts: 1 to 100 tickets, or a page of all from `after`. */
  apply(
    planId: number,
    sid: number,
    which: { tickets: number[] } | { all: true; after?: number },
  ): Promise<Outcome<ApplyResult>>;
  /** Two sides, each `live` or a scenario's id, over the plan's tickets the viewer is shown. */
  compare(
    planId: number,
    a: string,
    b: string,
    filters: PlanFilters,
    teamField?: number,
  ): Promise<Comparison>;
  /** Readiness for an auto-schedule run (ADR-122 stage 7), for anyone who sees the plan. */
  readiness(
    planId: number,
    at?: { scenario?: number; from?: string; periods?: number },
  ): Promise<ScheduleReadiness>;
  /** Runs the auto-scheduler: drafts only, into the scenario chosen or a new one. */
  schedule(planId: number, body: ScheduleRequest): Promise<ScheduleRun>;
}

const of = (planId: number) => `/plans/${planId}/scenarios`;

/** A call's answer, or its refusal as the server said it; a dropped connection still throws. */
async function outcome<T>(call: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const body = error.body as { fields?: Record<string, string>; permission?: unknown } | null;
    return {
      ok: false,
      code: error.code ?? String(error.status),
      fields: body?.fields ?? {},
      ...(typeof body?.permission === 'string' ? { permission: body.permission } : {}),
    };
  }
}

export const scenarioClient: ScenarioClient = {
  list: (planId) => api<ScenarioList>(of(planId)),
  create: (planId, name, from) =>
    outcome(() =>
      api<{ scenario: ScenarioRow; left: { notShown: number } }>(of(planId), {
        method: 'POST',
        body: from === undefined ? { name } : { name, from },
      }),
    ),
  rename: (planId, sid, name, version) =>
    outcome(
      async () =>
        (
          await api<{ scenario: ScenarioRow }>(`${of(planId)}/${sid}`, {
            method: 'PATCH',
            body: { name, version },
          })
        ).scenario,
    ),
  remove: (planId, sid, version) =>
    outcome(async () => {
      await api(`${of(planId)}/${sid}?version=${version}`, { method: 'DELETE' });
      return null;
    }),
  promote: (planId, sid, version) =>
    outcome(
      async () =>
        (
          await api<{ scenarios: ScenarioRow[] }>(`${of(planId)}/${sid}/promote`, {
            method: 'POST',
            body: { version },
          })
        ).scenarios,
    ),
  changes: (planId, sid, page = {}) => {
    const params = new URLSearchParams();
    if (page.cursor !== undefined) params.set('cursor', String(page.cursor));
    if (page.only) params.set('only', page.only);
    const text = params.toString();
    return api<ChangeList>(`${of(planId)}/${sid}/changes${text ? `?${text}` : ''}`);
  },
  draft: (planId, sid, changes, options = {}) =>
    outcome(() =>
      api<ChangePage>(`${of(planId)}/${sid}/drafts`, {
        method: 'PUT',
        body: options.keep ? { changes, keep: true } : { changes },
      }),
    ),
  discard: (planId, sid, which) =>
    outcome(() =>
      api<{ discarded: number; notShown: number }>(`${of(planId)}/${sid}/discard`, {
        method: 'POST',
        body: which,
      }),
    ),
  apply: (planId, sid, which) =>
    outcome(() => api<ApplyResult>(`${of(planId)}/${sid}/apply`, { method: 'POST', body: which })),
  compare: (planId, a, b, filters, teamField) => {
    const params = filterParams(filters);
    params.set('a', a);
    params.set('b', b);
    if (teamField !== undefined) params.set('teamField', String(teamField));
    return api<Comparison>(`/plans/${planId}/compare?${params}`);
  },
  readiness: (planId, at = {}) => {
    const params = new URLSearchParams();
    if (at.scenario !== undefined) params.set('scenario', String(at.scenario));
    if (at.from) params.set('from', at.from);
    if (at.periods !== undefined) params.set('periods', String(at.periods));
    const text = params.toString();
    return api<ScheduleReadiness>(`/plans/${planId}/schedule${text ? `?${text}` : ''}`);
  },
  schedule: async (planId, body) => {
    try {
      return {
        ok: true,
        value: await api<ScheduleResult>(`/plans/${planId}/schedule`, { method: 'POST', body }),
      };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const said = error.body as {
        fields?: Record<string, string>;
        permission?: unknown;
        limit?: unknown;
        count?: unknown;
      } | null;
      return {
        ok: false,
        code: error.code ?? String(error.status),
        fields: said?.fields ?? {},
        ...(typeof said?.permission === 'string' ? { permission: said.permission } : {}),
        ...(typeof said?.limit === 'number' ? { limit: said.limit } : {}),
        ...(typeof said?.count === 'number' ? { count: said.count } : {}),
      };
    }
  },
};

/** The drafted fields' error a refused draft names, as one code: the first one's. */
export function draftRefusalCode(refused: { code: string; fields: Record<string, string> }) {
  const named = Object.values(refused.fields)[0];
  return refused.code === 'invalid_fields' && named ? named : refused.code;
}
