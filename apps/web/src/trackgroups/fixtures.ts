import type { TrackListItem } from '../tracks/client';
import type {
  GroupShare,
  GroupSharing,
  GroupTrack,
  Named,
  ShareOutcome,
  TrackGroup,
  TrackGroupClient,
} from './client';

/** Tracks for the stories and tests of the Tracks page's groups. */
export const GROUP_TRACKS: TrackListItem[] = [
  { id: 1, key: 'SHOP', name: 'Shop', owner: { id: 1, name: 'Ada Lovelace' } },
  { id: 2, key: 'WEB', name: 'Web', owner: null },
  { id: 3, key: 'PAY', name: 'Payments', owner: { id: 2, name: 'Grace Hopper' } },
  { id: 4, key: 'OPS', name: 'Operations', owner: null },
  { id: 5, key: 'HR', name: 'People team', owner: null },
  { id: 6, key: 'DATA', name: 'Data', owner: null },
];

const ME: Named = { id: 1, name: 'Ada Lovelace' };
const track = (id: number): GroupTrack => {
  const found = GROUP_TRACKS.find((t) => t.id === id) as TrackListItem;
  return { id: found.id, key: found.key, name: found.name };
};

/** The person's own group, open, of these tracks. */
export const ownGroup = (
  id: number,
  name: string,
  trackIds: number[],
  over: Partial<TrackGroup> = {},
) =>
  ({
    id,
    name,
    minimized: false,
    mine: true,
    owner: ME,
    sharedWith: 0,
    givenBy: null,
    tracks: trackIds.map(track),
    ...over,
  }) satisfies TrackGroup;

/** A group someone shared with the person. */
export const sharedGroup = (
  id: number,
  name: string,
  trackIds: number[],
  over: Partial<TrackGroup> = {},
) =>
  ({
    id,
    name,
    minimized: false,
    mine: false,
    owner: { id: 7, name: 'Grace Hopper' },
    role: { id: 2, name: 'Members' },
    holds: trackIds.length,
    tracks: trackIds.map(track),
    ...over,
  }) satisfies TrackGroup;

export const PEOPLE: Named[] = [
  { id: 7, name: 'Grace Hopper' },
  { id: 8, name: 'Alan Turing' },
  { id: 9, name: 'Ana Pérez' },
];

export const SHARING: GroupSharing = {
  trackCount: 2,
  roles: [
    { id: 1, name: 'Administrators', givableOn: 1 },
    { id: 2, name: 'Members', givableOn: 2 },
  ],
  shares: [
    { userId: 7, name: 'Grace Hopper', active: true, role: { id: 2, name: 'Members' }, holds: 2 },
    { userId: 10, name: 'Former colleague', active: false, role: null, holds: 0 },
  ],
};

export interface FakeTrackGroupOptions {
  groups?: TrackGroup[];
  sharing?: GroupSharing;
  /** An error the next change answers with, then none. */
  failNext?: unknown;
  /** Whether the first read of the arrangement fails. */
  layoutFails?: boolean;
  outcome?: ShareOutcome;
}

export type FakeTrackGroupClient = TrackGroupClient & {
  calls: { method: string; args: unknown[] }[];
  current: () => TrackGroup[];
};

/**
 * A client that keeps the arrangement in memory as the server would: a track sits in one of the
 * person's groups, and a change answers the whole arrangement.
 */
export function fakeTrackGroupClient(options: FakeTrackGroupOptions = {}): FakeTrackGroupClient {
  let groups: TrackGroup[] = structuredClone(options.groups ?? []);
  let failNext = options.failNext;
  const sharing: GroupSharing = structuredClone(options.sharing ?? SHARING);
  let nextId = 100;
  const calls: { method: string; args: unknown[] }[] = [];
  const answer = async (method: string, args: unknown[], change: () => void) => {
    calls.push({ method, args });
    if (failNext !== undefined) {
      const error = failNext;
      failNext = undefined;
      throw error;
    }
    change();
    return structuredClone(groups);
  };
  const takeOutOfMine = (trackId: number) => {
    for (const g of groups) if (g.mine) g.tracks = g.tracks.filter((t) => t.id !== trackId);
  };
  const outcome = options.outcome ?? { tracks: 2, given: 2, alreadyHeld: 0, notGivable: 0 };
  return {
    calls,
    current: () => structuredClone(groups),
    layout: async () => {
      calls.push({ method: 'layout', args: [] });
      if (options.layoutFails) throw new Error('offline');
      return structuredClone(groups);
    },
    create: (name, trackIds) =>
      answer('create', [name, trackIds], () => {
        for (const id of trackIds) takeOutOfMine(id);
        groups.push(ownGroup(nextId++, name, [...trackIds]));
      }),
    update: (groupId, change) =>
      answer('update', [groupId, change], () => {
        groups = groups.map((g) => (g.id === groupId ? { ...g, ...change } : g));
      }),
    remove: (groupId) =>
      answer('remove', [groupId], () => {
        groups = groups.filter((g) => g.id !== groupId);
      }),
    order: (groupIds) =>
      answer('order', [groupIds], () => {
        groups = groupIds.map((id) => groups.find((g) => g.id === id) as TrackGroup);
      }),
    place: (groupId, trackId, position) =>
      answer('place', [groupId, trackId, position], () => {
        takeOutOfMine(trackId);
        const group = groups.find((g) => g.id === groupId) as TrackGroup;
        group.tracks.splice(position ?? group.tracks.length, 0, track(trackId));
      }),
    takeOut: (groupId, trackId) =>
      answer('takeOut', [groupId, trackId], () => takeOutOfMine(trackId)),
    sharing: async (groupId) => {
      calls.push({ method: 'sharing', args: [groupId] });
      return structuredClone(sharing);
    },
    share: async (groupId, userId, roleId) => {
      await answer('share', [groupId, userId, roleId], () => {
        const person = PEOPLE.find((p) => p.id === userId) as Named;
        const role = sharing.roles.find((r) => r.id === roleId) ?? null;
        const share: GroupShare = {
          userId,
          name: person.name,
          active: true,
          role: role && { id: role.id, name: role.name },
          holds: role ? outcome.given : 0,
        };
        sharing.shares.push(share);
      });
      return outcome;
    },
    unshare: async (groupId, userId) => {
      await answer('unshare', [groupId, userId], () => {
        sharing.shares = sharing.shares.filter((s) => s.userId !== userId);
      });
    },
    leave: (groupId) =>
      answer('leave', [groupId], () => {
        groups = groups.filter((g) => g.id !== groupId);
      }),
    setOn: async (groupId, userId, roleId) => {
      await answer('setOn', [groupId, userId, roleId], () => {});
      return outcome;
    },
    findPeople: async (query) => {
      calls.push({ method: 'findPeople', args: [query] });
      const words = query.trim().toLocaleLowerCase();
      return PEOPLE.filter((p) => p.name.toLocaleLowerCase().includes(words));
    },
  };
}
