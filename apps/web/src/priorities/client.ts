import { api } from '../api/client';

/** A priority as `GET /api/v1/priorities` gives it; `level` (1 to 6) is its icon, by its place. */
export interface Priority {
  id: number;
  name: string;
  description: string;
  icon: string | null;
  color: string | null;
  order: number;
  level: number;
}

/** Which priorities a track offers, and the one new tickets get (CORE-014 (2)). */
export interface PrioritySet {
  id: number;
  name: string;
  description: string;
  isDefault: boolean;
  /** In the order of the site's list. */
  priorityIds: number[];
  /** Null: new tickets get the middle of what the set offers. */
  defaultPriorityId: number | null;
  /** Tracks that use it; for the default set, those that choose no set too. */
  trackCount: number;
}

export interface CloseReason {
  id: number;
  name: string;
  description: string;
  order: number;
}

export interface NamedValue {
  name: string;
  description?: string;
}

export interface PrioritySetChange {
  name?: string;
  description?: string;
  priorityIds?: number[];
  defaultPriorityId?: number | null;
  /** Makes this the default set; the old default stops being one. */
  isDefault?: true;
}

/**
 * The endpoints the Priorities page uses (`routes/priorities.ts`). Stories and tests pass their
 * own. A delete without `replacementId` is refused while tickets use the value (`409 in_use`) or,
 * for a close reason, while a workflow sets it (`409 used_by_workflow`).
 */
export interface PrioritiesClient {
  priorities: () => Promise<Priority[]>;
  createPriority: (body: NamedValue) => Promise<void>;
  updatePriority: (id: number, change: NamedValue) => Promise<void>;
  /** Every priority's id, once each, in the new order. */
  orderPriorities: (ids: number[]) => Promise<void>;
  deletePriority: (id: number, replacementId?: number) => Promise<void>;
  prioritySets: () => Promise<PrioritySet[]>;
  createPrioritySet: (
    body: NamedValue & { priorityIds: number[]; defaultPriorityId: number | null },
  ) => Promise<void>;
  updatePrioritySet: (id: number, change: PrioritySetChange) => Promise<void>;
  deletePrioritySet: (id: number) => Promise<void>;
  closeReasons: () => Promise<CloseReason[]>;
  createCloseReason: (body: NamedValue) => Promise<void>;
  updateCloseReason: (id: number, change: NamedValue) => Promise<void>;
  /** Every close reason's id, once each, in the new order. */
  orderCloseReasons: (ids: number[]) => Promise<void>;
  deleteCloseReason: (id: number, replacementId?: number) => Promise<void>;
}

const replacing = (replacementId?: number) =>
  replacementId === undefined ? '' : `?replacementId=${replacementId}`;

export const prioritiesClient: PrioritiesClient = {
  priorities: async () => (await api<{ priorities: Priority[] }>('/priorities')).priorities,
  createPriority: async (body) => {
    await api<unknown>('/priorities', { method: 'POST', body });
  },
  updatePriority: async (id, change) => {
    await api<unknown>(`/priorities/${id}`, { method: 'PATCH', body: change });
  },
  orderPriorities: async (ids) => {
    await api<unknown>('/priorities/order', { method: 'PUT', body: { priorityIds: ids } });
  },
  deletePriority: async (id, replacementId) => {
    await api<unknown>(`/priorities/${id}${replacing(replacementId)}`, { method: 'DELETE' });
  },
  prioritySets: async () =>
    (await api<{ prioritySets: PrioritySet[] }>('/priority-sets')).prioritySets,
  createPrioritySet: async (body) => {
    await api<unknown>('/priority-sets', { method: 'POST', body });
  },
  updatePrioritySet: async (id, change) => {
    await api<unknown>(`/priority-sets/${id}`, { method: 'PATCH', body: change });
  },
  deletePrioritySet: async (id) => {
    await api<unknown>(`/priority-sets/${id}`, { method: 'DELETE' });
  },
  closeReasons: async () =>
    (await api<{ closeReasons: CloseReason[] }>('/close-reasons')).closeReasons,
  createCloseReason: async (body) => {
    await api<unknown>('/close-reasons', { method: 'POST', body });
  },
  updateCloseReason: async (id, change) => {
    await api<unknown>(`/close-reasons/${id}`, { method: 'PATCH', body: change });
  },
  orderCloseReasons: async (ids) => {
    await api<unknown>('/close-reasons/order', { method: 'PUT', body: { closeReasonIds: ids } });
  },
  deleteCloseReason: async (id, replacementId) => {
    await api<unknown>(`/close-reasons/${id}${replacing(replacementId)}`, { method: 'DELETE' });
  },
};
