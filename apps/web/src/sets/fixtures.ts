import { ApiError } from '../api/client';
import type { Named, RuleSet, SetsClient, TypeSet } from './client';

export interface FakeSetsClient extends SetsClient {
  calls: { action: string; args: unknown[] }[];
}

const TYPES: Named[] = [
  { id: 5, name: 'Bug' },
  { id: 6, name: 'Task' },
  { id: 7, name: 'Story' },
];
const FIELDS: Named[] = [{ id: 40, name: 'Customer' }];

/**
 * An in-memory backend for stories and tests: it answers as the API would. The default sets
 * are used by SHOP and are not deleted; the default rule set holds a rule for bugs only.
 */
export function fakeSetsClient(): FakeSetsClient {
  let typeSets: TypeSet[] = [
    {
      id: 1,
      name: 'Software types',
      description: '',
      trackId: null,
      defaultTypeId: 6,
      ticketTypes: TYPES,
      defaultFor: ['software'],
      tracks: [{ id: 3, key: 'SHOP', name: 'Shop' }],
    },
  ];
  let ruleSets: RuleSet[] = [
    {
      id: 10,
      name: 'Default field rules',
      description: '',
      trackId: null,
      isDefault: true,
      usedBy: [{ id: 3, key: 'SHOP', name: 'Shop' }],
      rules: [
        {
          ticketTypeId: null,
          field: 'description',
          required: false,
          hidden: false,
          description: 'What happened, and what you expected',
          editableBy: null,
        },
        {
          ticketTypeId: 5,
          field: 'environment',
          required: true,
          hidden: false,
          description: null,
          editableBy: null,
        },
      ],
    },
  ];
  let next = 100;
  const calls: FakeSetsClient['calls'] = [];
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  const named = (ids: number[]) => TYPES.filter((type) => ids.includes(type.id));
  return {
    calls,
    ticketTypes: async () => structuredClone(TYPES),
    customFields: async () => structuredClone(FIELDS),
    typeSets: async () => structuredClone(typeSets),
    createTypeSet: async (body) => {
      log('createTypeSet', body);
      const made: TypeSet = {
        id: ++next,
        name: body.name,
        description: '',
        trackId: null,
        defaultTypeId: null,
        ticketTypes: named(body.ticketTypeIds),
        defaultFor: [],
        tracks: [],
      };
      typeSets = [...typeSets, made];
      return structuredClone(made);
    },
    updateTypeSet: async (id, change) => {
      log('updateTypeSet', id, change);
      const set = typeSets.find((s) => s.id === id) as TypeSet;
      if (change.ticketTypeIds) set.ticketTypes = named(change.ticketTypeIds);
      return structuredClone(set);
    },
    deleteTypeSet: async (id) => {
      log('deleteTypeSet', id);
      const set = typeSets.find((s) => s.id === id) as TypeSet;
      if (set.tracks.length > 0) throw new ApiError(409, { error: 'in_use', trackCount: 1 });
      typeSets = typeSets.filter((s) => s.id !== id);
    },
    ruleSets: async () =>
      ruleSets.map(({ id, name, description, trackId, isDefault }) => ({
        id,
        name,
        description,
        trackId,
        isDefault,
      })),
    ruleSet: async (id) => structuredClone(ruleSets.find((s) => s.id === id) as RuleSet),
    createRuleSet: async (body) => {
      log('createRuleSet', body);
      const made: RuleSet = {
        id: ++next,
        name: body.name,
        description: '',
        trackId: null,
        isDefault: false,
        usedBy: [],
        rules: [],
      };
      ruleSets = [...ruleSets, made];
      return structuredClone(made);
    },
    updateRuleSet: async (id, change) => {
      log('updateRuleSet', id, change);
      const set = ruleSets.find((s) => s.id === id) as RuleSet;
      set.rules = structuredClone(change.rules);
      return structuredClone(set);
    },
    deleteRuleSet: async (id) => {
      log('deleteRuleSet', id);
      ruleSets = ruleSets.filter((s) => s.id !== id);
    },
  };
}
