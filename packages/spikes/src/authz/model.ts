import { Rng, ZipfSampler } from '@taskmoor/testkit/gen';

/**
 * Synthetic permission data for the M0-018 spike (ADR-012), shaped like the IAM spec, file 05a:
 * shared permission policies grant each space permission to grantees (space roles, groups,
 * users, the space lead, any signed-in user, anyone); each space uses one policy and names the
 * actors of its roles (users and groups); users belong to groups.
 */
export interface AuthzConfig {
  seed: number;
  users: number;
  groups: number;
  spaces: number;
  policies: number;
}

/** The space permissions of section 1.2 of the IAM spec, as identifiers. */
export const PERMISSIONS: readonly string[] = [
  'administer',
  'manage-layouts',
  'edit-workflows',
  'browse',
  'manage-sprints',
  'service-agent',
  'view-aggregated',
  'view-dev-tools',
  'view-workflow',
  'archive',
  'assignable',
  'assign',
  'close',
  'create',
  'delete',
  'edit',
  'link',
  'modify-reporter',
  'move',
  'resolve',
  'schedule',
  'set-security',
  'transition',
  'restore',
  'send-email',
  'manage-watchers',
  'view-watchers',
  'comment-add',
  'comment-delete-all',
  'comment-delete-own',
  'comment-edit-all',
  'comment-edit-own',
  'attach-create',
  'attach-delete-all',
  'attach-delete-own',
  'work-on',
  'worklog-edit-all',
  'worklog-edit-own',
  'worklog-delete-all',
  'worklog-delete-own',
];

export const ROLES = ['administrators', 'members', 'viewers', 'agents', 'customers'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_ID: Record<Role, number> = {
  administrators: 1,
  members: 2,
  viewers: 3,
  agents: 4,
  customers: 5,
};

export type GranteeKind = 'anyone' | 'authenticated' | 'lead' | 'user' | 'group' | 'role';

export interface Grant {
  policyId: number;
  permission: string;
  kind: GranteeKind;
  /** User, group or role id; 0 for anyone, authenticated and lead. */
  id: number;
}

export interface RoleActor {
  spaceId: number;
  roleId: number;
  kind: 'user' | 'group';
  id: number;
}

export interface AuthzModel {
  config: AuthzConfig;
  /** [userId, groupId] pairs. */
  memberships: [number, number][];
  spaces: { id: number; policyId: number; leadId: number }[];
  grants: Grant[];
  roleActors: RoleActor[];
}

export function scaleAuthz(users: number, spaces: number, seed = 7): AuthzConfig {
  return {
    seed,
    users,
    groups: Math.max(20, Math.floor(users / 20)),
    spaces,
    policies: Math.max(10, Math.floor(spaces / 50)),
  };
}

const ADMIN_ONLY = new Set([
  'administer',
  'manage-layouts',
  'edit-workflows',
  'delete',
  'comment-delete-all',
  'comment-edit-all',
  'attach-delete-all',
  'worklog-edit-all',
  'worklog-delete-all',
  'set-security',
  'restore',
  'archive',
  'modify-reporter',
]);
const VIEW_ONLY = new Set(['browse', 'view-aggregated', 'view-workflow', 'view-watchers']);

/** Deterministic for a config, like the item dataset. */
export function createAuthzModel(config: AuthzConfig): AuthzModel {
  const rng = new Rng(config.seed);
  const groupSampler = new ZipfSampler(config.groups, 0.9);
  const userSampler = new ZipfSampler(config.users, 0.6);
  const policySampler = new ZipfSampler(config.policies, 1.1);

  // Group 1 is "staff": most people are in it, and many spaces let it view.
  const memberships: [number, number][] = [];
  for (let u = 1; u <= config.users; u++) {
    const groups = new Set<number>();
    if (rng.chance(0.9)) groups.add(1);
    const extra = rng.int(1, 4);
    while (groups.size < extra + (groups.has(1) ? 1 : 0)) {
      groups.add(groupSampler.sample(rng) + 1);
    }
    for (const g of groups) memberships.push([u, g]);
  }

  const grants: Grant[] = [];
  for (let p = 1; p <= config.policies; p++) {
    // Any signed-in user may browse "open" policies; "anyone" policies are public. Policies 3
    // and 4 are always one of each, so every grantee kind exists at any scale.
    const open = p === 3 || rng.chance(0.08);
    const anyone = p === 4 || (!open && rng.chance(0.02));
    for (const permission of PERMISSIONS) {
      const roles: Role[] = ['administrators'];
      if (!ADMIN_ONLY.has(permission)) roles.push('members');
      if (VIEW_ONLY.has(permission)) roles.push('viewers');
      if (permission === 'service-agent' || permission === 'work-on') roles.push('agents');
      if (permission === 'browse' || permission === 'comment-add' || permission === 'create') {
        if (rng.chance(0.3)) roles.push('customers');
      }
      for (const role of roles) {
        grants.push({ policyId: p, permission, kind: 'role', id: ROLE_ID[role] });
      }
      if (permission === 'administer' && rng.chance(0.5)) {
        grants.push({ policyId: p, permission, kind: 'lead', id: 0 });
      }
      if (VIEW_ONLY.has(permission) && open) {
        grants.push({ policyId: p, permission, kind: 'authenticated', id: 0 });
      }
      if (VIEW_ONLY.has(permission) && anyone) {
        grants.push({ policyId: p, permission, kind: 'anyone', id: 0 });
      }
      if (rng.chance(0.1)) {
        grants.push({ policyId: p, permission, kind: 'group', id: groupSampler.sample(rng) + 1 });
      }
      if (rng.chance(0.03)) {
        grants.push({ policyId: p, permission, kind: 'user', id: userSampler.sample(rng) + 1 });
      }
    }
  }

  const spaces: AuthzModel['spaces'] = [];
  const roleActors: RoleActor[] = [];
  const seen = new Set<string>();
  const actor = (spaceId: number, roleId: number, kind: 'user' | 'group', id: number) => {
    const key = `${spaceId}:${roleId}:${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    roleActors.push({ spaceId, roleId, kind, id });
  };
  for (let s = 1; s <= config.spaces; s++) {
    const leadId = userSampler.sample(rng) + 1;
    spaces.push({ id: s, policyId: policySampler.sample(rng) + 1, leadId });
    actor(s, ROLE_ID.administrators, 'user', leadId);
    for (let i = rng.int(0, 2); i > 0; i--) {
      actor(s, ROLE_ID.administrators, 'user', userSampler.sample(rng) + 1);
    }
    if (rng.chance(0.3)) actor(s, ROLE_ID.administrators, 'group', groupSampler.sample(rng) + 1);
    for (let i = rng.int(1, 3); i > 0; i--) {
      actor(s, ROLE_ID.members, 'group', groupSampler.sample(rng) + 1);
    }
    for (let i = rng.geometric(4); i > 0; i--) {
      actor(s, ROLE_ID.members, 'user', userSampler.sample(rng) + 1);
    }
    if (rng.chance(0.6)) actor(s, ROLE_ID.viewers, 'group', 1);
    for (let i = rng.int(0, 2); i > 0; i--) {
      actor(s, ROLE_ID.viewers, 'group', groupSampler.sample(rng) + 1);
    }
    if (rng.chance(0.2)) actor(s, ROLE_ID.agents, 'group', groupSampler.sample(rng) + 1);
    if (rng.chance(0.1)) actor(s, ROLE_ID.customers, 'group', groupSampler.sample(rng) + 1);
  }

  return { config, memberships, spaces, grants, roleActors };
}

/**
 * The plain reading of the model, for tests: a user holds a permission in a space when the
 * space's policy grants it to anyone, to any signed-in user, to the user, to one of the user's
 * groups, to the lead when the user leads the space, or to a role the user or one of the
 * user's groups acts in for that space.
 */
export class ReferenceEvaluator {
  private readonly groupsOf = new Map<number, Set<number>>();
  private readonly spaceById = new Map<number, AuthzModel['spaces'][number]>();
  private readonly grantsByPolicy = new Map<number, Grant[]>();
  private readonly actorsBySpace = new Map<number, RoleActor[]>();

  constructor(private readonly model: AuthzModel) {
    const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
      const list = map.get(key);
      if (list) list.push(value);
      else map.set(key, [value]);
    };
    for (const [u, g] of model.memberships) {
      const set = this.groupsOf.get(u);
      if (set) set.add(g);
      else this.groupsOf.set(u, new Set([g]));
    }
    for (const s of model.spaces) this.spaceById.set(s.id, s);
    for (const g of model.grants) push(this.grantsByPolicy, g.policyId, g);
    for (const a of model.roleActors) push(this.actorsBySpace, a.spaceId, a);
  }

  check(userId: number, spaceId: number, permission: string): boolean {
    const space = this.spaceById.get(spaceId);
    if (!space) return false;
    const groups = this.groupsOf.get(userId) ?? new Set<number>();
    const roles = new Set<number>();
    for (const a of this.actorsBySpace.get(spaceId) ?? []) {
      if ((a.kind === 'user' && a.id === userId) || (a.kind === 'group' && groups.has(a.id))) {
        roles.add(a.roleId);
      }
    }
    for (const g of this.grantsByPolicy.get(space.policyId) ?? []) {
      if (g.permission !== permission) continue;
      switch (g.kind) {
        case 'anyone':
        case 'authenticated':
          return true;
        case 'lead':
          if (space.leadId === userId) return true;
          break;
        case 'user':
          if (g.id === userId) return true;
          break;
        case 'group':
          if (groups.has(g.id)) return true;
          break;
        case 'role':
          if (roles.has(g.id)) return true;
          break;
      }
    }
    return false;
  }

  allowedSpaces(userId: number, permission: string): number[] {
    return this.model.spaces.filter((s) => this.check(userId, s.id, permission)).map((s) => s.id);
  }
}
