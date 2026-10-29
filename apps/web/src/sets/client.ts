import { api } from '../api/client';

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
export interface SetsClient {
  ticketTypes: () => Promise<Named[]>;
  customFields: () => Promise<Named[]>;
  typeSets: () => Promise<TypeSet[]>;
  createTypeSet: (body: { name: string; ticketTypeIds: number[] }) => Promise<TypeSet>;
  updateTypeSet: (
    id: number,
    change: { name?: string; ticketTypeIds?: number[] },
  ) => Promise<TypeSet>;
  deleteTypeSet: (id: number) => Promise<void>;
  ruleSets: () => Promise<RuleSetSummary[]>;
  ruleSet: (id: number) => Promise<RuleSet>;
  createRuleSet: (body: { name: string }) => Promise<RuleSet>;
  updateRuleSet: (id: number, change: { rules: FieldRule[] }) => Promise<RuleSet>;
  deleteRuleSet: (id: number) => Promise<void>;
}

export const setsClient: SetsClient = {
  ticketTypes: async () =>
    (
      await api<{ ticketTypes: (Named & { trackId?: number | null })[] }>('/ticket-types')
    ).ticketTypes
      .filter((t) => (t.trackId ?? null) === null)
      .map((t) => ({ id: t.id, name: t.name })),
  customFields: async () =>
    (await api<{ fields: (Named & { trackId: number | null })[] }>('/fields')).fields
      .filter((f) => f.trackId === null)
      .map((f) => ({ id: f.id, name: f.name })),
  typeSets: async () =>
    (await api<{ typeSets: TypeSet[] }>('/type-sets')).typeSets.filter((s) => s.trackId === null),
  createTypeSet: async (body) =>
    (await api<{ typeSet: TypeSet }>('/type-sets', { method: 'POST', body })).typeSet,
  updateTypeSet: async (id, change) =>
    (await api<{ typeSet: TypeSet }>(`/type-sets/${id}`, { method: 'PATCH', body: change }))
      .typeSet,
  deleteTypeSet: async (id) => {
    await api<unknown>(`/type-sets/${id}`, { method: 'DELETE' });
  },
  ruleSets: async () =>
    (await api<{ fieldRuleSets: RuleSetSummary[] }>('/field-rule-sets')).fieldRuleSets.filter(
      (s) => s.trackId === null,
    ),
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
};
