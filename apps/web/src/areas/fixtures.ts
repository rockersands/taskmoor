import { ApiError } from '../api/client';
import type { Area, AreaClient, AreaDeletion, AreaInput, AreaTrack, Named } from './client';

/** Areas of a made-up track for stories and tests: two in use, one archived. */
export const SHOP: AreaTrack = { id: 1, key: 'SHOP', name: 'Shop', archived: false };

const area = (id: number, name: string, more: Partial<Area> = {}): Area => ({
  id,
  trackId: SHOP.id,
  name,
  description: '',
  owner: null,
  ownerTeam: null,
  defaultAssignee: 'unassigned',
  archived: false,
  archivedAt: null,
  ...more,
});

export const CHECKOUT = area(31, 'Checkout', {
  description: 'Paying for an order, from the cart to the receipt',
  owner: { id: 21, name: 'Sam Rivera' },
  ownerTeam: { id: 5, name: 'Payments' },
  defaultAssignee: 'area_owner',
});
export const SEARCH = area(32, 'Search', { defaultAssignee: 'track_owner' });
export const LEGACY = area(33, 'Legacy app', {
  archived: true,
  archivedAt: '2026-10-01T09:00:00.000Z',
});
export const AREAS: Area[] = [CHECKOUT, SEARCH, LEGACY];

export const PEOPLE: Named[] = [
  { id: 21, name: 'Sam Rivera' },
  { id: 22, name: 'Ana Duarte' },
];
export const TEAMS: Named[] = [
  { id: 5, name: 'Payments' },
  { id: 6, name: 'Platform' },
];

export interface FakeAreaOptions {
  track?: AreaTrack;
  mayManage?: boolean;
  /** How many tickets each area holds, by its id; none when not named. */
  tickets?: Record<number, number>;
  /** The guardrail's limit of areas that are not archived; none by default. */
  limit?: number;
}

export type FakeAreaClient = AreaClient & {
  created: AreaInput[];
  updated: { id: number; input: AreaInput }[];
  archived: number[];
  restored: number[];
  removed: { id: number; deletion?: AreaDeletion }[];
};

/** A backend in memory that answers as the area routes do, recording each change. */
export function fakeAreaClient(
  areas: Area[] = AREAS,
  { track = SHOP, mayManage = true, tickets = { [CHECKOUT.id]: 3 }, limit }: FakeAreaOptions = {},
): FakeAreaClient {
  let held = areas.map((a) => ({ ...a }));
  let next = 100;
  const nameTaken = (name: string, except?: number) =>
    held.some((a) => a.id !== except && a.name.toLowerCase() === name.trim().toLowerCase());
  const find = (id: number) => {
    const found = held.find((a) => a.id === id);
    if (!found) throw new ApiError(404, { error: 'not_found' });
    return found;
  };
  const named = (list: Named[], id: number | null) => list.find((n) => n.id === id) ?? null;
  const refuse = () => {
    if (track.archived) throw new ApiError(409, { error: 'track_archived' });
    if (!mayManage) throw new ApiError(403, { error: 'forbidden' });
  };
  const client: FakeAreaClient = {
    created: [],
    updated: [],
    archived: [],
    restored: [],
    removed: [],
    track: async (key) => {
      if (key.toUpperCase() !== track.key) throw new ApiError(404, { error: 'not_found' });
      return track;
    },
    list: async () =>
      [...held].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    mayManage: async () => mayManage && !track.archived,
    create: async (_trackId, input) => {
      refuse();
      if (nameTaken(input.name)) throw new ApiError(409, { error: 'name_taken' });
      const active = held.filter((a) => !a.archived).length;
      if (limit !== undefined && active + 1 > limit) {
        throw new ApiError(409, {
          error: 'guardrail_exceeded',
          guardrail: 'areas_per_track',
          limit,
        });
      }
      client.created.push(input);
      const made = area(next++, input.name.trim(), {
        description: input.description,
        owner: named(PEOPLE, input.ownerId),
        ownerTeam: named(TEAMS, input.ownerTeamId),
        defaultAssignee: input.defaultAssignee,
      });
      held = [...held, made];
      return made;
    },
    update: async (areaId, input) => {
      refuse();
      const current = find(areaId);
      if (nameTaken(input.name, areaId)) throw new ApiError(409, { error: 'name_taken' });
      client.updated.push({ id: areaId, input });
      const changed: Area = {
        ...current,
        name: input.name.trim(),
        description: input.description,
        owner: input.ownerId === current.owner?.id ? current.owner : named(PEOPLE, input.ownerId),
        ownerTeam:
          input.ownerTeamId === current.ownerTeam?.id
            ? current.ownerTeam
            : named(TEAMS, input.ownerTeamId),
        defaultAssignee: input.defaultAssignee,
      };
      held = held.map((a) => (a.id === areaId ? changed : a));
      return changed;
    },
    archive: async (areaId) => {
      refuse();
      const current = find(areaId);
      if (current.archived) throw new ApiError(409, { error: 'already_archived' });
      client.archived.push(areaId);
      const changed = { ...current, archived: true, archivedAt: '2026-11-16T10:00:00.000Z' };
      held = held.map((a) => (a.id === areaId ? changed : a));
      return changed;
    },
    restore: async (areaId) => {
      refuse();
      const current = find(areaId);
      if (!current.archived) throw new ApiError(409, { error: 'not_archived' });
      client.restored.push(areaId);
      const changed = { ...current, archived: false, archivedAt: null };
      held = held.map((a) => (a.id === areaId ? changed : a));
      return changed;
    },
    remove: async (areaId, deletion) => {
      refuse();
      find(areaId);
      const count = tickets[areaId] ?? 0;
      if (count > 0 && !deletion) {
        throw new ApiError(409, { error: 'in_use', ticketCount: count });
      }
      if (deletion && 'replacementId' in deletion) {
        const to = held.find((a) => a.id === deletion.replacementId);
        if (!to || to.archived || to.id === areaId) {
          throw new ApiError(400, { error: 'invalid_request', detail: 'replacementId' });
        }
      }
      client.removed.push(deletion ? { id: areaId, deletion } : { id: areaId });
      held = held.filter((a) => a.id !== areaId);
    },
    people: async (_trackKey, typed) =>
      PEOPLE.filter((p) => p.name.toLowerCase().includes(typed.toLowerCase())),
    teams: async (typed) => TEAMS.filter((p) => p.name.toLowerCase().includes(typed.toLowerCase())),
  };
  return client;
}
