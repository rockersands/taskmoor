import { api } from '../api/client';

/** A track as a group shows it. */
export interface GroupTrack {
  id: number;
  key: string;
  name: string;
}

export interface Named {
  id: number;
  name: string;
}

/**
 * One group on the person's Tracks page (CORE-034): their own, or one shared with them, in
 * their order. Its tracks are those the person may see.
 */
export interface TrackGroup {
  id: number;
  name: string;
  minimized: boolean;
  /** The person's own group; otherwise one shared with them. */
  mine: boolean;
  owner: Named;
  /** Shared with the person: the role it gave them, or null. */
  role?: Named | null;
  /**
   * Shared with the person: on how many tracks the role is theirs through this share alone,
   * which leaving takes away (T-204). Older servers leave it out.
   */
  holds?: number;
  /** The person's own: how many people it is shared with. */
  sharedWith?: number;
  /** A copy someone set on the person. */
  givenBy?: Named | null;
  tracks: GroupTrack[];
}

/** Someone a group is shared with (IAM-034). */
export interface GroupShare {
  userId: number;
  name: string;
  active: boolean;
  role: Named | null;
  /** On how many tracks the share holds the role. */
  holds: number;
}

/** Who has the group, and the roles its owner may give on how many of its tracks. */
export interface GroupSharing {
  trackCount: number;
  roles: (Named & { givableOn: number })[];
  shares: GroupShare[];
}

/** What sharing or setting a group gave. */
export interface ShareOutcome {
  tracks: number;
  given: number;
  alreadyHeld: number;
  notGivable: number;
}

/** The endpoints of the Tracks page's groups. Stories and tests pass their own. */
export interface TrackGroupClient {
  layout(): Promise<TrackGroup[]>;
  create(name: string, trackIds: readonly number[]): Promise<TrackGroup[]>;
  update(groupId: number, change: { name?: string; minimized?: boolean }): Promise<TrackGroup[]>;
  remove(groupId: number): Promise<TrackGroup[]>;
  /** Every group of the person's, in the new order. */
  order(groupIds: readonly number[]): Promise<TrackGroup[]>;
  /** A track into a group, at a place among its tracks (the end when left out). */
  place(groupId: number, trackId: number, position?: number): Promise<TrackGroup[]>;
  takeOut(groupId: number, trackId: number): Promise<TrackGroup[]>;
  sharing(groupId: number): Promise<GroupSharing>;
  share(groupId: number, userId: number, roleId: number | null): Promise<ShareOutcome>;
  unshare(groupId: number, userId: number): Promise<void>;
  /** Leaves a group shared with the person, and what it gave them (T-204). */
  leave(groupId: number): Promise<TrackGroup[]>;
  /** A copy of the group of the person's own (ADR-121). */
  setOn(groupId: number, userId: number, roleId: number | null): Promise<ShareOutcome>;
  findPeople(query: string): Promise<Named[]>;
}

type Layout = { groups: TrackGroup[] };
const groups = async (answer: Promise<Layout>) => (await answer).groups;
const path = (groupId: number) => `/track-groups/${groupId}`;

export const trackGroupClient: TrackGroupClient = {
  layout: () => groups(api<Layout>('/track-groups')),
  create: (name, trackIds) =>
    groups(api<Layout>('/track-groups', { method: 'POST', body: { name, trackIds } })),
  update: (groupId, change) =>
    groups(api<Layout>(path(groupId), { method: 'PATCH', body: change })),
  remove: (groupId) => groups(api<Layout>(path(groupId), { method: 'DELETE' })),
  order: (groupIds) =>
    groups(api<Layout>('/track-groups/order', { method: 'PUT', body: { groupIds } })),
  place: (groupId, trackId, position) =>
    groups(
      api<Layout>(`${path(groupId)}/tracks/${trackId}`, {
        method: 'PUT',
        body: position === undefined ? {} : { position },
      }),
    ),
  takeOut: (groupId, trackId) =>
    groups(api<Layout>(`${path(groupId)}/tracks/${trackId}`, { method: 'DELETE' })),
  sharing: (groupId) => api<GroupSharing>(`${path(groupId)}/shares`),
  share: (groupId, userId, roleId) =>
    api<ShareOutcome>(`${path(groupId)}/shares`, { method: 'POST', body: { userId, roleId } }),
  unshare: async (groupId, userId) => {
    await api<unknown>(`${path(groupId)}/shares/${userId}`, { method: 'DELETE' });
  },
  leave: (groupId) => groups(api<Layout>(`${path(groupId)}/leave`, { method: 'POST' })),
  setOn: (groupId, userId, roleId) =>
    api<ShareOutcome>(`${path(groupId)}/copies`, { method: 'POST', body: { userId, roleId } }),
  findPeople: async (query) =>
    (await api<{ people: Named[] }>(`/track-groups/people?q=${encodeURIComponent(query)}`)).people,
};
