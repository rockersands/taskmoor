import { ApiError } from '../api/client';
import type { Named } from './client';
import { FIELD_CHOICES } from './fixtures';
import type {
  ExplainClient,
  Explanation,
  VisibilityClient,
  VisibilityLevel,
  VisibilityPolicy,
} from './visibilityClient';

const ROLES: Named[] = [
  { id: 1, name: 'Administrators' },
  { id: 2, name: 'Members' },
];
const GROUPS: Named[] = [{ id: 5, name: 'Security team' }];
const PEOPLE: Named[] = [
  { id: 7, name: 'Sam Rivera' },
  { id: 8, name: 'Noor Haddad' },
];

const level = (id: number, name: string, fields: Partial<VisibilityLevel> = {}) => ({
  id,
  name,
  description: '',
  position: 0,
  members: [],
  ...fields,
});

/** Synthetic policies: one in use with two levels, one no track uses. */
const POLICIES: VisibilityPolicy[] = [
  {
    id: 1,
    name: 'Company levels',
    description: 'What stays inside the company.',
    trackId: null,
    defaultLevelId: 11,
    levels: [
      level(11, 'Internal', {
        position: 0,
        description: 'Staff only.',
        members: [
          {
            id: 100,
            grantee: 'role',
            role: { id: 2, name: 'Members' },
            group: null,
            user: null,
            fieldKey: null,
          },
          // Whoever the ticket's Reviewer field names (T-320).
          {
            id: 102,
            grantee: 'user_field',
            role: null,
            group: null,
            user: null,
            fieldKey: 'cf[31]',
          },
        ],
      }),
      level(12, 'Security', {
        position: 1,
        members: [
          {
            id: 101,
            grantee: 'group',
            role: null,
            group: { id: 5, name: 'Security team' },
            user: null,
            fieldKey: null,
          },
        ],
      }),
    ],
    usedBy: [{ id: 3, key: 'SHOP', name: 'Shop' }],
  },
  {
    id: 2,
    name: 'Spare',
    description: '',
    trackId: null,
    defaultLevelId: null,
    levels: [],
    usedBy: [],
  },
];

export interface FakeCall {
  action: string;
  args: unknown[];
}

/** The policies in memory, behaving like the server's refusals. */
export function fakeVisibilityClient(
  start: VisibilityPolicy[] = POLICIES,
): VisibilityClient & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let policies = structuredClone(start);
  let next = 200;
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  const policyOf = (id: number) => {
    const found = policies.find((p) => p.id === id);
    if (!found) throw new ApiError(404, { error: 'not_found' });
    return found;
  };
  return {
    calls,
    policies: async () => structuredClone(policies),
    createPolicy: async (body) => {
      log('createPolicy', body);
      if (policies.some((p) => p.name === body.name)) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      policies.push({
        id: next++,
        name: body.name,
        description: body.description ?? '',
        trackId: null,
        defaultLevelId: null,
        levels: [],
        usedBy: [],
      });
    },
    updatePolicy: async (id, change) => {
      log('updatePolicy', id, change);
      Object.assign(policyOf(id), change);
    },
    deletePolicy: async (id) => {
      log('deletePolicy', id);
      if (policyOf(id).usedBy.length > 0) throw new ApiError(409, { error: 'in_use' });
      policies = policies.filter((p) => p.id !== id);
    },
    addLevel: async (policyId, body) => {
      log('addLevel', policyId, body);
      const policy = policyOf(policyId);
      policy.levels.push(level(next++, body.name, { position: policy.levels.length }));
    },
    updateLevel: async (policyId, levelId, change) => {
      log('updateLevel', policyId, levelId, change);
      const policy = policyOf(policyId);
      const found = policy.levels.find((l) => l.id === levelId);
      if (!found) return;
      Object.assign(found, change);
      if (change.position !== undefined) {
        policy.levels = policy.levels.filter((l) => l.id !== levelId);
        policy.levels.splice(change.position, 0, found);
      }
    },
    deleteLevel: async (policyId, levelId, replaceWith) => {
      log('deleteLevel', policyId, levelId, replaceWith);
      // The first level holds tickets, as a level in use does.
      if (levelId === 11 && replaceWith === undefined) {
        throw new ApiError(409, { error: 'in_use', ticketCount: 4 });
      }
      const policy = policyOf(policyId);
      policy.levels = policy.levels.filter((l) => l.id !== levelId);
    },
    addMember: async (policyId, levelId, member) => {
      log('addMember', policyId, levelId, member);
      const found = policyOf(policyId).levels.find((l) => l.id === levelId);
      found?.members.push({
        id: next++,
        grantee: member.grantee,
        role: member.roleId ? (ROLES.find((r) => r.id === member.roleId) ?? null) : null,
        group: member.groupId ? (GROUPS.find((g) => g.id === member.groupId) ?? null) : null,
        user: member.userId ? (PEOPLE.find((p) => p.id === member.userId) ?? null) : null,
        fieldKey: member.fieldKey ?? null,
      });
    },
    removeMember: async (policyId, levelId, memberId) => {
      log('removeMember', policyId, levelId, memberId);
      const found = policyOf(policyId).levels.find((l) => l.id === levelId);
      if (found) found.members = found.members.filter((m) => m.id !== memberId);
    },
    roles: async () => ROLES,
    groups: async () => GROUPS,
    findPeople: async (query) =>
      PEOPLE.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
    fields: async () => structuredClone(FIELD_CHOICES),
  };
}

export const ALLOWED: Explanation = {
  allowed: true,
  trackArchived: false,
  trackInTrash: false,
  reasons: [
    { kind: 'grant', grantId: 1, grantee: 'role', roleName: 'Members' },
    { kind: 'grant', grantId: 2, grantee: 'group', groupName: 'Security team' },
  ],
  ticketLevel: [{ grantId: 3, grantee: 'assignee', fieldKey: null }],
};

export const REFUSED: Explanation = {
  allowed: false,
  trackArchived: false,
  trackInTrash: false,
  reasons: [],
  ticketLevel: [],
};

export const HIDDEN_TICKET: Explanation = {
  ...ALLOWED,
  allowed: false,
  ticket: {
    id: 9,
    key: 'SHOP-9',
    visibilityLevel: { id: 12, name: 'Security', member: false, matched: [] },
    ticketGrants: [],
  },
};

export function fakeExplainClient(
  answer: (ticket?: string) => Explanation = (ticket) => (ticket ? HIDDEN_TICKET : ALLOWED),
): ExplainClient & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    catalogue: async () => ({
      tickets: ['edit_tickets', 'delete_tickets'],
      track: ['browse_track'],
    }),
    tracks: async () => [
      { id: 3, key: 'SHOP', name: 'Shop' },
      { id: 4, key: 'OPS', name: 'Operations' },
    ],
    findPeople: async (query) =>
      PEOPLE.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
    explain: async (question) => {
      asked.push(question);
      if (question.ticket === 'NOPE-1') throw new ApiError(404, { error: 'not_found' });
      return answer(question.ticket);
    },
  };
}
