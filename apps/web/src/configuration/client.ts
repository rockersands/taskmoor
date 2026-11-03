import { api } from '../api/client';

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
}

/** What a change of workflows would leave behind: tickets in statuses the new workflow lacks. */
export interface MappingNeeded {
  ticketTypeId: number;
  statusId: number;
  ticketCount: number;
  workflowId: number;
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

/** The endpoints the configuration pages use. Stories and tests pass their own. */
export interface ConfigurationClient {
  tracks: () => Promise<Track[]>;
  /** The track made, and the board its template made in it, if any. */
  createTrack: (body: NewTrack) => Promise<{ track: Track; board?: Named }>;
  updateTrack: (
    id: number,
    change: { name?: string; description?: string; workflowMapId?: number | null },
  ) => Promise<Track>;
  archiveTrack: (id: number, archive: boolean) => Promise<void>;
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
  updateWorkflowMap: (
    id: number,
    change: {
      name?: string;
      defaultWorkflowId?: number;
      entries?: { ticketTypeId: number; workflowId: number }[];
    },
  ) => Promise<WorkflowMap>;
  deleteWorkflowMap: (id: number) => Promise<void>;
  workflows: () => Promise<Named[]>;
  ticketTypes: () => Promise<Named[]>;
}

export const configurationClient: ConfigurationClient = {
  tracks: async () => (await api<{ tracks: Track[] }>('/tracks?archived=include&limit=200')).tracks,
  createTrack: (body) => api<{ track: Track; board?: Named }>('/tracks', { method: 'POST', body }),
  updateTrack: async (id, change) =>
    (await api<{ track: Track }>(`/tracks/${id}`, { method: 'PATCH', body: change })).track,
  archiveTrack: async (id, archive) => {
    await api<unknown>(`/tracks/${id}/${archive ? 'archive' : 'restore'}`, { method: 'POST' });
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
  updateWorkflowMap: async (id, change) =>
    (
      await api<{ workflowMap: WorkflowMap }>(`/workflow-maps/${id}`, {
        method: 'PATCH',
        body: change,
      })
    ).workflowMap,
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
};
