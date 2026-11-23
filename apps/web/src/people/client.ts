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
  /** May sign in with a password while single sign-on is enforced (IAM-001); T-331. */
  breakGlass?: boolean;
  /** The person's own time zone and language; null follows their device (IAM-008). */
  timeZone?: string | null;
  locale?: string | null;
  /** The administrator roles they hold, in this order (T-331; IAM-009). */
  roles?: AdminRole[];
  /** How many tracks they run (T-331; IAM-028). */
  tracksRun?: number;
}

export type UserStatus = 'active' | 'deactivated' | 'all';

/** The administrator roles, as the server names them, in the order the page shows them (T-331). */
export const ADMIN_ROLES = [
  'site_admin',
  'configuration_admin',
  'automation_admin',
  'ai_admin',
  'extension_admin',
] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** The People page's role filter: a role, running tracks, none of these, or anyone (`any`). */
export const ROLE_FILTERS = [...ADMIN_ROLES, 'runs_tracks', 'member'] as const;
export type RoleFilter = (typeof ROLE_FILTERS)[number] | 'any';

/** Where a role comes from (T-331): the account's own flag, a grant to them, a group, everyone. */
export type RoleSource =
  | { kind: 'account' }
  | { kind: 'user' }
  | { kind: 'group'; group: { id: number; name: string } }
  | { kind: 'everyone' };

/** A person as their page under Administration shows them (`GET /api/v1/users/:id`; T-331). */
export interface PersonDetail {
  user: User;
  roles: { role: AdminRole; sources: RoleSource[] }[];
  /** The tracks they run, by key: the first 100; `user.tracksRun` says how many in all. */
  tracks: { id: number; key: string; name: string }[];
  hasSecondFactor: boolean;
  /** The groups they are in themselves. */
  groups: { id: number; name: string }[];
  /** The directory that keeps the account (M1-082), if one does. */
  directory: { id: number; name: string; mode: string } | null;
}

/** What a person's page may change about them (`PATCH /api/v1/users/:id`). */
export interface UserChange {
  isSiteAdmin?: boolean;
  name?: string;
  email?: string;
  timeZone?: string | null;
  locale?: string | null;
  breakGlass?: boolean;
}

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
    role?: RoleFilter,
  ) => Promise<{ users: User[]; total: number }>;
  /** One person with their roles, where each comes from, and the tracks they run (T-331). */
  person: (id: number) => Promise<PersonDetail>;
  createUser: (body: {
    name: string;
    email: string;
    isSiteAdmin: boolean;
  }) => Promise<{ user: User; activationLink: string | null }>;
  updateUser: (id: number, change: UserChange) => Promise<User>;
  /** Removes the person's second factors, so they set one up again (IAM-001). */
  resetTwoFactor: (id: number) => Promise<void>;
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
  users: (query, status, offset = 0, role = 'any') =>
    api<{ users: User[]; total: number }>(
      `/users?status=${status}&limit=${USERS_PAGE}${offset ? `&offset=${offset}` : ''}${
        role !== 'any' ? `&role=${role}` : ''
      }${query ? `&query=${encodeURIComponent(query)}` : ''}`,
    ),
  person: async (id) => {
    const read = await api<{
      user: User;
      roles: PersonDetail['roles'];
      tracks: PersonDetail['tracks'];
      hasSecondFactor: boolean;
      groups: PersonDetail['groups'];
      directory: (PersonDetail['directory'] & { dn?: string }) | null;
    }>(`/users/${id}`);
    return {
      user: read.user,
      roles: read.roles,
      tracks: read.tracks,
      hasSecondFactor: read.hasSecondFactor,
      groups: read.groups,
      directory: read.directory
        ? { id: read.directory.id, name: read.directory.name, mode: read.directory.mode }
        : null,
    };
  },
  createUser: async (body) => {
    const made = await api<{ user: User; activationLink?: string | null }>('/users', {
      method: 'POST',
      body,
    });
    return { user: made.user, activationLink: made.activationLink ?? null };
  },
  updateUser: async (id, change) =>
    (await api<{ user: User }>(`/users/${id}`, { method: 'PATCH', body: change })).user,
  resetTwoFactor: async (id) => {
    await api<unknown>(`/users/${id}/two-factor/reset`, { method: 'POST' });
  },
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
