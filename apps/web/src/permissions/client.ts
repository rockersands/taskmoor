import { api } from '../api/client';

export interface Named {
  id: number;
  name: string;
}

export interface Role {
  id: number;
  name: string;
  description: string;
}

export interface PolicySummary {
  id: number;
  name: string;
  description: string;
  isDefault: boolean;
  ownerTrackId: number | null;
  trackCount: number;
  grantCount: number;
}

/** Who a grant names. Field grantees (`user_field`, `group_field`) are given through the API. */
export type Grantee =
  | 'role'
  | 'group'
  | 'user'
  | 'track_owner'
  | 'any_user'
  | 'anyone'
  | 'requester'
  | 'assignee'
  | 'user_field'
  | 'group_field';

export interface Grant {
  id: number;
  permission: string;
  grantee: Grantee;
  roleId?: number | null;
  roleName?: string | null;
  groupId?: number | null;
  groupName?: string | null;
  userId?: number | null;
  userName?: string | null;
  fieldKey?: string | null;
}

export interface Policy {
  policy: { id: number; name: string; description: string; isDefault: boolean };
  grants: Grant[];
  tracks: { id: number; key: string; name: string }[];
}

export interface NewGrant {
  permission: string;
  grantee: Grantee;
  roleId?: number;
  groupId?: number;
  userId?: number;
}

/** The permission names, as `GET /api/v1/permissions/catalogue` lists them. */
export interface Catalogue {
  global: string[];
  track: Record<string, string[]>;
}

/** The endpoints the permissions page uses. Stories and tests pass their own. */
export interface PermissionsClient {
  catalogue: () => Promise<Catalogue>;
  roles: () => Promise<Role[]>;
  createRole: (body: { name: string; description?: string }) => Promise<Role>;
  updateRole: (id: number, change: { name?: string; description?: string }) => Promise<Role>;
  deleteRole: (id: number) => Promise<void>;
  policies: () => Promise<PolicySummary[]>;
  policy: (id: number) => Promise<Policy>;
  createPolicy: (body: { name: string; copyFrom?: number }) => Promise<Named>;
  deletePolicy: (id: number) => Promise<void>;
  addGrant: (policyId: number, grant: NewGrant) => Promise<void>;
  removeGrant: (policyId: number, grantId: number) => Promise<void>;
  globalGrants: () => Promise<Grant[]>;
  addGlobalGrant: (grant: NewGrant) => Promise<void>;
  removeGlobalGrant: (id: number) => Promise<void>;
  groups: () => Promise<Named[]>;
  findPeople: (query: string) => Promise<Named[]>;
}

export const permissionsClient: PermissionsClient = {
  catalogue: () => api<Catalogue>('/permissions/catalogue'),
  roles: async () => (await api<{ roles: Role[] }>('/roles')).roles,
  createRole: async (body) => (await api<{ role: Role }>('/roles', { method: 'POST', body })).role,
  updateRole: async (id, change) =>
    (await api<{ role: Role }>(`/roles/${id}`, { method: 'PATCH', body: change })).role,
  deleteRole: async (id) => {
    await api<unknown>(`/roles/${id}`, { method: 'DELETE' });
  },
  policies: async () => (await api<{ policies: PolicySummary[] }>('/access-policies')).policies,
  policy: (id) => api<Policy>(`/access-policies/${id}`),
  createPolicy: async (body) =>
    (await api<{ policy: Named }>('/access-policies', { method: 'POST', body })).policy,
  deletePolicy: async (id) => {
    await api<unknown>(`/access-policies/${id}`, { method: 'DELETE' });
  },
  addGrant: async (policyId, grant) => {
    await api<unknown>(`/access-policies/${policyId}/grants`, { method: 'POST', body: grant });
  },
  removeGrant: async (policyId, grantId) => {
    await api<unknown>(`/access-policies/${policyId}/grants/${grantId}`, { method: 'DELETE' });
  },
  globalGrants: async () => (await api<{ grants: Grant[] }>('/global-grants')).grants,
  addGlobalGrant: async (grant) => {
    await api<unknown>('/global-grants', { method: 'POST', body: grant });
  },
  removeGlobalGrant: async (id) => {
    await api<unknown>(`/global-grants/${id}`, { method: 'DELETE' });
  },
  groups: async () => (await api<{ groups: Named[] }>('/groups')).groups,
  findPeople: async (query) =>
    (
      await api<{ users: Named[] }>(
        `/users?status=active&limit=8&query=${encodeURIComponent(query)}`,
      )
    ).users,
};
