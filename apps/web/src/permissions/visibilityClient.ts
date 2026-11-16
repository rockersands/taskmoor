import { api } from '../api/client';
import { everyTrack } from '../api/tracks';
import { type ScopeTrack, type TrackScopeClient, trackScopeClient } from '../sets/trackScope';
import {
  type FieldChoice,
  type Grantee,
  type Named,
  type NewGrant,
  readFieldChoices,
} from './client';

/** A member of a level, as `GET /api/v1/visibility-policies` shows it. */
export interface VisibilityMember {
  id: number;
  grantee: Grantee;
  role: Named | null;
  group: Named | null;
  user: Named | null;
  fieldKey: string | null;
}

export interface VisibilityLevel {
  id: number;
  name: string;
  description: string;
  position: number;
  members: VisibilityMember[];
}

export interface VisibilityPolicy {
  id: number;
  name: string;
  description: string;
  trackId: number | null;
  defaultLevelId: number | null;
  levels: VisibilityLevel[];
  usedBy: { id: number; key: string; name: string }[];
}

/** Who a new member is: a kind, and the role, group or person it names. */
export type NewMember = Omit<NewGrant, 'permission'>;

/**
 * The endpoints the visibility page uses. `track` is a local-mode track's own page (T-322); null
 * is the shared policies. Stories and tests pass their own.
 */
export interface VisibilityClient extends TrackScopeClient {
  policies: (trackId: number | null) => Promise<VisibilityPolicy[]>;
  createPolicy: (body: { name: string; description?: string; trackId?: number }) => Promise<void>;
  updatePolicy: (
    id: number,
    change: { name?: string; description?: string; defaultLevelId?: number | null },
  ) => Promise<void>;
  deletePolicy: (id: number) => Promise<void>;
  addLevel: (
    policyId: number,
    body: { name: string; description?: string; isDefault?: boolean },
  ) => Promise<void>;
  updateLevel: (
    policyId: number,
    levelId: number,
    change: { name?: string; description?: string; position?: number },
  ) => Promise<void>;
  /** A level tickets still use takes `replaceWith`: another level, or `none`. */
  deleteLevel: (policyId: number, levelId: number, replaceWith?: number | 'none') => Promise<void>;
  addMember: (policyId: number, levelId: number, member: NewMember) => Promise<void>;
  removeMember: (policyId: number, levelId: number, memberId: number) => Promise<void>;
  /** Makes a local-mode track use one of its own policies (`PATCH /tracks/:id`; T-322). */
  chooseFor: (trackId: number, policyId: number) => Promise<void>;
  /** The site's roles; on a track's own page, those its runners may read (T-322). */
  roles: (track: ScopeTrack | null) => Promise<Named[]>;
  /** Groups are listed for administrators only; anyone else gets none to choose from. */
  groups: () => Promise<Named[]>;
  /** People by name; on a track's own page, the people who may be named in it (T-322). */
  findPeople: (query: string, track: ScopeTrack | null) => Promise<Named[]>;
  /** The user and group fields field members name (T-320), a track's own too (T-322). */
  fields: (track: ScopeTrack | null) => Promise<FieldChoice[]>;
}

const path = (policyId: number, rest = '') => `/visibility-policies/${policyId}${rest}`;

/** A track's own policies and fields, by its id; nothing for the shared ones. */
const own = (trackId: number | null) => (trackId === null ? '' : `?trackId=${trackId}`);

export const visibilityClient: VisibilityClient = {
  ...trackScopeClient,
  policies: async (trackId) =>
    (await api<{ visibilityPolicies: VisibilityPolicy[] }>(`/visibility-policies${own(trackId)}`))
      .visibilityPolicies,
  createPolicy: async (body) => {
    await api<unknown>('/visibility-policies', { method: 'POST', body });
  },
  updatePolicy: async (id, change) => {
    await api<unknown>(path(id), { method: 'PATCH', body: change });
  },
  deletePolicy: async (id) => {
    await api<unknown>(path(id), { method: 'DELETE' });
  },
  addLevel: async (policyId, body) => {
    await api<unknown>(path(policyId, '/levels'), { method: 'POST', body });
  },
  updateLevel: async (policyId, levelId, change) => {
    await api<unknown>(path(policyId, `/levels/${levelId}`), { method: 'PATCH', body: change });
  },
  deleteLevel: async (policyId, levelId, replaceWith) => {
    const query = replaceWith === undefined ? '' : `?replaceWith=${replaceWith}`;
    await api<unknown>(path(policyId, `/levels/${levelId}${query}`), { method: 'DELETE' });
  },
  addMember: async (policyId, levelId, member) => {
    await api<unknown>(path(policyId, `/levels/${levelId}/members`), {
      method: 'POST',
      body: member,
    });
  },
  removeMember: async (policyId, levelId, memberId) => {
    await api<unknown>(path(policyId, `/levels/${levelId}/members/${memberId}`), {
      method: 'DELETE',
    });
  },
  chooseFor: async (trackId, policyId) => {
    await api<unknown>(`/tracks/${trackId}`, {
      method: 'PATCH',
      body: { visibilityPolicyId: policyId },
    });
  },
  roles: async (track) =>
    (
      await api<{ roles: Named[] }>(track === null ? '/roles' : `/tracks/${track.id}/roles`)
    ).roles.map((r) => ({ id: r.id, name: r.name })),
  groups: async () => {
    try {
      return (await api<{ groups: Named[] }>('/groups')).groups;
    } catch {
      return [];
    }
  },
  findPeople: async (query, track) => {
    const q = encodeURIComponent(query);
    const path =
      track === null
        ? `/people/lookup?limit=8&q=${q}`
        : `/people/mentionable?track=${encodeURIComponent(track.key)}&limit=8&q=${q}`;
    return (await api<{ people: Named[] }>(path)).people;
  },
  // A track's own policy names the shared fields and the track's own (T-322).
  fields: async (track) => {
    if (track === null) return readFieldChoices();
    const { fields } = await api<{
      fields: { id: number; name: string; type: string; trackId: number | null }[];
    }>(`/fields${own(track.id)}`);
    return fields.flatMap((f) =>
      (f.type === 'user' || f.type === 'group') && (f.trackId === null || f.trackId === track.id)
        ? [{ key: `cf[${f.id}]`, name: f.name, type: f.type, trackId: f.trackId }]
        : [],
    );
  },
};

/** One reason a person holds a permission. */
export type ExplainReason =
  | { kind: 'site_admin' }
  | { kind: 'configuration_admin' }
  | { kind: 'grant'; grantId: number; grantee: string; roleName?: string; groupName?: string };

/** `GET /api/v1/permissions/explain`: why someone can or cannot do something (IAM-012). */
export interface Explanation {
  allowed: boolean;
  trackArchived: boolean;
  trackInTrash: boolean;
  reasons: ExplainReason[];
  ticketLevel: { grantId: number; grantee: string; fieldKey: string | null }[];
  ticket?: {
    id: number;
    key: string;
    visibilityLevel: {
      id: number;
      name: string;
      member: boolean;
      matched: { grantee: string }[];
    } | null;
    ticketGrants: { grantee: string; field_key: string | null }[];
  };
}

export interface ExplainQuestion {
  /** Left out for an anonymous visitor. */
  userId?: number;
  trackId?: number;
  ticket?: string;
  permission: string;
}

/** The endpoints the permission explainer uses. Stories and tests pass their own. */
export interface ExplainClient {
  catalogue: () => Promise<Record<string, string[]>>;
  tracks: () => Promise<{ id: number; key: string; name: string }[]>;
  findPeople: (query: string) => Promise<Named[]>;
  explain: (question: ExplainQuestion) => Promise<Explanation>;
}

export const explainClient: ExplainClient = {
  catalogue: async () =>
    (await api<{ track: Record<string, string[]> }>('/permissions/catalogue')).track,
  tracks: () => everyTrack<{ id: number; key: string; name: string }>(),
  findPeople: (query) => visibilityClient.findPeople(query, null),
  explain: (question) => {
    const query = new URLSearchParams({ permission: question.permission });
    if (question.userId !== undefined) query.set('userId', String(question.userId));
    if (question.trackId !== undefined) query.set('trackId', String(question.trackId));
    if (question.ticket) query.set('ticket', question.ticket);
    return api<Explanation>(`/permissions/explain?${query}`);
  },
};
