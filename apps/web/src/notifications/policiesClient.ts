import { api } from '../api/client';
import { type ScopeTrack, type TrackScopeClient, trackScopeClient } from '../sets/trackScope';

/** Who a rule reaches (spec 01c section 3), as `GET /api/v1/notification-events` lists them. */
export type Recipient =
  | 'assignee'
  | 'requester'
  | 'follower'
  | 'area_owner'
  | 'track_owner'
  | 'user'
  | 'group'
  | 'role'
  | 'user_field'
  | 'group_field'
  | 'current_user';

/** The recipient types in the order the page offers them: the ticket's people first. */
export const RECIPIENTS: readonly Recipient[] = [
  'assignee',
  'requester',
  'follower',
  'area_owner',
  'track_owner',
  'user',
  'group',
  'role',
  'user_field',
  'group_field',
  'current_user',
];

/** A rule of a policy, with the name of the person, group, role or field it points at. */
export interface PolicyRule {
  id: number;
  event: string;
  recipient: Recipient;
  userId: number | null;
  groupId: number | null;
  roleId: number | null;
  fieldKey: string | null;
  userName: string | null;
  groupName: string | null;
  roleName: string | null;
  fieldName: string | null;
}

/** A notification policy (NTF-001), as `GET /api/v1/notification-policies` gives it. */
export interface NotificationPolicy {
  id: number;
  name: string;
  description: string;
  /** The local-mode track that owns it; null for a shared policy. */
  trackId: number | null;
  isDefault: boolean;
  rules: PolicyRule[];
  /** The tracks it serves; for the default, also those that name no policy. */
  usedBy: { id: number; key: string; name: string }[];
}

/** A rule as a save sends it: what its recipient type needs, and nothing else. */
export interface RuleInput {
  event: string;
  recipient: Recipient;
  userId?: number;
  groupId?: number;
  roleId?: number;
  fieldKey?: string;
}

/** The events a policy can name: the built-in ones, and those transitions fire. */
export interface PolicyEvents {
  events: string[];
  /** `custom:<name>`: the events of published transitions, for those who make policies. */
  customEvents: string[];
}

export interface Choice {
  id: number;
  name: string;
}

/** A user or group field a rule can name, as `cf[<id>]`. */
export interface FieldChoice {
  key: string;
  name: string;
  type: 'user' | 'group';
}

/**
 * The endpoints the notification policies page uses (NTF-001). `track` is a local-mode track's
 * own page; null is the shared policies. Stories and tests pass their own.
 */
export interface PoliciesClient extends TrackScopeClient {
  policies: (trackId: number | null) => Promise<NotificationPolicy[]>;
  events: (trackId: number | null) => Promise<PolicyEvents>;
  create: (body: {
    name: string;
    description?: string;
    trackId?: number;
    rules?: RuleInput[];
  }) => Promise<NotificationPolicy>;
  update: (
    id: number,
    change: { name?: string; description?: string; rules?: RuleInput[] },
  ) => Promise<NotificationPolicy>;
  remove: (id: number) => Promise<void>;
  /** Makes a track use one of its own policies (`PATCH /tracks/:id`). */
  chooseFor: (trackId: number, policyId: number) => Promise<void>;
  roles: (track: ScopeTrack | null) => Promise<Choice[]>;
  /** Groups are listed for administrators only; anyone else gets none to choose from. */
  groups: () => Promise<Choice[]>;
  fields: (track: ScopeTrack | null) => Promise<FieldChoice[]>;
  findPeople: (query: string, track: ScopeTrack | null) => Promise<Choice[]>;
}

/** A rule as the server takes it back: the reference its recipient type needs. */
export function ruleInput(rule: PolicyRule): RuleInput {
  return {
    event: rule.event,
    recipient: rule.recipient,
    ...(rule.userId !== null ? { userId: rule.userId } : {}),
    ...(rule.groupId !== null ? { groupId: rule.groupId } : {}),
    ...(rule.roleId !== null ? { roleId: rule.roleId } : {}),
    ...(rule.fieldKey !== null ? { fieldKey: rule.fieldKey } : {}),
  };
}

const own = (trackId: number | null) => (trackId === null ? '' : `?trackId=${trackId}`);

export const policiesClient: PoliciesClient = {
  ...trackScopeClient,
  policies: async (trackId) =>
    (
      await api<{ notificationPolicies: NotificationPolicy[] }>(
        `/notification-policies${own(trackId)}`,
      )
    ).notificationPolicies,
  events: async (trackId) => {
    const answer = await api<{ events: string[]; customEvents?: string[] }>(
      `/notification-events${own(trackId)}`,
    );
    return { events: answer.events, customEvents: answer.customEvents ?? [] };
  },
  create: async (body) =>
    (
      await api<{ notificationPolicy: NotificationPolicy }>('/notification-policies', {
        method: 'POST',
        body,
      })
    ).notificationPolicy,
  update: async (id, change) =>
    (
      await api<{ notificationPolicy: NotificationPolicy }>(`/notification-policies/${id}`, {
        method: 'PATCH',
        body: change,
      })
    ).notificationPolicy,
  remove: async (id) => {
    await api<unknown>(`/notification-policies/${id}`, { method: 'DELETE' });
  },
  chooseFor: async (trackId, policyId) => {
    await api<unknown>(`/tracks/${trackId}`, {
      method: 'PATCH',
      body: { notificationPolicyId: policyId },
    });
  },
  roles: async (track) =>
    track === null
      ? (await api<{ roles: Choice[] }>('/roles')).roles
      : (await api<{ roles: Choice[] }>(`/tracks/${track.id}/roles`)).roles,
  groups: async () => {
    try {
      return (await api<{ groups: Choice[] }>('/groups')).groups;
    } catch {
      return [];
    }
  },
  fields: async (track) => {
    const { fields } = await api<{
      fields: { id: number; name: string; type: string; trackId: number | null }[];
    }>(`/fields${own(track?.id ?? null)}`);
    return fields.flatMap((f) =>
      // A shared policy names shared fields; a track's own, its own fields too.
      (f.type === 'user' || f.type === 'group') && (f.trackId === null || f.trackId === track?.id)
        ? [{ key: `cf[${f.id}]`, name: f.name, type: f.type }]
        : [],
    );
  },
  findPeople: async (query, track) => {
    const q = encodeURIComponent(query);
    const path =
      track === null
        ? `/people/lookup?limit=8&q=${q}`
        : `/people/mentionable?track=${encodeURIComponent(track.key)}&limit=8&q=${q}`;
    return (await api<{ people: Choice[] }>(path)).people;
  },
};
