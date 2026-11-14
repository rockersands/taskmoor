import { ApiError, api } from '../api/client';
import { filterParams, type PlanFilters } from './client';

/**
 * Scenarios and draft changes of a plan (T-089e; PLN-002, PLN-003; ADR-122 stage 6). A scenario
 * is a named set of drafts to a plan's tickets: their start and due days and Team values. Nothing
 * changes a ticket until its drafts are applied, which is the ticket's own change with the
 * applier's permissions. A scenario gives no access: drafts on tickets the plan does not show the
 * viewer are only counted (`notShown`).
 */

/** A scenario as a view that reads it names it, counted for its viewer. */
export interface ScenarioInView {
  id: number;
  name: string;
  main: boolean;
  /** Drafted tickets the viewer is shown. */
  drafts: number;
  /** Drafted tickets the plan does not show the viewer: counted, never named. */
  notShown: number;
}

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
};

/** The drafted fields' error a refused draft names, as one code: the first one's. */
export function draftRefusalCode(refused: { code: string; fields: Record<string, string> }) {
  const named = Object.values(refused.fields)[0];
  return refused.code === 'invalid_fields' && named ? named : refused.code;
}
