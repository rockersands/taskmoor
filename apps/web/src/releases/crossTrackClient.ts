import { ApiError, api } from '../api/client';
import type { Counted, ReleaseTicket } from './client';

/** How one ends: on a fixed day, or when its work completes. */
export type CrossTrackEndRule = 'fixed_date' | 'work_complete';

/** Computed on each read over all its work, hidden work too (PLN-007). Nothing ships by itself. */
export type CrossTrackStateName = 'empty' | 'shipped' | 'overdue' | 'ready' | 'upcoming';

/** What a viewer is only told as numbers: never named, and never per release. */
export interface HiddenWork {
  releases: number;
  open: number;
}

export interface Progress {
  tickets: number;
  closed: number;
  open: number;
}

export interface TrackRef {
  id: number;
  key: string;
  name: string;
}

/** One row of `GET /api/v1/cross-track-releases`. */
export interface CrossTrackRow {
  id: number;
  name: string;
  endRule: CrossTrackEndRule;
  date: string | null;
  state: CrossTrackStateName;
  owner: { id: number; name: string };
  tracks: TrackRef[];
  progress: Progress;
  hidden: HiddenWork;
  version: number;
}

/** A linked release of a track the viewer may see. */
export interface LinkedRelease {
  id: number;
  name: string;
  track: TrackRef;
  startDate: string | null;
  releaseDate: string | null;
  shipped: boolean;
  archived: boolean;
  trackArchived: boolean;
  overdue: boolean;
  /** Upcoming, with another day than the release across tracks' fixed day. */
  outOfStep: boolean;
  progress: Progress;
  mayRemove?: boolean;
}

export type CrossTrackWarning =
  | { code: 'overdue' | 'unassigned'; count: number; query: string }
  | { code: 'out_of_step'; count: number };

/** `GET /api/v1/cross-track-releases/:id`. */
export interface CrossTrackRelease {
  id: number;
  name: string;
  description: string;
  endRule: CrossTrackEndRule;
  date: string | null;
  state: CrossTrackStateName;
  owner: { id: number; name: string };
  version: number;
  stages: { new: Counted; active: Counted; closed: Counted };
  open: Counted;
  warnings: CrossTrackWarning[];
  members: LinkedRelease[];
  hidden: HiddenWork;
  tickets: ReleaseTicket[];
  truncated: boolean;
  viewer: { mayManage: boolean };
}

/** An upcoming unlinked release of a track the person administers: what they may link. */
export interface Candidate {
  id: number;
  name: string;
  startDate: string | null;
  releaseDate: string | null;
  track: TrackRef;
}

export type MoveReason =
  | 'no_permission'
  | 'shipped'
  | 'archived'
  | 'track_archived'
  | 'start_after_date';

/** One line of a change list: what a move to `to` does to one release the person sees. */
export interface MoveLine {
  id: number;
  name: string;
  track: TrackRef;
  from: string | null;
  to: string;
  outcome: 'moves' | 'same' | 'stays';
  reason?: MoveReason;
}

/** The change list (`changed` false) or what happened (`changed` true). */
export interface MoveAnswer {
  from: string | null;
  to: string;
  version: number;
  lines: MoveLine[];
  hidden: { releases: number };
  changed: boolean;
}

export interface NewCrossTrack {
  name: string;
  description?: string;
  endRule: CrossTrackEndRule;
  date?: string;
  releaseIds: number[];
}

export interface CrossTrackEdit {
  name?: string;
  description?: string;
  endRule?: 'work_complete';
  version: number;
}

/** A change's answer: done with what it says, or the server's refusal. */
export type Saved<T> = { ok: true; value: T } | { ok: false; code: string; version?: number };

export interface CrossTrackClient {
  list(
    state: 'upcoming' | 'shipped',
    cursor?: string,
  ): Promise<{ releases: CrossTrackRow[]; next: string | null }>;
  candidates(): Promise<{ releases: Candidate[]; truncated: boolean }>;
  get(id: number): Promise<CrossTrackRelease>;
  create(input: NewCrossTrack): Promise<Saved<CrossTrackRelease>>;
  update(id: number, input: CrossTrackEdit): Promise<Saved<CrossTrackRelease>>;
  remove(id: number): Promise<Saved<null>>;
  /** The change list: changes nothing. */
  changes(id: number, date: string): Promise<Saved<MoveAnswer>>;
  move(id: number, date: string, version: number): Promise<Saved<MoveAnswer>>;
  link(id: number, releaseId: number): Promise<Saved<CrossTrackRelease>>;
  unlink(id: number, releaseId: number): Promise<Saved<null>>;
}

async function saved<T>(work: () => Promise<T>): Promise<Saved<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const body = error.body as { version?: number } | null;
    return {
      ok: false,
      code: error.code ?? String(error.status),
      ...(typeof body?.version === 'number' ? { version: body.version } : {}),
    };
  }
}

const BASE = '/cross-track-releases';

export const crossTrackClient: CrossTrackClient = {
  list: (state, cursor) =>
    api(`${BASE}?${new URLSearchParams({ state, ...(cursor ? { cursor } : {}) }).toString()}`),
  candidates: () => api(`${BASE}/candidates`),
  get: (id) => api(`${BASE}/${id}`),
  create: (input) => saved(() => api(BASE, { method: 'POST', body: input })),
  update: (id, input) => saved(() => api(`${BASE}/${id}`, { method: 'PATCH', body: input })),
  remove: (id) =>
    saved(async () => {
      await api(`${BASE}/${id}`, { method: 'DELETE' });
      return null;
    }),
  changes: (id, date) => saved(() => api(`${BASE}/${id}/move?date=${encodeURIComponent(date)}`)),
  move: (id, date, version) =>
    saved(() => api(`${BASE}/${id}/move`, { method: 'POST', body: { date, version } })),
  link: (id, releaseId) =>
    saved(() => api(`${BASE}/${id}/members`, { method: 'POST', body: { releaseId } })),
  unlink: (id, releaseId) =>
    saved(async () => {
      await api(`${BASE}/${id}/members/${releaseId}`, { method: 'DELETE' });
      return null;
    }),
};
