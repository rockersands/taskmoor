import { api } from '../api/client';
import type { SessionUser } from '../session/SessionProvider';

/** A track the signed-in person runs (IAM-030). */
export interface ManagedTrack {
  id: number;
  key: string;
  name: string;
  mode: 'shared' | 'local';
}

export interface Named {
  id: number;
  name: string;
}

export interface TrackRole extends Named {
  description: string;
  /** The track's access policy lets this role run the track (IAM-028). */
  runsTrack: boolean;
  /** The person may give and take this role here. */
  givable: boolean;
}

export interface RoleHolders {
  roleId: number;
  roleName: string;
  users: Named[];
  groups: Named[];
}

export type Delivery = 'email' | 'link';

export interface Invitation {
  id: number;
  email: string;
  role: Named;
  invitedBy: string | null;
  delivery: Delivery;
  sendFailed: boolean;
  lastSentAt: string;
  expiresAt: string;
  /** `lapsed`: it ran out, or the person who sent it may no longer invite. */
  state: 'open' | 'lapsed';
  external: boolean;
}

export interface InvitationsView {
  invitations: Invitation[];
  canInvite: boolean;
  /** Somebody may invite here besides site administrators. */
  invitingGiven: boolean;
  emailAvailable: boolean;
}

export interface InviteResult {
  email?: string;
  userId?: number;
  name?: string;
  status: 'invited' | 'already_invited' | 'invalid' | 'too_many' | 'added' | 'already_holds';
  link?: string;
  external?: boolean;
  sendFailed?: boolean;
}

export interface NewInvitations {
  addresses: string[];
  userIds: number[];
  roleId: number;
  delivery: Delivery;
  /** With a role that runs the track: also the permission to create tracks (IAM-033). */
  createTracks?: boolean;
}

/** How a role is given: with a role that runs the track, also the permission to create tracks. */
export interface RoleOptions {
  createTracks?: boolean;
}

/** The endpoints a track's Manage page uses. Stories and tests pass their own. */
export interface TrackPeopleClient {
  managedTracks: () => Promise<ManagedTrack[]>;
  track: (id: number) => Promise<ManagedTrack>;
  roles: (trackId: number) => Promise<TrackRole[]>;
  roleHolders: (trackId: number) => Promise<RoleHolders[]>;
  setRole: (
    trackId: number,
    roleId: number,
    kind: 'users' | 'groups',
    actorId: number,
    on: boolean,
    options?: RoleOptions,
  ) => Promise<void>;
  findPeople: (trackKey: string, query: string) => Promise<Named[]>;
  invitations: (trackId: number) => Promise<InvitationsView>;
  invite: (trackId: number, body: NewInvitations) => Promise<InviteResult[]>;
  resend: (trackId: number, id: number, delivery: Delivery) => Promise<{ link?: string }>;
  revoke: (trackId: number, id: number) => Promise<void>;
}

export const trackPeopleClient: TrackPeopleClient = {
  managedTracks: async () => (await api<{ tracks: ManagedTrack[] }>('/me/managed-tracks')).tracks,
  track: async (id) => (await api<{ track: ManagedTrack }>(`/tracks/${id}`)).track,
  roles: async (trackId) => (await api<{ roles: TrackRole[] }>(`/tracks/${trackId}/roles`)).roles,
  roleHolders: async (trackId) =>
    (await api<{ roles: RoleHolders[] }>(`/tracks/${trackId}/role-actors`)).roles,
  setRole: async (trackId, roleId, kind, actorId, on, options) => {
    await api<unknown>(`/tracks/${trackId}/roles/${roleId}/${kind}/${actorId}`, {
      method: on ? 'PUT' : 'DELETE',
      ...(on && options?.createTracks ? { body: { createTracks: true } } : {}),
    });
  },
  findPeople: async (trackKey, query) =>
    (
      await api<{ people: Named[] }>(
        `/people/mentionable?track=${encodeURIComponent(trackKey)}&limit=8&q=${encodeURIComponent(query)}`,
      )
    ).people,
  invitations: (trackId) => api<InvitationsView>(`/tracks/${trackId}/invitations`),
  invite: async (trackId, body) =>
    (
      await api<{ results: InviteResult[] }>(`/tracks/${trackId}/invitations`, {
        method: 'POST',
        body,
      })
    ).results,
  resend: (trackId, id, delivery) =>
    api<{ link?: string }>(`/tracks/${trackId}/invitations/${id}/resend`, {
      method: 'POST',
      body: { delivery },
    }),
  revoke: async (trackId, id) => {
    await api<unknown>(`/tracks/${trackId}/invitations/${id}`, { method: 'DELETE' });
  },
};

/** What a link is for, from POST /api/v1/invitations/inspect. */
export interface InvitationLink {
  email: string;
  track: { key: string; name: string };
  roleName: string;
  invitedBy: string | null;
  expiresAt: string;
  secondFactorRequired: boolean;
}

/** The invited person's endpoints; the token always travels in a POST body. */
export interface InvitationClient {
  inspect: (token: string) => Promise<InvitationLink>;
  redeem: (token: string, name: string, password: string) => Promise<void>;
  accept: (token: string) => Promise<{ track: { key: string } }>;
}

export const invitationClient: InvitationClient = {
  inspect: (token) =>
    api<InvitationLink>('/invitations/inspect', { method: 'POST', body: { token } }),
  redeem: async (token, name, password) => {
    await api<unknown>('/invitations/redeem', {
      method: 'POST',
      body: { token, name, password },
    });
  },
  accept: (token) =>
    api<{ track: { key: string } }>('/invitations/accept', { method: 'POST', body: { token } }),
};

export type { SessionUser };

/** One address per entry from a pasted list: commas, semicolons, spaces, lines, or `Name <a@b>`. */
export function parseAddresses(text: string): string[] {
  const found: string[] = [];
  for (const part of text.split(/[,;\s]+/)) {
    const address = part.replace(/^[<("']+|[>)"']+$/g, '').trim();
    // A word without @ is a name in "Name <a@b.example>": the address is the next part.
    if (address.includes('@')) found.push(address);
    else if (address && !text.includes('<')) found.push(address);
  }
  return [...new Set(found)];
}
