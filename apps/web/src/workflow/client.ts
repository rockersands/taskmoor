import { API_BASE, ApiError, api } from '../api/client';
import type { Stage, Status, WorkflowDefinition } from './definition';

/**
 * Statuses and workflows (`/api/v1/statuses`, `/api/v1/workflows`; M1-023, used by the editor
 * of M1-030). Site and configuration administrators manage both.
 */
export interface WorkflowSummary {
  id: number;
  name: string;
  description: string;
  isDefault: boolean;
  publishedVersion: number;
  draftVersion: number | null;
  /** Tracks that use it, the default's included. */
  trackCount: number;
}

export interface VersionView {
  version: number;
  definition: WorkflowDefinition;
  createdAt: string;
  publishedAt: string | null;
}

export interface TrackRef {
  id: number;
  key: string;
  name: string;
}

export interface WorkflowView {
  id: number;
  name: string;
  description: string;
  isDefault: boolean;
  published: VersionView;
  draft: VersionView | null;
  tracks: TrackRef[];
}

/** What publishing the draft does: statuses it drops, with their tickets, and who uses it. */
export interface Impact {
  removedStatuses: { statusId: number; ticketCount: number }[];
  tracks: TrackRef[];
}

export interface VersionEntry {
  version: number;
  state: 'published' | 'draft' | 'earlier';
  createdAt: string;
  createdBy: { id: number; name: string } | null;
  publishedAt: string | null;
  publishedBy: { id: number; name: string } | null;
}

export interface Named {
  id: number;
  name: string;
}

/** Names for the forms' pickers; null where the viewer may not list them. */
export interface Lookups {
  roles: Named[] | null;
  groups: Named[] | null;
  permissions: string[] | null;
}

/** How a status of an imported file came in (M1-127): matched by name, or created. */
export interface ImportedStatus {
  name: string;
  stage: Stage;
  statusId: number;
  outcome: 'matched' | 'created';
  /** The stage of the status the name matched, when the file has it in another. */
  stageHere?: Stage;
}

/** Something an imported file names that this workspace has no match for, and what became of it. */
export interface ImportProblem {
  kind: string;
  /** The file's name for it (a person's email), the field name or the permission key. */
  name: string;
  /** The guard, check, effect or rule type; `layout`; or a status lock's action. */
  rule: string;
  outcome: 'guard_never_passes' | 'narrowed' | 'removed' | 'transition_disabled' | 'kept';
  transition?: { id: number; name: string };
  onCreate?: true;
  status?: string;
}

export interface Imported {
  workflow: WorkflowView;
  report: { statuses: ImportedStatus[]; problems: ImportProblem[] };
}

export interface StatusInput {
  name: string;
  description?: string;
  stage: Stage;
}

export interface WorkflowsClient {
  list: () => Promise<WorkflowSummary[]>;
  get: (id: number) => Promise<WorkflowView>;
  create: (input: {
    name: string;
    description?: string;
    definition: WorkflowDefinition;
  }) => Promise<WorkflowView>;
  update: (id: number, changes: { name?: string; description?: string }) => Promise<WorkflowView>;
  remove: (id: number) => Promise<void>;
  saveDraft: (id: number, definition: WorkflowDefinition) => Promise<WorkflowView>;
  discardDraft: (id: number) => Promise<void>;
  impact: (id: number) => Promise<Impact>;
  publish: (id: number, statusMapping: Record<string, number>) => Promise<WorkflowView>;
  versions: (id: number) => Promise<VersionEntry[]>;
  restore: (id: number, version: number) => Promise<WorkflowView>;
  statuses: () => Promise<Status[]>;
  createStatus: (input: StatusInput) => Promise<Status>;
  updateStatus: (id: number, changes: Partial<StatusInput>) => Promise<Status>;
  deleteStatus: (id: number) => Promise<void>;
  orderStatuses: (ids: number[]) => Promise<Status[]>;
  lookups: () => Promise<Lookups>;
  /** Where a workflow's published version downloads as a file (M1-127). */
  exportHref: (id: number) => string;
  /** A workflow file as a new workflow, named as the file names it unless `name` is given. */
  importNew: (document: unknown, name?: string) => Promise<Imported>;
  /** A workflow file as the next draft of a workflow. */
  importDraft: (id: number, document: unknown) => Promise<Imported>;
}

/** A list the viewer may not read is null, not an error: the forms fall back to ids. */
async function optional<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiError && error.status !== 401) return null;
    throw error;
  }
}

export const workflowsClient: WorkflowsClient = {
  list: async () => (await api<{ workflows: WorkflowSummary[] }>('/workflows')).workflows,
  get: async (id) => (await api<{ workflow: WorkflowView }>(`/workflows/${id}`)).workflow,
  create: async (input) =>
    (await api<{ workflow: WorkflowView }>('/workflows', { method: 'POST', body: input })).workflow,
  update: async (id, changes) =>
    (await api<{ workflow: WorkflowView }>(`/workflows/${id}`, { method: 'PATCH', body: changes }))
      .workflow,
  remove: async (id) => {
    await api<null>(`/workflows/${id}`, { method: 'DELETE' });
  },
  saveDraft: async (id, definition) =>
    (
      await api<{ workflow: WorkflowView }>(`/workflows/${id}/draft`, {
        method: 'PUT',
        body: { definition },
      })
    ).workflow,
  discardDraft: async (id) => {
    await api<null>(`/workflows/${id}/draft`, { method: 'DELETE' });
  },
  impact: (id) => api<Impact>(`/workflows/${id}/impact`),
  publish: async (id, statusMapping) =>
    (
      await api<{ workflow: WorkflowView }>(`/workflows/${id}/publish`, {
        method: 'POST',
        body: Object.keys(statusMapping).length > 0 ? { statusMapping } : {},
      })
    ).workflow,
  versions: async (id) =>
    (await api<{ versions: VersionEntry[] }>(`/workflows/${id}/versions`)).versions,
  restore: async (id, version) =>
    (
      await api<{ workflow: WorkflowView }>(`/workflows/${id}/versions/${version}/restore`, {
        method: 'POST',
      })
    ).workflow,
  statuses: async () => (await api<{ statuses: Status[] }>('/statuses')).statuses,
  createStatus: async (input) =>
    (await api<{ status: Status }>('/statuses', { method: 'POST', body: input })).status,
  updateStatus: async (id, changes) =>
    (await api<{ status: Status }>(`/statuses/${id}`, { method: 'PATCH', body: changes })).status,
  deleteStatus: async (id) => {
    await api<null>(`/statuses/${id}`, { method: 'DELETE' });
  },
  orderStatuses: async (ids) =>
    (
      await api<{ statuses: Status[] }>('/statuses/order', {
        method: 'PUT',
        body: { statusIds: ids },
      })
    ).statuses,
  lookups: async () => {
    const [roles, groups, catalogue] = await Promise.all([
      optional(async () => (await api<{ roles: Named[] }>('/roles')).roles),
      optional(async () => (await api<{ groups: Named[] }>('/groups')).groups),
      optional(() =>
        api<{ track: Record<string, string[]> }>('/permissions/catalogue').then((c) =>
          Object.values(c.track).flat(),
        ),
      ),
    ]);
    return { roles, groups, permissions: catalogue };
  },
  exportHref: (id) => `${API_BASE}/admin/workflows/${id}/export`,
  importNew: (document, name) =>
    api<Imported>('/admin/workflows/import', {
      method: 'POST',
      body: { document, ...(name ? { name } : {}) },
    }),
  importDraft: (id, document) =>
    api<Imported>(`/admin/workflows/${id}/import`, { method: 'POST', body: { document } }),
};
