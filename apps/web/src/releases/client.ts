import { ApiError, api } from '../api/client';
import { routeHref } from '../routing/router';

export interface Approver {
  user: { id: number; name: string };
  decision: 'approved' | 'declined' | null;
  comment: string;
  decidedAt: string | null;
}

/** A release of a track (M1-014; CORE-016), with its target tickets counted for the viewer. */
export interface Release {
  id: number;
  trackId: number;
  name: string;
  description: string;
  startDate: string | null;
  releaseDate: string | null;
  order: number;
  shipped: boolean;
  shippedAt: string | null;
  archived: boolean;
  archivedAt: string | null;
  requireApprovals: boolean;
  progress: { tickets: number; closed: number; open: number };
  /** Upcoming, with its release day gone by. */
  overdue: boolean;
  /** The release across tracks it is in (PLN-007); null for none. */
  crossTrack?: {
    id: number;
    name: string;
    endRule: 'fixed_date' | 'work_complete';
    date: string | null;
  } | null;
  approvers?: Approver[];
}

export interface ReleaseList {
  releases: Release[];
  mayManage: boolean;
}

/** A number and the search that finds those tickets (M1-050). */
export interface Counted {
  query: string;
  count: number;
  exact: boolean;
}

export type WarningCode =
  | 'overdue'
  | 'open_after_ship'
  | 'unassigned'
  | 'open_found'
  | 'no_approvers'
  | 'approvals_waiting'
  | 'approval_declined'
  | 'cross_track_out_of_step';

export interface Warning {
  code: WarningCode;
  count: number;
  query?: string;
}

export interface ReleaseTicket {
  id: number;
  key: string;
  summary: string;
  type: string;
  status: string;
  stage: 'new' | 'active' | 'closed';
  assignee: string | null;
}

/** `GET /api/v1/releases/:id/overview` (M1-050). */
export interface ReleaseOverview {
  stages: { new: Counted; active: Counted; closed: Counted };
  open: Counted;
  warnings: Warning[];
  approvers: Approver[];
  tickets: ReleaseTicket[];
  truncated: boolean;
  viewer: {
    mayManage: boolean;
    approver: { decision: Approver['decision'] } | null;
  };
}

/** `GET /api/v1/releases/:id/notes` (M1-050): notes generated from the closed tickets. */
export interface ReleaseNotes {
  release: {
    id: number;
    name: string;
    track: { id: number; key: string; name: string };
    releaseDate: string | null;
    shipped: boolean;
    shippedOn: string | null;
  };
  sections: { type: string; tickets: { id: number; key: string; summary: string }[] }[];
  leftOut: { reason: string; count: number }[];
  truncated: boolean;
  markdown: string;
}

export interface NewRelease {
  name: string;
  releaseDate?: string;
}

export type Outcome = { ok: true } | { ok: false; code: string; openTickets?: number };

export interface ReleaseClient {
  track(key: string): Promise<{ id: number; key: string; name: string }>;
  list(trackId: number): Promise<ReleaseList>;
  create(trackId: number, release: NewRelease): Promise<Outcome>;
  get(releaseId: number): Promise<Release>;
  overview(releaseId: number): Promise<ReleaseOverview>;
  notes(releaseId: number): Promise<ReleaseNotes>;
  /** Ships; with open tickets, `moveOpenTo` says where they go (null: they stay). */
  ship(
    releaseId: number,
    options: { releaseDate: string; moveOpenTo?: number | null },
  ): Promise<Outcome>;
  decide(releaseId: number, decision: 'approved' | 'declined', comment: string): Promise<Outcome>;
  /** Align: the release's own change, to its release across tracks' day (PLN-007). */
  setDate(releaseId: number, releaseDate: string): Promise<Outcome>;
}

/** A change's answer: done, or the server's refusal code (and what it counted). */
async function outcome(work: () => Promise<unknown>): Promise<Outcome> {
  try {
    await work();
    return { ok: true };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const body = error.body as { openTickets?: number } | null;
    return {
      ok: false,
      code: error.code ?? String(error.status),
      ...(typeof body?.openTickets === 'number' ? { openTickets: body.openTickets } : {}),
    };
  }
}

export const releaseClient: ReleaseClient = {
  track: async (key) =>
    (
      await api<{ track: { id: number; key: string; name: string } }>(
        `/tracks/${encodeURIComponent(key)}`,
      )
    ).track,
  list: (trackId) => api<ReleaseList>(`/tracks/${trackId}/releases?archived=include`),
  create: (trackId, release) =>
    outcome(() => api(`/tracks/${trackId}/releases`, { method: 'POST', body: release })),
  get: async (releaseId) => (await api<{ release: Release }>(`/releases/${releaseId}`)).release,
  overview: (releaseId) => api<ReleaseOverview>(`/releases/${releaseId}/overview`),
  notes: (releaseId) => api<ReleaseNotes>(`/releases/${releaseId}/notes`),
  ship: (releaseId, options) =>
    outcome(() => api(`/releases/${releaseId}/ship`, { method: 'POST', body: options })),
  setDate: (releaseId, releaseDate) =>
    outcome(() => api(`/releases/${releaseId}`, { method: 'PATCH', body: { releaseDate } })),
  decide: (releaseId, decision, comment) =>
    outcome(() =>
      api(`/releases/${releaseId}/approval`, {
        method: 'POST',
        body: { decision, ...(comment.trim() ? { comment: comment.trim() } : {}) },
      }),
    ),
};

/** The search page for a query. */
export const searchHref = (query: string) =>
  routeHref(`#/search?${new URLSearchParams({ q: query }).toString()}`);

/** The notes as a file, straight from the server. */
export const notesFileHref = (releaseId: number) =>
  `/api/v1/releases/${releaseId}/notes?format=markdown`;
