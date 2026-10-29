import { api } from '../api/client';

/** A person as `GET /api/v1/users` shows them (IAM-008). */
export interface User {
  id: number;
  email: string;
  name: string;
  isSiteAdmin: boolean;
  active: boolean;
  hasPassword: boolean;
  createdAt: string;
  deactivatedAt: string | null;
  lastSignInAt: string | null;
}

export type UserStatus = 'active' | 'deactivated' | 'all';

export interface GroupSummary {
  id: number;
  name: string;
  description: string;
  memberCount: number;
  childCount: number;
}

export interface GroupDetail {
  group: { id: number; name: string; description: string };
  members: User[];
  children: { id: number; name: string }[];
  parents: { id: number; name: string }[];
}

/** The endpoints the people pages use. Stories and tests pass their own. */
export interface PeopleClient {
  users: (query: string, status: UserStatus) => Promise<{ users: User[]; total: number }>;
  createUser: (body: {
    name: string;
    email: string;
    isSiteAdmin: boolean;
  }) => Promise<{ user: User; activationLink: string | null }>;
  updateUser: (id: number, change: { isSiteAdmin?: boolean; name?: string }) => Promise<User>;
  deactivate: (id: number) => Promise<User>;
  reactivate: (id: number) => Promise<User>;
  passwordLink: (id: number) => Promise<string>;
  groups: (query: string) => Promise<GroupSummary[]>;
  group: (id: number) => Promise<GroupDetail>;
  createGroup: (body: { name: string; description: string }) => Promise<{ id: number }>;
  renameGroup: (id: number, change: { name?: string; description?: string }) => Promise<void>;
  deleteGroup: (id: number) => Promise<void>;
  addMember: (id: number, userId: number) => Promise<void>;
  removeMember: (id: number, userId: number) => Promise<void>;
  addChild: (id: number, childId: number) => Promise<void>;
  removeChild: (id: number, childId: number) => Promise<void>;
}

export const peopleClient: PeopleClient = {
  users: (query, status) =>
    api<{ users: User[]; total: number }>(
      `/users?status=${status}&limit=200${query ? `&query=${encodeURIComponent(query)}` : ''}`,
    ),
  createUser: async (body) => {
    const made = await api<{ user: User; activationLink?: string | null }>('/users', {
      method: 'POST',
      body,
    });
    return { user: made.user, activationLink: made.activationLink ?? null };
  },
  updateUser: async (id, change) =>
    (await api<{ user: User }>(`/users/${id}`, { method: 'PATCH', body: change })).user,
  deactivate: async (id) =>
    (await api<{ user: User }>(`/users/${id}/deactivate`, { method: 'POST' })).user,
  reactivate: async (id) =>
    (await api<{ user: User }>(`/users/${id}/reactivate`, { method: 'POST' })).user,
  passwordLink: async (id) =>
    (await api<{ link: string }>(`/users/${id}/password-link`, { method: 'POST' })).link,
  groups: async (query) =>
    (
      await api<{ groups: GroupSummary[] }>(
        `/groups${query ? `?query=${encodeURIComponent(query)}` : ''}`,
      )
    ).groups,
  group: (id) => api<GroupDetail>(`/groups/${id}`),
  createGroup: async (body) =>
    (await api<{ group: { id: number } }>('/groups', { method: 'POST', body })).group,
  renameGroup: async (id, change) => {
    await api<unknown>(`/groups/${id}`, { method: 'PATCH', body: change });
  },
  deleteGroup: async (id) => {
    await api<unknown>(`/groups/${id}`, { method: 'DELETE' });
  },
  addMember: async (id, userId) => {
    await api<unknown>(`/groups/${id}/members/${userId}`, { method: 'PUT' });
  },
  removeMember: async (id, userId) => {
    await api<unknown>(`/groups/${id}/members/${userId}`, { method: 'DELETE' });
  },
  addChild: async (id, childId) => {
    await api<unknown>(`/groups/${id}/children/${childId}`, { method: 'PUT' });
  },
  removeChild: async (id, childId) => {
    await api<unknown>(`/groups/${id}/children/${childId}`, { method: 'DELETE' });
  },
};
