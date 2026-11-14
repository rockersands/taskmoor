import { fakePersonalDataClient } from '../account/fixtures';
import { ApiError } from '../api/client';
import {
  type GroupDetail,
  type GroupSummary,
  type PeopleClient,
  USERS_PAGE,
  type User,
} from './client';
import type { TeamDetail, TeamSummary, TeamsClient } from './teamsClient';

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

/** `count` active people named Person 001, Person 002…, for lists longer than a page (T-307). */
export function manyPeople(count: number): User[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    return person(1000 + i, `Person ${n}`, `person-${n}@example.com`);
  });
}

export interface FakePeopleClient extends PeopleClient {
  calls: { action: string; args: unknown[] }[];
}

/**
 * An in-memory backend for stories and tests: it answers as the API would, `pageSize` people a
 * page (as many as the People page asks for, unless a story wants to show paging), and holds
 * `people` (the sample people unless given).
 */
export function fakePeopleClient(
  options: { pageSize?: number; people?: User[] } = {},
): FakePeopleClient {
  const pageSize = options.pageSize ?? USERS_PAGE;
  let users = structuredClone(options.people ?? PEOPLE);
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
    users: async (query, status, offset = 0) => {
      const q = query.toLowerCase();
      const list = users
        .filter(
          (u) =>
            (status === 'all' || (status === 'active' ? u.active : !u.active)) &&
            (!q || u.name.toLowerCase().includes(q) || u.email.includes(q)),
        )
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id);
      return {
        users: structuredClone(list.slice(offset, offset + pageSize)),
        total: list.length,
      };
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
    erase: async (id, confirmEmail) => {
      log('erase', id, confirmEmail);
      const user = find(id);
      if (confirmEmail.trim().toLowerCase() !== user.email) {
        throw new ApiError(400, { error: 'confirmation_mismatch' });
      }
      if (id === 1) throw new ApiError(409, { error: 'cannot_erase_self' });
      const label = `Former user ${id}`;
      Object.assign(user, {
        name: label,
        email: `erased-${id}@erased.invalid`,
        active: false,
        isSiteAdmin: false,
        hasPassword: false,
        deactivatedAt: '2026-11-02T08:00:00Z',
        erased: true,
      });
      return { label };
    },
    personalData: (user) => fakePersonalDataClient(user.name),
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

export interface FakeTeamsClient extends TeamsClient {
  calls: { action: string; args: unknown[] }[];
}

/** Teams for stories and tests (M1-123): an in-memory backend that answers as the API would. */
export function fakeTeamsClient(): FakeTeamsClient {
  const people = structuredClone(PEOPLE);
  let teams: {
    id: number;
    name: string;
    description: string;
    lead: number | null;
    members: number[];
  }[] = [
    { id: 21, name: 'Platform', description: 'Runs the servers', lead: 3, members: [2, 3] },
    { id: 22, name: 'Mobile', description: '', lead: null, members: [] },
  ];
  let next = 200;
  const calls: FakeTeamsClient['calls'] = [];
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  const team = (id: number) => {
    const t = teams.find((x) => x.id === id);
    if (!t) throw new ApiError(404, { error: 'not_found' });
    return t;
  };
  const summary = (t: (typeof teams)[number]): TeamSummary => {
    const lead = people.find((p) => p.id === t.lead);
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      lead: lead ? { id: lead.id, name: lead.name } : null,
      memberCount: t.members.length,
    };
  };
  const taken = (name: string, id?: number) =>
    teams.some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase());
  return {
    calls,
    teams: async () =>
      structuredClone(
        [...teams].sort((a, b) => a.name.localeCompare(b.name)).map((t) => summary(t)),
      ),
    team: async (id): Promise<TeamDetail> => {
      const t = team(id);
      return structuredClone({
        team: summary(t),
        members: people
          .filter((p) => t.members.includes(p.id))
          .map((p) => ({ id: p.id, name: p.name, active: p.active })),
      });
    },
    createTeam: async (body) => {
      log('createTeam', body);
      if (taken(body.name)) throw new ApiError(409, { error: 'name_taken' });
      const made = { id: ++next, ...body, lead: null, members: [] };
      teams = [...teams, made];
      return summary(made);
    },
    updateTeam: async (id, change) => {
      log('updateTeam', id, change);
      const t = team(id);
      if (change.name !== undefined && taken(change.name, id)) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      if (change.name !== undefined) t.name = change.name;
      if (change.description !== undefined) t.description = change.description;
      if (change.leadId !== undefined) t.lead = change.leadId;
      return summary(t);
    },
    deleteTeam: async (id) => {
      log('deleteTeam', id);
      teams = teams.filter((t) => t.id !== id);
    },
    addTeamMember: async (id, userId) => {
      log('addTeamMember', id, userId);
      const t = team(id);
      if (!t.members.includes(userId)) t.members.push(userId);
    },
    removeTeamMember: async (id, userId) => {
      log('removeTeamMember', id, userId);
      const t = team(id);
      t.members = t.members.filter((m) => m !== userId);
    },
    people: async (query) => {
      const q = query.toLowerCase();
      return structuredClone(
        people.filter((p) => p.active && (p.name.toLowerCase().includes(q) || p.email.includes(q))),
      );
    },
  };
}
