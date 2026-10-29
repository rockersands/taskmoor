import { ApiError } from '../api/client';
import type { GroupDetail, GroupSummary, PeopleClient, User } from './client';

const person = (id: number, name: string, email: string, extra: Partial<User> = {}): User => ({
  id,
  name,
  email,
  isSiteAdmin: false,
  active: true,
  hasPassword: true,
  createdAt: '2026-09-01T09:00:00Z',
  deactivatedAt: null,
  lastSignInAt: '2026-10-28T08:00:00Z',
  ...extra,
});

export const PEOPLE: User[] = [
  person(1, 'Ada Lovelace', 'ada@example.com', { isSiteAdmin: true }),
  person(2, 'Bo Rivera', 'bo@example.com'),
  person(3, 'Grace Hopper', 'grace@example.com'),
  person(4, 'Ken Oduya', 'ken@example.com', {
    active: false,
    deactivatedAt: '2026-10-01T10:00:00Z',
  }),
];

export interface FakePeopleClient extends PeopleClient {
  calls: { action: string; args: unknown[] }[];
}

/** An in-memory backend for stories and tests: it answers as the API would. */
export function fakePeopleClient(): FakePeopleClient {
  let users = structuredClone(PEOPLE);
  let groups: {
    id: number;
    name: string;
    description: string;
    members: number[];
    children: number[];
  }[] = [
    { id: 11, name: 'Approvers', description: 'Sign off releases', members: [1, 3], children: [] },
    { id: 12, name: 'Support', description: '', members: [2], children: [] },
  ];
  let next = 100;
  const calls: FakePeopleClient['calls'] = [];
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  const find = (id: number) => {
    const user = users.find((u) => u.id === id);
    if (!user) throw new ApiError(404, { error: 'not_found' });
    return user;
  };
  const group = (id: number) => {
    const g = groups.find((x) => x.id === id);
    if (!g) throw new ApiError(404, { error: 'not_found' });
    return g;
  };
  const summary = (g: (typeof groups)[number]): GroupSummary => ({
    id: g.id,
    name: g.name,
    description: g.description,
    memberCount: g.members.length,
    childCount: g.children.length,
  });
  return {
    calls,
    users: async (query, status) => {
      const q = query.toLowerCase();
      const list = users.filter(
        (u) =>
          (status === 'all' || (status === 'active' ? u.active : !u.active)) &&
          (!q || u.name.toLowerCase().includes(q) || u.email.includes(q)),
      );
      return { users: structuredClone(list), total: list.length };
    },
    createUser: async (body) => {
      log('createUser', body);
      if (users.some((u) => u.email === body.email.toLowerCase())) {
        throw new ApiError(409, { error: 'email_taken' });
      }
      const made = person(++next, body.name, body.email.toLowerCase(), {
        isSiteAdmin: body.isSiteAdmin,
        hasPassword: false,
        lastSignInAt: null,
      });
      users = [...users, made];
      return {
        user: structuredClone(made),
        activationLink: `https://taskmoor.example.com/#/password?token=link-${made.id}`,
      };
    },
    updateUser: async (id, change) => {
      log('updateUser', id, change);
      const user = find(id);
      if (
        change.isSiteAdmin === false &&
        users.filter((u) => u.isSiteAdmin && u.active).length <= 1
      ) {
        throw new ApiError(409, { error: 'last_admin' });
      }
      Object.assign(user, change);
      return structuredClone(user);
    },
    deactivate: async (id) => {
      log('deactivate', id);
      const user = find(id);
      Object.assign(user, { active: false, deactivatedAt: '2026-10-29T08:00:00Z' });
      return structuredClone(user);
    },
    reactivate: async (id) => {
      log('reactivate', id);
      const user = find(id);
      Object.assign(user, { active: true, deactivatedAt: null });
      return structuredClone(user);
    },
    passwordLink: async (id) => {
      log('passwordLink', id);
      find(id);
      return `https://taskmoor.example.com/#/password?token=reset-${id}`;
    },
    groups: async () => structuredClone(groups.map(summary)),
    group: async (id): Promise<GroupDetail> => {
      const g = group(id);
      return structuredClone({
        group: { id: g.id, name: g.name, description: g.description },
        members: users.filter((u) => g.members.includes(u.id)),
        children: groups
          .filter((c) => g.children.includes(c.id))
          .map((c) => ({ id: c.id, name: c.name })),
        parents: groups
          .filter((p) => p.children.includes(g.id))
          .map((p) => ({ id: p.id, name: p.name })),
      });
    },
    createGroup: async (body) => {
      log('createGroup', body);
      if (groups.some((g) => g.name.toLowerCase() === body.name.toLowerCase())) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      const made = { id: ++next, ...body, members: [], children: [] };
      groups = [...groups, made];
      return { id: made.id };
    },
    renameGroup: async (id, change) => {
      log('renameGroup', id, change);
      Object.assign(group(id), change);
    },
    deleteGroup: async (id) => {
      log('deleteGroup', id);
      groups = groups
        .filter((g) => g.id !== id)
        .map((g) => ({ ...g, children: g.children.filter((c) => c !== id) }));
    },
    addMember: async (id, userId) => {
      log('addMember', id, userId);
      const g = group(id);
      if (!g.members.includes(userId)) g.members.push(userId);
    },
    removeMember: async (id, userId) => {
      log('removeMember', id, userId);
      const g = group(id);
      g.members = g.members.filter((m) => m !== userId);
    },
    addChild: async (id, childId) => {
      log('addChild', id, childId);
      const parentOf = (c: number): boolean =>
        c === id || groups.some((g) => g.id === c && g.children.some(parentOf));
      if (parentOf(childId)) throw new ApiError(409, { error: 'nesting_cycle' });
      group(id).children.push(childId);
    },
    removeChild: async (id, childId) => {
      log('removeChild', id, childId);
      const g = group(id);
      g.children = g.children.filter((c) => c !== childId);
    },
  };
}
