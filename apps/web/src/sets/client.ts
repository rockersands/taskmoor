import { api } from '../api/client';
import { type TrackScopeClient, trackScopeClient } from './trackScope';

export interface Named {
  id: number;
  name: string;
}

/** The system fields rules govern, in form order (spec 01a section 1.5). */
export const SYSTEM_FIELDS = [
  'summary',
  'description',
  'environment',
  'assignee',
  'requester',
  'parent',
  'priority',
  'closeReason',
  'labels',
  'startDate',
  'dueDate',
  'targetRelease',
  'foundInRelease',
  'area',
  'originalEstimate',
  'remainingEstimate',
] as const;
/** Rules never make these optional or hidden. */
export const FIXED_FIELDS: ReadonlySet<string> = new Set(['summary']);

export interface TypeSet {
  id: number;
  name: string;
  description: string;
  trackId: number | null;
  defaultTypeId: number | null;
  ticketTypes: Named[];
  defaultFor: string[];
  tracks: { id: number; key: string; name: string }[];
}

export interface FieldRule {
  ticketTypeId: number | null;
  field: string;
  required: boolean;
  hidden: boolean;
  description: string | null;
  editableBy: unknown;
}

export interface RuleSetSummary {
  id: number;
  name: string;
  description: string;
  trackId: number | null;
  isDefault: boolean;
}

export interface RuleSet extends RuleSetSummary {
  usedBy: { id: number; key: string; name: string }[];
  rules: FieldRule[];
}

/** The endpoints the configuration sets page uses. Stories and tests pass their own. */
export interface SetsClient extends TrackScopeClient {
  /** Null: the shared ticket types. A track: the shared ones and the track's own. */
  ticketTypes: (trackId: number | null) => Promise<Named[]>;
  /** Null: the shared custom fields. A track: the fields that reach it, its own included. */
  customFields: (trackId: number | null) => Promise<Named[]>;
  /** Every shared type set, for site and configuration administrators. */
  typeSets: () => Promise<TypeSet[]>;
  /** One type set: how a local-mode track's administrators read the one it owns. */
  typeSet: (id: number) => Promise<TypeSet>;
  createTypeSet: (body: { name: string; ticketTypeIds: number[] }) => Promise<TypeSet>;
  updateTypeSet: (
    id: number,
    change: { name?: string; ticketTypeIds?: number[] },
  ) => Promise<TypeSet>;
  deleteTypeSet: (id: number) => Promise<void>;
  /** Null: the shared field rule sets. A track: the sets that track owns. */
  ruleSets: (trackId: number | null) => Promise<RuleSetSummary[]>;
  ruleSet: (id: number) => Promise<RuleSet>;
  /** With a track: a set that local-mode track owns. */
  createRuleSet: (body: { name: string; trackId?: number }) => Promise<RuleSet>;
  updateRuleSet: (id: number, change: { rules: FieldRule[] }) => Promise<RuleSet>;
  deleteRuleSet: (id: number) => Promise<void>;
  /** Makes a track use one of its own rule sets (`PATCH /api/v1/tracks/:id`). */
  assignRuleSet: (trackId: number, setId: number) => Promise<void>;
}

export const setsClient: SetsClient = {
  ...trackScopeClient,
  ticketTypes: async (trackId) =>
    (
      await api<{ ticketTypes: (Named & { trackId?: number | null })[] }>(
        trackId === null ? '/ticket-types' : `/ticket-types?trackId=${trackId}`,
      )
    ).ticketTypes
      .filter((t) => trackId !== null || (t.trackId ?? null) === null)
      .map((t) => ({ id: t.id, name: t.name })),
  customFields: async (trackId) =>
    (
      await api<{ fields: (Named & { trackId: number | null })[] }>(
        trackId === null ? '/fields' : `/fields?trackId=${trackId}`,
      )
    ).fields
      .filter((f) => trackId !== null || f.trackId === null)
      .map((f) => ({ id: f.id, name: f.name })),
  typeSets: async () =>
    (await api<{ typeSets: TypeSet[] }>('/type-sets')).typeSets.filter((s) => s.trackId === null),
  typeSet: async (id) => (await api<{ typeSet: TypeSet }>(`/type-sets/${id}`)).typeSet,
  createTypeSet: async (body) =>
    (await api<{ typeSet: TypeSet }>('/type-sets', { method: 'POST', body })).typeSet,
  updateTypeSet: async (id, change) =>
    (await api<{ typeSet: TypeSet }>(`/type-sets/${id}`, { method: 'PATCH', body: change }))
      .typeSet,
  deleteTypeSet: async (id) => {
    await api<unknown>(`/type-sets/${id}`, { method: 'DELETE' });
  },
  ruleSets: async (trackId) =>
    (
      await api<{ fieldRuleSets: RuleSetSummary[] }>(
        trackId === null ? '/field-rule-sets' : `/field-rule-sets?trackId=${trackId}`,
      )
    ).fieldRuleSets.filter((s) => s.trackId === trackId),
  ruleSet: async (id) =>
    (await api<{ fieldRuleSet: RuleSet }>(`/field-rule-sets/${id}`)).fieldRuleSet,
  createRuleSet: async (body) =>
    (await api<{ fieldRuleSet: RuleSet }>('/field-rule-sets', { method: 'POST', body }))
      .fieldRuleSet,
  updateRuleSet: async (id, change) =>
    (
      await api<{ fieldRuleSet: RuleSet }>(`/field-rule-sets/${id}`, {
        method: 'PATCH',
        body: change,
      })
    ).fieldRuleSet,
  deleteRuleSet: async (id) => {
    await api<unknown>(`/field-rule-sets/${id}`, { method: 'DELETE' });
  },
  assignRuleSet: async (trackId, setId) => {
    await api<unknown>(`/tracks/${trackId}`, { method: 'PATCH', body: { fieldRuleSetId: setId } });
  },
};
