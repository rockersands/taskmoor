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

/**
 * Who a grant names. Field grantees name a field of the ticket by key (`cf[12]`): `user_field`
 * a user field, whose people get the grant, `group_field` a group field, whose groups do.
 */
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
  fieldKey?: string;
}

/** A user or group field a field grantee may name (IAM-010, IAM-011; T-320). */
export interface FieldChoice {
  /** As grants name it: `cf[12]`. */
  key: string;
  name: string;
  type: 'user' | 'group';
  /** The local-mode track that owns it; null for a shared field. */
  trackId: number | null;
}

/** The field a grantee names, by its name; its key when the field is gone. */
export function fieldName(fields: readonly FieldChoice[], key: string | null | undefined): string {
  return fields.find((f) => f.key === key)?.name ?? key ?? '';
}

/** The user and group fields of the site, as field grantees name them. */
export async function readFieldChoices(): Promise<FieldChoice[]> {
  const { fields } = await api<{
    fields: { id: number; name: string; type: string; trackId: number | null }[];
  }>('/fields');
  return fields.flatMap((f) =>
    f.type === 'user' || f.type === 'group'
      ? [{ key: `cf[${f.id}]`, name: f.name, type: f.type, trackId: f.trackId }]
      : [],
  );
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
  /** The user and group fields field grantees name (T-320). */
  fields: () => Promise<FieldChoice[]>;
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
  fields: readFieldChoices,
};
