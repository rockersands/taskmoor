import { ApiError } from '../api/client';
import type { Grant, NewGrant, PermissionsClient, Policy, PolicySummary, Role } from './client';

export interface FakePermissionsClient extends PermissionsClient {
  calls: { action: string; args: unknown[] }[];
}

const GROUPS = [
  { id: 11, name: 'Approvers' },
  { id: 12, name: 'Support' },
];
const PEOPLE = [
  { id: 1, name: 'Ada Lovelace' },
  { id: 2, name: 'Bo Rivera' },
];

/**
 * An in-memory backend for stories and tests: it answers as the API would. Members is used by
 * the default policy, so deleting it is refused; the default policy is used by two tracks.
 */
export function fakePermissionsClient(): FakePermissionsClient {
  let roles: Role[] = [
    { id: 7, name: 'Administrators', description: 'Run the track' },
    { id: 8, name: 'Members', description: 'Do the work' },
    { id: 9, name: 'Viewers', description: '' },
  ];
  const policies: Policy[] = [
    {
      policy: { id: 1, name: 'Default access policy', description: '', isDefault: true },
      grants: [
        { id: 101, permission: 'browse_track', grantee: 'role', roleId: 8, roleName: 'Members' },
        { id: 102, permission: 'browse_track', grantee: 'any_user' },
        { id: 103, permission: 'create_tickets', grantee: 'role', roleId: 8, roleName: 'Members' },
      ],
      tracks: [
        { id: 3, key: 'SHOP', name: 'Shop' },
        { id: 4, key: 'OPS', name: 'Operations' },
      ],
    },
  ];
  let global: Grant[] = [
    { id: 201, permission: 'browse_users', grantee: 'any_user' },
    { id: 202, permission: 'bulk_change', grantee: 'group', groupId: 11, groupName: 'Approvers' },
  ];
  let next = 1000;
  const calls: FakePermissionsClient['calls'] = [];
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  const named = (grant: NewGrant): Grant => ({
    id: ++next,
    ...grant,
    roleName: roles.find((r) => r.id === grant.roleId)?.name ?? null,
    groupName: GROUPS.find((g) => g.id === grant.groupId)?.name ?? null,
    userName: PEOPLE.find((p) => p.id === grant.userId)?.name ?? null,
  });
  const same = (a: Grant, b: NewGrant) =>
    a.permission === b.permission &&
    a.grantee === b.grantee &&
    (a.roleId ?? undefined) === b.roleId &&
    (a.groupId ?? undefined) === b.groupId &&
    (a.userId ?? undefined) === b.userId;
  const policyOf = (id: number) => policies.find((p) => p.policy.id === id) as Policy;
  return {
    calls,
    catalogue: async () => ({
      global: ['site_admin', 'configuration_admin', 'browse_users', 'bulk_change'],
      track: {
        administration: ['administer_track', 'edit_workflows'],
        track: ['browse_track'],
        tickets: ['create_tickets', 'edit_tickets'],
      },
    }),
    roles: async () => structuredClone(roles),
    createRole: async (body) => {
      log('createRole', body);
      if (roles.some((r) => r.name === body.name)) throw new ApiError(409, { error: 'name_taken' });
      const made = { id: ++next, name: body.name, description: body.description ?? '' };
      roles = [...roles, made];
      return made;
    },
    updateRole: async (id, change) => {
      log('updateRole', id, change);
      const role = roles.find((r) => r.id === id) as Role;
      Object.assign(role, change);
      return { ...role };
    },
    deleteRole: async (id) => {
      log('deleteRole', id);
      if (policies.some((p) => p.grants.some((g) => g.roleId === id))) {
        throw new ApiError(409, { error: 'role_in_use' });
      }
      roles = roles.filter((r) => r.id !== id);
    },
    policies: async () =>
      policies.map(
        (p): PolicySummary => ({
          ...p.policy,
          ownerTrackId: null,
          trackCount: p.tracks.length,
          grantCount: p.grants.length,
        }),
      ),
    policy: async (id) => structuredClone(policyOf(id)),
    createPolicy: async (body) => {
      log('createPolicy', body);
      const made: Policy = {
        policy: { id: ++next, name: body.name, description: '', isDefault: false },
        grants:
          body.copyFrom === undefined
            ? []
            : policyOf(body.copyFrom).grants.map((g) => ({ ...g, id: ++next })),
        tracks: [],
      };
      policies.push(made);
      return { id: made.policy.id, name: body.name };
    },
    deletePolicy: async (id) => {
      log('deletePolicy', id);
      if (policyOf(id).tracks.length > 0) throw new ApiError(409, { error: 'policy_in_use' });
      policies.splice(policies.indexOf(policyOf(id)), 1);
    },
    addGrant: async (policyId, grant) => {
      log('addGrant', policyId, grant);
      const policy = policyOf(policyId);
      if (policy.grants.some((g) => same(g, grant))) {
        throw new ApiError(409, { error: 'grant_exists' });
      }
      policy.grants.push(named(grant));
    },
    removeGrant: async (policyId, grantId) => {
      log('removeGrant', policyId, grantId);
      const policy = policyOf(policyId);
      policy.grants = policy.grants.filter((g) => g.id !== grantId);
    },
    globalGrants: async () => structuredClone(global),
    addGlobalGrant: async (grant) => {
      log('addGlobalGrant', grant);
      if (grant.grantee === 'any_user' && grant.permission === 'site_admin') {
        throw new ApiError(400, {
          error: 'invalid_request',
          detail: 'administration cannot go to everyone',
        });
      }
      if (global.some((g) => same(g, grant))) throw new ApiError(409, { error: 'grant_exists' });
      global = [...global, named(grant)];
    },
    removeGlobalGrant: async (id) => {
      log('removeGlobalGrant', id);
      global = global.filter((g) => g.id !== id);
    },
    groups: async () => structuredClone(GROUPS),
    findPeople: async (query) =>
      PEOPLE.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
  };
}
