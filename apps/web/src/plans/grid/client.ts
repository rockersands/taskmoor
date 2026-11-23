import type { OutputType } from '@taskmoor/formula';
import { ApiError, api } from '../../api/client';
import type { SearchTicket } from '../../search/client';
import { filterParams, type LinkTypeOption, type PlanFilters } from '../client';
import type { SavedTicket } from './compute';
import type { GridAnswer, StructureList, StructureSpec, StructureSummary } from './types';

/**
 * A plan's Grid on the server (T-089a; PLN-010; ADR-122 stage 10): its structures, the skeleton
 * of one for this viewer, the tickets of the rows in view, and what the structure dialog checks
 * against. Edits and moves are the ticket's own `PATCH /tickets/:id` (the search client's `edit`).
 */

/** A refused write: the code, the fields it names, and what else the server said. */
export type StructureOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: string;
      fields: Record<string, string>;
      permission?: string;
      limit?: number;
      /** For a formula that does not check: the body of `GET /formulas/check`. */
      check?: FormulaCheck;
    };

/** `GET /api/v1/formulas/check`: what a formula gives, or where and why it is wrong. */
export type FormulaCheck =
  | { ok: true; type: string }
  | { ok: false; error: { code: string; message: string; start?: number; end?: number } };

/** Where the skeleton is read: the page's filters, and the scenario open (live values in it). */
export interface GridAt {
  filters: PlanFilters;
  scenario?: number | undefined;
}

/** A hierarchy level as the administrators named it: the Grid's one place for these names. */
export interface LevelName {
  rank: number;
  name: string;
}

export interface GridClient {
  list(planId: number): Promise<StructureList>;
  create(
    planId: number,
    name: string,
    spec: StructureSpec,
  ): Promise<StructureOutcome<StructureSummary>>;
  change(
    planId: number,
    sid: number,
    change: { name?: string; spec?: StructureSpec; version: number },
  ): Promise<StructureOutcome<StructureSummary>>;
  remove(planId: number, sid: number, version: number): Promise<StructureOutcome<null>>;
  /**
   * The skeleton of a structure (`default` for the unsaved one). A read that runs too long throws
   * an `ApiError` of 503 `query_timeout`: the server never answers part of one.
   */
  rows(planId: number, sid: number | 'default', at: GridAt): Promise<GridAnswer>;
  /** Up to 500 tickets of the rows in view; one the viewer may not see is left out. */
  tickets(planId: number, ids: readonly number[]): Promise<SearchTicket[]>;
  checkFormula(expression: string, output: OutputType): Promise<FormulaCheck>;
  linkTypes(): Promise<LinkTypeOption[]>;
  levels(): Promise<LevelName[]>;
}

const of = (planId: number) => `/plans/${planId}/structures`;

/** A call's answer, or its refusal as the server said it; a dropped connection still throws. */
async function outcome<T>(call: () => Promise<T>): Promise<StructureOutcome<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const body = error.body as {
      fields?: Record<string, string>;
      permission?: unknown;
      limit?: unknown;
      check?: FormulaCheck;
    } | null;
    return {
      ok: false,
      code: error.code ?? String(error.status),
      fields: body?.fields ?? {},
      ...(typeof body?.permission === 'string' ? { permission: body.permission } : {}),
      ...(typeof body?.limit === 'number' ? { limit: body.limit } : {}),
      ...(body?.check ? { check: body.check } : {}),
    };
  }
}

export const gridClient: GridClient = {
  list: (planId) => api<StructureList>(of(planId)),
  create: (planId, name, spec) =>
    outcome(
      async () =>
        (
          await api<{ structure: StructureSummary }>(of(planId), {
            method: 'POST',
            body: { name, spec },
          })
        ).structure,
    ),
  change: (planId, sid, change) =>
    outcome(
      async () =>
        (
          await api<{ structure: StructureSummary }>(`${of(planId)}/${sid}`, {
            method: 'PATCH',
            body: change,
          })
        ).structure,
    ),
  remove: (planId, sid, version) =>
    outcome(async () => {
      await api(`${of(planId)}/${sid}?version=${version}`, { method: 'DELETE' });
      return null;
    }),
  rows: (planId, sid, at) => {
    const params = filterParams(at.filters);
    if (at.scenario !== undefined) params.set('scenario', String(at.scenario));
    const text = params.toString();
    return api<GridAnswer>(`${of(planId)}/${sid}/rows${text ? `?${text}` : ''}`);
  },
  tickets: async (planId, ids) =>
    (
      await api<{ tickets: SearchTicket[] }>(`/plans/${planId}/grid/tickets`, {
        method: 'POST',
        body: { ids },
      })
    ).tickets,
  checkFormula: (expression, output) => {
    const params = new URLSearchParams({ expression, output });
    return api<FormulaCheck>(`/formulas/check?${params}`);
  },
  linkTypes: async () =>
    (await api<{ linkTypes: LinkTypeOption[] }>('/link-types')).linkTypes.map((l) => ({
      id: l.id,
      name: l.name,
      outward: l.outward,
      inward: l.inward,
    })),
  levels: async () =>
    (await api<{ levels: LevelName[] }>('/hierarchy-levels')).levels.map((l) => ({
      rank: l.rank,
      name: l.name,
    })),
};

/** Whether a failed read was the server refusing one that ran too long. */
export const isTimeout = (error: unknown) =>
  error instanceof ApiError && error.status === 503 && error.code === 'query_timeout';

/**
 * A ticket of the search route's shape as a row edit reads it: the time tracking values sit under
 * `timeTracking` there, and formulas name them on their own.
 */
export function savedTicketOf(ticket: SearchTicket): SavedTicket {
  const time = ticket.timeTracking as
    | { originalEstimate?: unknown; remainingEstimate?: unknown; timeSpent?: unknown }
    | undefined;
  return {
    ...ticket,
    ...(time
      ? {
          originalEstimate: time.originalEstimate ?? null,
          remainingEstimate: time.remainingEstimate ?? null,
          timeSpent: time.timeSpent ?? null,
        }
      : {}),
  };
}
