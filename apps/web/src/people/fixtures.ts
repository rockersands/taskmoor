import { fakePersonalDataClient } from '../account/fixtures';
import { ApiError } from '../api/client';
import {
  ADMIN_ROLES,
  type AdminRole,
  type GroupDetail,
  type GroupSummary,
  type PeopleClient,
  type PersonDetail,
  type RoleSource,
  type ServiceAccountChoice,
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
  breakGlass: false,
  timeZone: null,
  locale: null,
  roles: extra.isSiteAdmin ? ['site_admin'] : [],
  tracksRun: 0,
  ...extra,
});

export const PEOPLE: User[] = [
  person(1, 'Ada Lovelace', 'ada@example.com', { isSiteAdmin: true }),
  person(2, 'Bo Rivera', 'bo@example.com'),
  person(3, 'Grace Hopper', 'grace@example.com', {
    roles: ['configuration_admin'],
    tracksRun: 2,
    timeZone: 'America/New_York',
  }),
  person(4, 'Ken Oduya', 'ken@example.com', {
    active: false,
    deactivatedAt: '2026-10-01T10:00:00Z',
    roles: ['ai_admin'],
  }),
];

/**
 * Where the sample people's roles come from (T-331), other than a site administrator's own flag:
 * Grace is a configuration administrator through Approvers, and Ken an AI administrator himself.
 */
const GRANTED: Record<number, { role: AdminRole; sources: RoleSource[] }[]> = {
  3: [
    {
      role: 'configuration_admin',
      sources: [{ kind: 'group', group: { id: 11, name: 'Approvers' } }],
    },
  ],
  4: [{ role: 'ai_admin', sources: [{ kind: 'user' }] }],
};

/** The tracks the sample people run (T-331): Grace runs two. */
const RUNS: Record<number, PersonDetail['tracks']> = {
  3: [
    { id: 7, key: 'OPS', name: 'Operations' },
    { id: 8, key: 'SHOP', name: 'Shop' },
  ],
};

/** Active service accounts, which the people list leaves out (IAM-007; T-320). */
export const SERVICE_ACCOUNTS: ServiceAccountChoice[] = [
  { id: 50, name: 'Release bot', email: 'service-50@service.invalid' },
  { id: 51, name: 'Nightly export', email: 'service-51@service.invalid' },
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
  options: {
    pageSize?: number;
    people?: User[];
    /** A third group, Engineering, kept by a directory with Release bot in it (M1-082; T-320). */
    directoryGroup?: boolean;
    /** Roles beyond a site administrator's own flag, by person (T-331); the samples' otherwise. */
    granted?: Record<number, { role: AdminRole; sources: RoleSource[] }[]>;
    /** The tracks each person runs (T-331). */
    runs?: Record<number, PersonDetail['tracks']>;
    /** Who has a second factor: Grace, unless given. */
    secondFactor?: number[];
    /** A person a read-only directory keeps (M1-082): their name, email and mark are its. */
    directoryPerson?: number;
  } = {},
): FakePeopleClient {
  const pageSize = options.pageSize ?? USERS_PAGE;
  let users = structuredClone(options.people ?? PEOPLE);
  const services: User[] = SERVICE_ACCOUNTS.map((a) =>
    person(a.id, a.name, a.email, { hasPassword: false, lastSignInAt: null }),
  );
  let groups: {
    id: number;
    name: string;
    description: string;
    members: number[];
    children: number[];
    directory?: { id: number; name: string };
  }[] = [
    { id: 11, name: 'Approvers', description: 'Sign off releases', members: [1, 3], children: [] },
    { id: 12, name: 'Support', description: '', members: [2], children: [] },
    ...(options.directoryGroup
      ? [
          {
            id: 13,
            name: 'Engineering',
            description: 'From the company directory',
            members: [3, 50],
            children: [],
            directory: { id: 2, name: 'Corporate directory' },
          },
        ]
      : []),
  ];
  let next = 100;
  const calls: FakePeopleClient['calls'] = [];
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  const find = (id: number) => {
    const user = users.find((u) => u.id === id);
    if (!user) throw new ApiError(404, { error: 'not_found' });
    return user;
  };
  const granted = structuredClone(options.granted ?? GRANTED);
  const runs = structuredClone(options.runs ?? RUNS);
  const secondFactor = new Set(options.secondFactor ?? [3]);
  /** A person's roles: a site administrator's own flag, then what grants give them. */
  const rolesOf = (u: User): PersonDetail['roles'] => {
    const given = (granted[u.id] ?? []).filter((r) => r.role !== 'site_admin');
    const site = granted[u.id]?.find((r) => r.role === 'site_admin')?.sources ?? [];
    const own: PersonDetail['roles'] =
      u.isSiteAdmin || site.length > 0
        ? [
            {
              role: 'site_admin',
              sources: [...(u.isSiteAdmin ? [{ kind: 'account' as const }] : []), ...site],
            },
          ]
        : [];
    return [...own, ...given].sort(
      (a, b) => ADMIN_ROLES.indexOf(a.role) - ADMIN_ROLES.indexOf(b.role),
    );
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
    users: async (query, status, offset = 0, role = 'any') => {
      const q = query.toLowerCase();
      const holds = (u: User) => {
        const roles = rolesOf(u).map((r) => r.role);
        const runs = (u.tracksRun ?? 0) > 0;
        if (role === 'any') return true;
        if (role === 'runs_tracks') return runs;
        if (role === 'member') return roles.length === 0 && !runs;
        return roles.includes(role);
      };
      const list = users
        .map((u) => ({ ...u, roles: rolesOf(u).map((r) => r.role) }))
        .filter(
          (u) =>
            (status === 'all' || (status === 'active' ? u.active : !u.active)) &&
            (!q || u.name.toLowerCase().includes(q) || u.email.includes(q)) &&
            holds(u),
        )
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id);
      return {
        users: structuredClone(list.slice(offset, offset + pageSize)),
        total: list.length,
      };
    },
    person: async (id) => {
      const user = find(id);
      const groupsOf = groups
        .filter((g) => g.members.includes(id))
        .map((g) => ({ id: g.id, name: g.name }));
      return structuredClone({
        user: { ...user, roles: rolesOf(user).map((r) => r.role) },
        roles: rolesOf(user),
        tracks: runs[id] ?? [],
        hasSecondFactor: secondFactor.has(id),
        groups: groupsOf,
        directory:
          options.directoryPerson === id
            ? { id: 2, name: 'Corporate directory', mode: 'read_only' }
            : null,
      });
    },
    resetTwoFactor: async (id) => {
      log('resetTwoFactor', id);
      find(id);
      secondFactor.delete(id);
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
        options.directoryPerson === id &&
        (change.name !== undefined || change.email !== undefined || change.breakGlass)
      ) {
        throw new ApiError(409, { error: 'directory_managed' });
      }
      if (
        change.email !== undefined &&
        users.some((u) => u.id !== id && u.email === change.email?.toLowerCase())
      ) {
        throw new ApiError(409, { error: 'email_taken' });
      }
      if (
        change.isSiteAdmin === false &&
        users.filter((u) => u.isSiteAdmin && u.active).length <= 1
      ) {
        throw new ApiError(409, { error: 'last_admin' });
      }
      Object.assign(user, change, change.email ? { email: change.email.toLowerCase() } : {});
      user.roles = rolesOf(user).map((r) => r.role);
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
        members: [
          ...users.filter((u) => g.members.includes(u.id)).map((u) => ({ ...u, kind: 'person' })),
          ...services
            .filter((u) => g.members.includes(u.id))
            .map((u) => ({ ...u, kind: 'service' })),
        ] as GroupDetail['members'],
        directory: g.directory ?? null,
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
      const g = group(id);
      if (change.name !== undefined && g.directory) {
        throw new ApiError(409, { error: 'directory_managed', directory: g.directory });
      }
      const taken = (other: (typeof groups)[number]) =>
        other.id !== id && other.name.toLowerCase() === change.name?.toLowerCase();
      if (change.name !== undefined && groups.some(taken)) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      Object.assign(g, change);
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
    serviceAccounts: async () => structuredClone(SERVICE_ACCOUNTS),
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
