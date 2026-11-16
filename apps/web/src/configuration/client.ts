import { api } from '../api/client';
import { everyTrack } from '../api/tracks';
import { type TrackScopeClient, trackScopeClient } from '../sets/trackScope';

export interface Named {
  id: number;
  name: string;
}

/** A track as `GET /api/v1/tracks` shows it, as far as administration uses it. */
export interface Track {
  id: number;
  key: string;
  name: string;
  description: string;
  mode: 'shared' | 'local';
  workflowMapId: number | null;
  archived: boolean;
  /** Its feature toggles (CORE-002), as far as this page changes them. */
  features?: { sprints?: boolean };
}

/** A track's one board (ADR-116), as far as its sprints need: Scrum has them, Kanban not. */
export interface TrackBoard {
  id: number;
  kind: 'scrum' | 'kanban';
}

export interface RoleActors {
  roleId: number;
  roleName: string;
  users: Named[];
  groups: Named[];
}

export interface WorkflowMapSummary {
  id: number;
  name: string;
  description: string;
  isDefault: boolean;
  defaultWorkflow: Named;
  entryCount: number;
  trackCount: number;
}

export interface WorkflowMap {
  id: number;
  name: string;
  description: string;
  isDefault: boolean;
  defaultWorkflow: Named;
  entries: { ticketType: Named; workflow: Named }[];
  tracks: { id: number; key: string; name: string }[];
  /** The local-mode track that owns the map; null or absent for a shared map (M1-028). */
  trackId?: number | null;
}

/** A workflow a map may name: a shared one, or one a local-mode track owns (`trackId`). */
export interface MapWorkflow extends Named {
  trackId: number | null;
}

/**
 * A track's map as `GET /api/v1/tracks/:id/workflow-map` reads it, with the ticket types the
 * track offers and the workflow each follows (WF-001 (3)).
 */
export interface TrackWorkflowMap {
  workflowMap: WorkflowMap;
  ticketTypes: { ticketType: Named; workflow: Named }[];
}

/** What a change of workflows would leave behind: tickets in statuses the new workflow lacks. */
export interface MappingNeeded {
  ticketTypeId: number;
  statusId: number;
  ticketCount: number;
  workflowId: number;
}

/**
 * What a change of workflow map would do, as the preview routes answer it (WF-001; T-320): the
 * tickets in statuses their type's new workflow lacks, and the statuses each new workflow offers
 * them.
 */
export interface MappingImpact {
  ticketCount: number;
  lostStatuses: { ticketType: Named; status: Named; ticketCount: number; workflow: Named }[];
  targetWorkflows: (Named & { statuses: Named[] })[];
}

/** Where each lost status's tickets go, by ticket type: `{ typeId: { fromId: toId } }`. */
export type TypeStatusMapping = Record<string, Record<string, number>>;

/** How far the tickets a change moves have got (`GET /api/v1/workflow-migrations/:id`). */
export interface StatusMigration {
  id: number;
  status: 'queued' | 'running' | 'done';
  total: number;
  migrated: number;
}

/** Track templates (M1-054): each makes a track of its type with its features and board. */
export const TRACK_TEMPLATES = ['scrum', 'kanban', 'bug-tracking', 'business', 'blank'] as const;
export type TrackTemplate = (typeof TRACK_TEMPLATES)[number];

/** A new track: from a template, or with another shared track's configuration (M1-054). */
export interface NewTrack {
  key: string;
  name: string;
  mode: 'shared' | 'local';
  template?: TrackTemplate;
  copyFrom?: number;
}

/**
 * The endpoints the configuration pages use. Stories and tests pass their own. The track scope's
 * reads serve a local-mode track's own workflow map (T-322, `sets/trackScope.tsx`).
 */
export interface ConfigurationClient extends TrackScopeClient {
  tracks: () => Promise<Track[]>;
  /** The track made, and the board its template made in it, if any. */
  createTrack: (body: NewTrack) => Promise<{ track: Track; board?: Named }>;
  updateTrack: (
    id: number,
    change: {
      name?: string;
      description?: string;
      workflowMapId?: number | null;
      features?: { sprints: boolean };
    },
  ) => Promise<Track>;
  archiveTrack: (id: number, archive: boolean) => Promise<void>;
  /** The track's board, or null while it has none (one is made when the track is first opened). */
  trackBoard: (trackId: number) => Promise<TrackBoard | null>;
  roles: () => Promise<Named[]>;
  roleActors: (trackId: number) => Promise<RoleActors[]>;
  setRoleActor: (
    trackId: number,
    roleId: number,
    kind: 'users' | 'groups',
    actorId: number,
    on: boolean,
  ) => Promise<void>;
  findPeople: (query: string) => Promise<Named[]>;
  groups: () => Promise<Named[]>;
  workflowMaps: () => Promise<WorkflowMapSummary[]>;
  workflowMap: (id: number) => Promise<WorkflowMap>;
  createWorkflowMap: (body: { name: string; defaultWorkflowId: number }) => Promise<WorkflowMap>;
  /** The map saved, and the tickets it moves when a mapping was given (WF-001; T-320). */
  updateWorkflowMap: (
    id: number,
    change: MapChange & { name?: string; typeStatusMapping?: TypeStatusMapping },
  ) => Promise<{ workflowMap: WorkflowMap; statusMigration: StatusMigration | null }>;
  deleteWorkflowMap: (id: number) => Promise<void>;
  workflows: () => Promise<Named[]>;
  ticketTypes: () => Promise<Named[]>;
  /** A track's own map, with the types it offers (T-322). */
  trackWorkflowMap: (trackId: number) => Promise<TrackWorkflowMap>;
  /** The workflows a local-mode track's map may name: the shared ones and its own (T-322). */
  trackWorkflows: (trackId: number) => Promise<MapWorkflow[]>;
  /** What switching a shared-mode track to a map would do to its tickets (T-320). */
  trackMapImpact: (trackId: number, workflowMapId: number | 'default') => Promise<MappingImpact>;
  /** What a change of a map's workflows would do to the tickets of its tracks (T-320). */
  workflowMapImpact: (id: number, change: MapChange) => Promise<MappingImpact>;
  /** Switches a track's map (`null`: the default), moving tickets as the mapping says (T-320). */
  switchWorkflowMap: (
    trackId: number,
    workflowMapId: number | null,
    typeStatusMapping?: TypeStatusMapping,
  ) => Promise<{ track: Track; statusMigration: StatusMigration | null }>;
  statusMigration: (id: number) => Promise<StatusMigration>;
}

/** A change of a map's workflows: the one for every other type, and each type's own. */
export interface MapChange {
  defaultWorkflowId?: number;
  entries?: { ticketTypeId: number; workflowId: number }[];
}

export const configurationClient: ConfigurationClient = {
  ...trackScopeClient,
  tracks: () => everyTrack<Track>('archived=include'),
  createTrack: (body) => api<{ track: Track; board?: Named }>('/tracks', { method: 'POST', body }),
  updateTrack: async (id, change) =>
    (await api<{ track: Track }>(`/tracks/${id}`, { method: 'PATCH', body: change })).track,
  archiveTrack: async (id, archive) => {
    await api<unknown>(`/tracks/${id}/${archive ? 'archive' : 'restore'}`, { method: 'POST' });
  },
  // The list reads without making a board, as opening the track would (ADR-116).
  trackBoard: async (trackId) => {
    const { boards } = await api<{ boards: TrackBoard[] }>(`/boards?trackId=${trackId}`);
    const board = boards[0];
    return board ? { id: board.id, kind: board.kind } : null;
  },
  roles: async () => (await api<{ roles: Named[] }>('/roles')).roles,
  roleActors: async (trackId) =>
    (await api<{ roles: RoleActors[] }>(`/tracks/${trackId}/role-actors`)).roles,
  setRoleActor: async (trackId, roleId, kind, actorId, on) => {
    await api<unknown>(`/tracks/${trackId}/roles/${roleId}/${kind}/${actorId}`, {
      method: on ? 'PUT' : 'DELETE',
    });
  },
  // Name and id only: a configuration administrator gives roles too, and the list of people,
  // with addresses, is for site administrators (ADR-114).
  findPeople: async (query) =>
    (await api<{ people: Named[] }>(`/people/lookup?limit=8&q=${encodeURIComponent(query)}`))
      .people,
  groups: async () => (await api<{ groups: Named[] }>('/groups')).groups,
  workflowMaps: async () =>
    (await api<{ workflowMaps: WorkflowMapSummary[] }>('/workflow-maps')).workflowMaps,
  workflowMap: async (id) =>
    (await api<{ workflowMap: WorkflowMap }>(`/workflow-maps/${id}`)).workflowMap,
  createWorkflowMap: async (body) =>
    (await api<{ workflowMap: WorkflowMap }>('/workflow-maps', { method: 'POST', body }))
      .workflowMap,
  updateWorkflowMap: async (id, change) => {
    const saved = await api<{ workflowMap: WorkflowMap; statusMigration?: StatusMigration }>(
      `/workflow-maps/${id}`,
      { method: 'PATCH', body: change },
    );
    return { workflowMap: saved.workflowMap, statusMigration: saved.statusMigration ?? null };
  },
  deleteWorkflowMap: async (id) => {
    await api<unknown>(`/workflow-maps/${id}`, { method: 'DELETE' });
  },
  workflows: async () =>
    (await api<{ workflows: (Named & { trackId: number | null })[] }>('/workflows')).workflows
      .filter((w) => w.trackId === null)
      .map((w) => ({ id: w.id, name: w.name })),
  ticketTypes: async () =>
    (await api<{ ticketTypes: Named[] }>('/ticket-types')).ticketTypes.map((t) => ({
      id: t.id,
      name: t.name,
    })),
  trackWorkflowMap: (trackId) => api<TrackWorkflowMap>(`/tracks/${trackId}/workflow-map`),
  trackWorkflows: async (trackId) =>
    (await api<{ workflows: MapWorkflow[] }>(`/workflows?trackId=${trackId}`)).workflows.map(
      (w) => ({ id: w.id, name: w.name, trackId: w.trackId ?? null }),
    ),
  trackMapImpact: async (trackId, workflowMapId) =>
    (
      await api<{ impact: MappingImpact }>(
        `/tracks/${trackId}/workflow-map/impact?workflowMapId=${workflowMapId}`,
      )
    ).impact,
  workflowMapImpact: async (id, change) =>
    (
      await api<{ impact: MappingImpact }>(`/workflow-maps/${id}/impact`, {
        method: 'POST',
        body: change,
      })
    ).impact,
  switchWorkflowMap: async (trackId, workflowMapId, typeStatusMapping) => {
    const saved = await api<{ track: Track; statusMigration?: StatusMigration }>(
      `/tracks/${trackId}`,
      {
        method: 'PATCH',
        body: { workflowMapId, ...(typeStatusMapping ? { typeStatusMapping } : {}) },
      },
    );
    return { track: saved.track, statusMigration: saved.statusMigration ?? null };
  },
  statusMigration: async (id) =>
    (await api<{ statusMigration: StatusMigration }>(`/workflow-migrations/${id}`)).statusMigration,
};
