import { ApiError, api } from '../api/client';
import { findPeople, findTeams } from '../tickets/pickerSources';

/** A person or a team, by id and name. */
export interface Named {
  id: number;
  name: string;
}

/** Who a new ticket with no assignee goes to, from the first of its areas that names someone. */
export const AREA_RULES = ['area_owner', 'track_owner', 'unassigned'] as const;
export type AreaRule = (typeof AREA_RULES)[number];

/** An area of a track (CORE-015), as `GET /api/v1/tracks/:id/areas` gives it. */
export interface Area {
  id: number;
  trackId: number;
  name: string;
  description: string;
  owner: Named | null;
  /** The team that owns the area (CORE-027). */
  ownerTeam: Named | null;
  defaultAssignee: AreaRule;
  archived: boolean;
  archivedAt: string | null;
}

/** What a new or changed area says. */
export interface AreaInput {
  name: string;
  description: string;
  ownerId: number | null;
  ownerTeamId: number | null;
  defaultAssignee: AreaRule;
}

/** The track the page is about. */
export interface AreaTrack {
  id: number;
  key: string;
  name: string;
  archived: boolean;
}

/**
 * Where the tickets of an area being deleted go: another area of the track, or nowhere (the area
 * is taken off them). Nothing, for an area no ticket is in: the server says if one is.
 */
export type AreaDeletion = { replacementId: number } | { removeFromTickets: true };

export interface AreaClient {
  /** The track by its key. */
  track(key: string): Promise<AreaTrack>;
  /** Every area of the track, archived ones included, by name. */
  list(trackId: number): Promise<Area[]>;
  /** Whether the reader may change the track's areas: its administrators, site and configuration administrators. */
  mayManage(trackId: number): Promise<boolean>;
  create(trackId: number, input: AreaInput): Promise<Area>;
  update(areaId: number, input: AreaInput): Promise<Area>;
  archive(areaId: number): Promise<Area>;
  restore(areaId: number): Promise<Area>;
  /** Refused with 409 `in_use` and the `ticketCount` when tickets are in it and no `deletion` says where they go. */
  remove(areaId: number, deletion?: AreaDeletion): Promise<void>;
  /** People found by name in the track, to own an area. */
  people(trackKey: string, typed: string): Promise<Named[]>;
  /** Teams found by name, to own an area. */
  teams(typed: string): Promise<Named[]>;
}

export const areaClient: AreaClient = {
  track: async (key) =>
    (await api<{ track: AreaTrack }>(`/tracks/${encodeURIComponent(key)}`)).track,
  list: async (trackId) =>
    (await api<{ areas: Area[] }>(`/tracks/${trackId}/areas?archived=include`)).areas,
  // The areas list does not say whether the reader may change them. The releases list does, by
  // the very rule the area routes hold to (mayManage in routes/releases.ts decides both), so the
  // page asks it, for the archived releases alone: the shortest answer that carries it.
  mayManage: async (trackId) =>
    (await api<{ mayManage: boolean }>(`/tracks/${trackId}/releases?archived=only`)).mayManage,
  create: async (trackId, input) =>
    (await api<{ area: Area }>(`/tracks/${trackId}/areas`, { method: 'POST', body: input })).area,
  update: async (areaId, input) =>
    (await api<{ area: Area }>(`/areas/${areaId}`, { method: 'PATCH', body: input })).area,
  archive: async (areaId) =>
    (await api<{ area: Area }>(`/areas/${areaId}/archive`, { method: 'POST' })).area,
  restore: async (areaId) =>
    (await api<{ area: Area }>(`/areas/${areaId}/restore`, { method: 'POST' })).area,
  remove: async (areaId, deletion) => {
    const query = !deletion
      ? ''
      : `?${new URLSearchParams(
          'replacementId' in deletion
            ? { replacementId: String(deletion.replacementId) }
            : { removeFromTickets: 'true' },
        ).toString()}`;
    await api<unknown>(`/areas/${areaId}${query}`, { method: 'DELETE' });
  },
  people: (trackKey, typed) => findPeople(trackKey, typed),
  teams: (typed) => findTeams(typed),
};

/** The tickets an area holds, when the server refused to delete it for them; null otherwise. */
export function ticketsInUse(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'in_use') return null;
  const count = (error.body as { ticketCount?: unknown } | null)?.ticketCount;
  return typeof count === 'number' ? count : 0;
}

/** The search for a track's tickets in an area, by the area's name. */
export function areaQuery(trackKey: string, areaName: string): string {
  return `track = ${trackKey} AND area = "${areaName.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}
