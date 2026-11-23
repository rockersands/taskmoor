import { ApiError } from '../api/client';
import type { CloseReason, PrioritiesClient, Priority, PrioritySet } from './client';

export interface FakePrioritiesClient extends PrioritiesClient {
  calls: { action: string; args: unknown[] }[];
}

/** The server's icon level: the list stretched over levels 1 to 6 (`tickets/priority-level.ts`). */
function levelOf(order: number, total: number): number {
  if (total <= 1) return 4;
  return 1 + Math.round(((order - 1) * 5) / (total - 1));
}

const taken = (list: readonly { id: number; name: string }[], name: string, id?: number) =>
  list.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase());

/**
 * An in-memory backend for stories and tests that answers as the API would (CORE-014). High is
 * on four tickets and Not planned on two, so deleting either asks for a replacement; Support flow
 * sets Duplicate, so deleting it names the workflow first. The default set offers every priority;
 * Support offers three, with High for new tickets.
 */
export function fakePrioritiesClient(): FakePrioritiesClient {
  let priorities: Omit<Priority, 'order' | 'level'>[] = [
    { id: 1, name: 'Urgent', description: 'Drop everything.', icon: null, color: null },
    { id: 2, name: 'High', description: '', icon: null, color: null },
    { id: 3, name: 'Normal', description: '', icon: null, color: null },
    { id: 4, name: 'Low', description: '', icon: null, color: null },
    { id: 5, name: 'Very low', description: '', icon: null, color: null },
  ];
  let sets: Omit<PrioritySet, 'trackCount'>[] = [
    {
      id: 1,
      name: 'Default priority set',
      description: '',
      isDefault: true,
      priorityIds: [1, 2, 3, 4, 5],
      defaultPriorityId: 3,
    },
    {
      id: 2,
      name: 'Support',
      description: 'For the help desk tracks.',
      isDefault: false,
      priorityIds: [1, 2, 3],
      defaultPriorityId: 2,
    },
  ];
  /** Tracks that chose each set; those that chose none use the default set. */
  const chosenBy = new Map<number, number>([
    [1, 1],
    [2, 1],
  ]);
  let choosingNone = 2;
  let reasons: Omit<CloseReason, 'order'>[] = [
    { id: 1, name: 'Completed', description: '' },
    { id: 2, name: 'Not planned', description: '' },
    { id: 3, name: 'Duplicate', description: 'Another ticket covers it.' },
    { id: 4, name: 'Not reproducible', description: '' },
  ];
  const ticketsOf = new Map<string, number>([
    ['priority:2', 4],
    ['reason:2', 2],
  ]);
  const workflowsSetting = new Map<number, { id: number; name: string }[]>([
    [3, [{ id: 7, name: 'Support flow' }]],
  ]);
  let next = 100;
  const calls: FakePrioritiesClient['calls'] = [];
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  const sameIds = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every((x) => b.includes(x)) && new Set(a).size === a.length;
  const inOrder = (ids: readonly number[]) =>
    priorities.map((p) => p.id).filter((id) => ids.includes(id));

  return {
    calls,
    priorities: async () =>
      structuredClone(priorities).map((p, i) => ({
        ...p,
        order: i + 1,
        level: levelOf(i + 1, priorities.length),
      })),
    createPriority: async (body) => {
      log('createPriority', body);
      if (taken(priorities, body.name)) throw new ApiError(409, { error: 'name_taken' });
      const id = ++next;
      priorities.push({
        id,
        name: body.name,
        description: body.description ?? '',
        icon: null,
        color: null,
      });
      // A new priority joins the default set.
      for (const set of sets) if (set.isDefault) set.priorityIds.push(id);
    },
    updatePriority: async (id, change) => {
      log('updatePriority', id, change);
      if (change.name !== undefined && taken(priorities, change.name, id)) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      priorities = priorities.map((p) => (p.id === id ? { ...p, ...change } : p));
    },
    orderPriorities: async (ids) => {
      log('orderPriorities', ids);
      if (
        !sameIds(
          ids,
          priorities.map((p) => p.id),
        )
      ) {
        throw new ApiError(400, {
          error: 'invalid_request',
          detail: 'priorityIds must list every priority once',
        });
      }
      priorities = ids.map((id) => priorities.find((p) => p.id === id) as (typeof priorities)[0]);
      for (const set of sets) set.priorityIds = inOrder(set.priorityIds);
    },
    deletePriority: async (id, replacementId) => {
      log('deletePriority', id, replacementId);
      const tickets = ticketsOf.get(`priority:${id}`) ?? 0;
      if (tickets > 0 && replacementId === undefined) {
        throw new ApiError(409, { error: 'in_use', ticketCount: tickets });
      }
      if (replacementId !== undefined) {
        ticketsOf.set(
          `priority:${replacementId}`,
          (ticketsOf.get(`priority:${replacementId}`) ?? 0) + tickets,
        );
      }
      ticketsOf.delete(`priority:${id}`);
      priorities = priorities.filter((p) => p.id !== id);
      sets = sets.map((set) => {
        const offered = set.priorityIds.includes(id);
        const ids = set.priorityIds.filter((p) => p !== id);
        if (offered && replacementId !== undefined && !ids.includes(replacementId)) {
          ids.push(replacementId);
        }
        return {
          ...set,
          priorityIds: inOrder(ids),
          defaultPriorityId:
            set.defaultPriorityId === id ? (replacementId ?? null) : set.defaultPriorityId,
        };
      });
    },
    prioritySets: async () =>
      structuredClone(sets).map((s) => ({
        ...s,
        trackCount: (chosenBy.get(s.id) ?? 0) + (s.isDefault ? choosingNone : 0),
      })),
    createPrioritySet: async (body) => {
      log('createPrioritySet', body);
      if (taken(sets, body.name)) throw new ApiError(409, { error: 'name_taken' });
      if (body.defaultPriorityId !== null && !body.priorityIds.includes(body.defaultPriorityId)) {
        throw new ApiError(400, { error: 'invalid_request' });
      }
      sets.push({
        id: ++next,
        name: body.name,
        description: body.description ?? '',
        isDefault: false,
        priorityIds: inOrder(body.priorityIds),
        defaultPriorityId: body.defaultPriorityId,
      });
    },
    updatePrioritySet: async (id, change) => {
      log('updatePrioritySet', id, change);
      if (change.name !== undefined && taken(sets, change.name, id)) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      const was = sets.find((s) => s.id === id);
      if (!was) throw new ApiError(404, { error: 'not_found' });
      const priorityIds = change.priorityIds ? inOrder(change.priorityIds) : was.priorityIds;
      const defaultPriorityId =
        change.defaultPriorityId !== undefined
          ? change.defaultPriorityId
          : was.defaultPriorityId !== null && priorityIds.includes(was.defaultPriorityId)
            ? was.defaultPriorityId
            : null;
      if (defaultPriorityId !== null && !priorityIds.includes(defaultPriorityId)) {
        throw new ApiError(400, { error: 'invalid_request' });
      }
      sets = sets.map((s) => {
        if (s.id === id) {
          return {
            ...s,
            ...(change.name !== undefined ? { name: change.name } : {}),
            ...(change.description !== undefined ? { description: change.description } : {}),
            priorityIds,
            defaultPriorityId,
            ...(change.isDefault ? { isDefault: true } : {}),
          };
        }
        // Tracks that chose no set follow the default to its new place.
        return change.isDefault && s.isDefault ? { ...s, isDefault: false } : s;
      });
    },
    deletePrioritySet: async (id) => {
      log('deletePrioritySet', id);
      const set = sets.find((s) => s.id === id);
      if (!set) throw new ApiError(404, { error: 'not_found' });
      if (set.isDefault) throw new ApiError(409, { error: 'default_set' });
      // Its tracks go back to the default set.
      choosingNone += chosenBy.get(id) ?? 0;
      chosenBy.delete(id);
      sets = sets.filter((s) => s.id !== id);
    },
    closeReasons: async () => structuredClone(reasons).map((r, i) => ({ ...r, order: i + 1 })),
    createCloseReason: async (body) => {
      log('createCloseReason', body);
      if (taken(reasons, body.name)) throw new ApiError(409, { error: 'name_taken' });
      reasons.push({ id: ++next, name: body.name, description: body.description ?? '' });
    },
    updateCloseReason: async (id, change) => {
      log('updateCloseReason', id, change);
      if (change.name !== undefined && taken(reasons, change.name, id)) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      reasons = reasons.map((r) => (r.id === id ? { ...r, ...change } : r));
    },
    orderCloseReasons: async (ids) => {
      log('orderCloseReasons', ids);
      if (
        !sameIds(
          ids,
          reasons.map((r) => r.id),
        )
      ) {
        throw new ApiError(400, {
          error: 'invalid_request',
          detail: 'closeReasonIds must list every close reason once',
        });
      }
      reasons = ids.map((id) => reasons.find((r) => r.id === id) as (typeof reasons)[0]);
    },
    deleteCloseReason: async (id, replacementId) => {
      log('deleteCloseReason', id, replacementId);
      const tickets = ticketsOf.get(`reason:${id}`) ?? 0;
      if (tickets > 0 && replacementId === undefined) {
        throw new ApiError(409, { error: 'in_use', ticketCount: tickets });
      }
      const workflows = workflowsSetting.get(id) ?? [];
      if (workflows.length > 0 && replacementId === undefined) {
        throw new ApiError(409, { error: 'used_by_workflow', workflows });
      }
      if (replacementId !== undefined) {
        workflowsSetting.set(replacementId, [
          ...(workflowsSetting.get(replacementId) ?? []),
          ...workflows,
        ]);
      }
      workflowsSetting.delete(id);
      ticketsOf.delete(`reason:${id}`);
      reasons = reasons.filter((r) => r.id !== id);
    },
  };
}
