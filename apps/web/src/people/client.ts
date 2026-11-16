import { type PersonalDataClient, personDataClient } from '../account/personalData';
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
  /** Erased (ASVS 8.3.2, ADR-111): the account is a placeholder now. */
  erased?: true;
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
  /** People and service accounts (IAM-007): `kind` says which (T-320). */
  members: (User & { kind?: 'person' | 'service' })[];
  children: { id: number; name: string }[];
  parents: { id: number; name: string }[];
  /** The directory that keeps the group (M1-082), which owns its name; null for the site's own. */
  directory?: { id: number; name: string } | null;
}

/** An active service account, as a group's panel offers it (IAM-007; T-320). */
export interface ServiceAccountChoice {
  id: number;
  name: string;
  email: string;
}

/** People the People page asks for at a time; Show more reads the next page (T-307). */
export const USERS_PAGE = 200;

/** The endpoints the people pages use. Stories and tests pass their own. */
export interface PeopleClient {
  /**
   * One page of people, from `offset` (0, the first, when left out), and how many match in all
   * (`total`): the People page shows the rest a page at a time (T-307).
   */
  users: (
    query: string,
    status: UserStatus,
    offset?: number,
  ) => Promise<{ users: User[]; total: number }>;
  createUser: (body: {
    name: string;
    email: string;
    isSiteAdmin: boolean;
  }) => Promise<{ user: User; activationLink: string | null }>;
  updateUser: (id: number, change: { isSiteAdmin?: boolean; name?: string }) => Promise<User>;
  deactivate: (id: number) => Promise<User>;
  reactivate: (id: number) => Promise<User>;
  passwordLink: (id: number) => Promise<string>;
  /** Erases the person (ADR-111); `confirmEmail` is their email as typed. Resolves to the placeholder. */
  erase: (id: number, confirmEmail: string) => Promise<{ label: string }>;
  /** The person's data downloads, for the Data panel. */
  personalData: (user: User) => PersonalDataClient;
  groups: (query: string) => Promise<GroupSummary[]>;
  group: (id: number) => Promise<GroupDetail>;
  createGroup: (body: { name: string; description: string }) => Promise<{ id: number }>;
  renameGroup: (id: number, change: { name?: string; description?: string }) => Promise<void>;
  deleteGroup: (id: number) => Promise<void>;
  addMember: (id: number, userId: number) => Promise<void>;
  removeMember: (id: number, userId: number) => Promise<void>;
  addChild: (id: number, childId: number) => Promise<void>;
  removeChild: (id: number, childId: number) => Promise<void>;
  /** Active service accounts, which the people list leaves out (T-320). */
  serviceAccounts: () => Promise<ServiceAccountChoice[]>;
}

export const peopleClient: PeopleClient = {
  users: (query, status, offset = 0) =>
    api<{ users: User[]; total: number }>(
      `/users?status=${status}&limit=${USERS_PAGE}${offset ? `&offset=${offset}` : ''}${
        query ? `&query=${encodeURIComponent(query)}` : ''
      }`,
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
  erase: async (id, confirmEmail) =>
    (
      await api<{ erased: { label: string } }>(`/users/${id}/erase`, {
        method: 'POST',
        body: { confirmEmail },
      })
    ).erased,
  personalData: (user) => personDataClient(user.id, user.name),
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
  serviceAccounts: async () =>
    (
      await api<{ serviceAccounts: ServiceAccountChoice[] }>('/service-accounts?status=active')
    ).serviceAccounts.map((a) => ({ id: a.id, name: a.name, email: a.email })),
};
