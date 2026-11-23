import { ApiError } from '../api/client';
import type { RunTrack, ScopeTrack } from '../sets/trackScope';
import type {
  Choice,
  FieldChoice,
  NotificationPolicy,
  PoliciesClient,
  PolicyRule,
  RuleInput,
} from './policiesClient';

/** The built-in events, as `GET /api/v1/notification-events` lists them. */
export const BUILT_IN_EVENTS = [
  'ticket_created',
  'ticket_updated',
  'ticket_assigned',
  'ticket_close_reason_set',
  'ticket_closed',
  'ticket_commented',
  'ticket_reopened',
  'ticket_deleted',
  'ticket_moved',
  'time_entry_added',
  'time_entry_updated',
  'time_entry_deleted',
  'work_started',
  'work_stopped',
  'generic',
];

/** SHOP is in shared mode; OPS has its own configuration and is run by the track admin. */
export const POLICY_TRACKS: ScopeTrack[] = [
  {
    id: 3,
    key: 'SHOP',
    name: 'Shop',
    mode: 'shared',
    archived: false,
    typeSetId: 1,
    fieldRuleSetId: null,
    layoutSetId: null,
  },
  {
    id: 4,
    key: 'OPS',
    name: 'Operations',
    mode: 'local',
    archived: false,
    typeSetId: 30,
    fieldRuleSetId: null,
    layoutSetId: null,
  },
];
const RUNS: RunTrack[] = POLICY_TRACKS.map(({ id, key, name, mode }) => ({ id, key, name, mode }));

const ROLES: Choice[] = [
  { id: 1, name: 'Administrators' },
  { id: 2, name: 'Members' },
  { id: 3, name: 'Viewers' },
];
const GROUPS: Choice[] = [
  { id: 12, name: 'Payments team' },
  { id: 13, name: 'Release managers' },
];
const PEOPLE: Choice[] = [
  { id: 21, name: 'Ana Ruiz' },
  { id: 22, name: 'Bo Lindqvist' },
];
const FIELDS: (FieldChoice & { trackId: number | null })[] = [
  { key: 'cf[31]', name: 'Reviewer', type: 'user', trackId: null },
  { key: 'cf[32]', name: 'Owning team', type: 'group', trackId: null },
  { key: 'cf[41]', name: 'On call', type: 'user', trackId: 4 },
];

/** A rule as the server answers it, with the names of what it points at. */
function named(id: number, input: RuleInput): PolicyRule {
  const field = FIELDS.find((f) => f.key === input.fieldKey);
  return {
    id,
    event: input.event,
    recipient: input.recipient,
    userId: input.userId ?? null,
    groupId: input.groupId ?? null,
    roleId: input.roleId ?? null,
    fieldKey: input.fieldKey ?? null,
    userName: PEOPLE.find((p) => p.id === input.userId)?.name ?? null,
    groupName: GROUPS.find((g) => g.id === input.groupId)?.name ?? null,
    roleName: ROLES.find((r) => r.id === input.roleId)?.name ?? null,
    fieldName: field?.name ?? null,
  };
}

const DEFAULT_RULES: RuleInput[] = BUILT_IN_EVENTS.flatMap((event) =>
  (['assignee', 'requester', 'follower'] as const).map((recipient) => ({ event, recipient })),
);
const PAYMENTS_RULES: RuleInput[] = [
  { event: 'ticket_created', recipient: 'group', groupId: 12 },
  { event: 'ticket_commented', recipient: 'follower' },
  { event: 'ticket_assigned', recipient: 'assignee' },
  { event: 'custom:ready-for-review', recipient: 'user_field', fieldKey: 'cf[31]' },
  { event: 'ticket_closed', recipient: 'role', roleId: 2 },
  { event: 'ticket_closed', recipient: 'user', userId: 21 },
];

export interface FakePoliciesClient extends PoliciesClient {
  calls: { action: string; args: unknown[] }[];
  /** The policies as stored, for assertions. */
  stored: () => NotificationPolicy[];
}

/** A field since deleted: a rule may still name it, and the server refuses a list that does. */
const GONE_FIELD = 'cf[39]';

/**
 * An in-memory backend for stories and tests that answers as the API would. The default policy
 * serves SHOP (which names none); Payments is unused; OPS owns On-call alerts, which it uses.
 * Deleting a policy in use answers `409 in_use`; a name already taken, `409 name_taken`; a rule
 * naming a field no longer there, `400 invalid_request`. With `goneField`, Payments also tells
 * Reviewer of new tickets through a field since deleted.
 */
export function fakePoliciesClient(
  options: {
    runs?: RunTrack[];
    groups?: Choice[];
    fail?: 'load' | 'forbidden';
    goneField?: boolean;
  } = {},
): FakePoliciesClient {
  let nextRule = 100;
  let nextPolicy = 50;
  const rulesOf = (inputs: RuleInput[]) => inputs.map((r) => named(nextRule++, r));
  const tracks = structuredClone(POLICY_TRACKS);
  let policies: NotificationPolicy[] = [
    {
      id: 1,
      name: 'Default notifications',
      description: '',
      trackId: null,
      isDefault: true,
      rules: rulesOf(DEFAULT_RULES),
      usedBy: [{ id: 3, key: 'SHOP', name: 'Shop' }],
    },
    {
      id: 2,
      name: 'Payments',
      description: 'The team hears of new tickets; followers of comments.',
      trackId: null,
      isDefault: false,
      rules: rulesOf([
        ...PAYMENTS_RULES,
        ...(options.goneField
          ? [{ event: 'ticket_created', recipient: 'user_field' as const, fieldKey: GONE_FIELD }]
          : []),
      ]),
      usedBy: [],
    },
    {
      id: 7,
      name: 'On-call alerts',
      description: '',
      trackId: 4,
      isDefault: false,
      rules: rulesOf([{ event: 'ticket_created', recipient: 'user_field', fieldKey: 'cf[41]' }]),
      usedBy: [{ id: 4, key: 'OPS', name: 'Operations' }],
    },
  ];
  const calls: FakePoliciesClient['calls'] = [];
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  const find = (id: number) => {
    const policy = policies.find((p) => p.id === id);
    if (!policy) throw new ApiError(404, { error: 'not_found' });
    return policy;
  };
  const refuseTaken = (name: string, except?: number) => {
    if (policies.some((p) => p.id !== except && p.name.toLowerCase() === name.toLowerCase())) {
      throw new ApiError(409, { error: 'name_taken' });
    }
  };
  const answer = (policy: NotificationPolicy) => structuredClone(policy);
  const refuseGone = (rules: RuleInput[] = []) => {
    if (rules.some((r) => r.fieldKey && !FIELDS.some((f) => f.key === r.fieldKey))) {
      throw new ApiError(400, { error: 'invalid_request', detail: 'rules: fieldKey' });
    }
  };
  return {
    calls,
    stored: () => structuredClone(policies),
    track: async (id) => {
      const track = tracks.find((t) => t.id === id);
      if (!track) throw new ApiError(404, { error: 'not_found' });
      return structuredClone(track);
    },
    managedTracks: async () => structuredClone(options.runs ?? RUNS),
    policies: async (trackId) => {
      if (options.fail === 'load') throw new Error('network');
      if (options.fail === 'forbidden') throw new ApiError(403, { error: 'forbidden' });
      return policies.filter((p) => p.trackId === trackId).map(answer);
    },
    events: async (trackId) => ({
      events: [...BUILT_IN_EVENTS],
      customEvents: [
        'custom:ready-for-review',
        ...(trackId === 4 ? ['custom:handed-to-night'] : []),
      ],
    }),
    create: async (body) => {
      log('create', body);
      refuseGone(body.rules);
      refuseTaken(body.name);
      const made: NotificationPolicy = {
        id: nextPolicy++,
        name: body.name,
        description: body.description ?? '',
        trackId: body.trackId ?? null,
        isDefault: false,
        rules: rulesOf(body.rules ?? []),
        usedBy: [],
      };
      policies = [...policies, made];
      return answer(made);
    },
    update: async (id, change) => {
      log('update', id, change);
      const policy = find(id);
      refuseGone(change.rules);
      if (change.name !== undefined) refuseTaken(change.name, id);
      const next: NotificationPolicy = {
        ...policy,
        ...(change.name !== undefined ? { name: change.name } : {}),
        ...(change.description !== undefined ? { description: change.description } : {}),
        ...(change.rules ? { rules: rulesOf(change.rules) } : {}),
      };
      policies = policies.map((p) => (p.id === id ? next : p));
      return answer(next);
    },
    remove: async (id) => {
      log('remove', id);
      const policy = find(id);
      if (policy.isDefault) throw new ApiError(409, { error: 'default_policy' });
      if (policy.usedBy.length > 0) {
        throw new ApiError(409, { error: 'in_use', usedBy: policy.usedBy });
      }
      policies = policies.filter((p) => p.id !== id);
    },
    chooseFor: async (trackId, policyId) => {
      log('chooseFor', trackId, policyId);
      const track = tracks.find((t) => t.id === trackId) as ScopeTrack;
      const used = { id: track.id, key: track.key, name: track.name };
      policies = policies.map((p) => ({
        ...p,
        usedBy:
          p.id === policyId
            ? [...p.usedBy.filter((u) => u.id !== trackId), used]
            : p.usedBy.filter((u) => u.id !== trackId),
      }));
    },
    roles: async () => structuredClone(ROLES),
    groups: async () => structuredClone(options.groups ?? GROUPS),
    fields: async (track) =>
      FIELDS.filter((f) => f.trackId === null || f.trackId === track?.id).map(
        ({ key, name, type }) => ({ key, name, type }),
      ),
    findPeople: async (query) =>
      PEOPLE.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
  };
}
