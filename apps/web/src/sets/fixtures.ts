import { ApiError } from '../api/client';
import type { Named, RuleSet, SetsClient, TypeSet } from './client';
import type { RunTrack, ScopeTrack } from './trackScope';

export interface FakeSetsClient extends SetsClient {
  calls: { action: string; args: unknown[] }[];
}

type Owned = Named & { trackId: number | null };
const TYPES: Owned[] = [
  { id: 5, name: 'Bug', trackId: null },
  { id: 6, name: 'Task', trackId: null },
  { id: 7, name: 'Story', trackId: null },
  { id: 9, name: 'Runbook', trackId: 4 },
];
const FIELDS: Owned[] = [
  { id: 40, name: 'Customer', trackId: null },
  { id: 41, name: 'Ops notes', trackId: 4 },
];
const named = ({ id, name }: Named): Named => ({ id, name });

/**
 * SHOP is in shared mode; OPS and LAB have their own configuration, each its own type set and
 * rule sets. The person of the track administrator's stories runs SHOP and OPS, not LAB.
 */
export const SETS_TRACKS: ScopeTrack[] = [
  {
    id: 3,
    key: 'SHOP',
    name: 'Shop',
    mode: 'shared',
    archived: false,
    typeSetId: 1,
    fieldRuleSetId: 10,
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
  {
    id: 6,
    key: 'LAB',
    name: 'Lab',
    mode: 'local',
    archived: false,
    typeSetId: 31,
    fieldRuleSetId: 12,
    layoutSetId: null,
  },
];
const RUNS: RunTrack[] = SETS_TRACKS.filter((t) => t.key !== 'LAB').map(
  ({ id, key, name, mode }) => ({ id, key, name, mode }),
);

/**
 * An in-memory backend for stories and tests: it answers as the API would. The default sets
 * are used by SHOP and are not deleted; the default rule set holds a rule for bugs only. OPS
 * owns a type set and an unused rule set; LAB owns a type set and the rule set it uses.
 */
export function fakeSetsClient(options: { runs?: RunTrack[] } = {}): FakeSetsClient {
  const tracks = structuredClone(SETS_TRACKS);
  const own = (trackId: number) => {
    const track = tracks.find((t) => t.id === trackId) as ScopeTrack;
    return [{ id: track.id, key: track.key, name: track.name }];
  };
  let typeSets: TypeSet[] = [
    {
      id: 1,
      name: 'Software types',
      description: '',
      trackId: null,
      defaultTypeId: 6,
      ticketTypes: TYPES.filter((type) => type.trackId === null).map(named),
      defaultFor: ['software'],
      tracks: [{ id: 3, key: 'SHOP', name: 'Shop' }],
    },
    {
      id: 30,
      name: 'Operations types',
      description: '',
      trackId: 4,
      defaultTypeId: 5,
      ticketTypes: [TYPES[0], TYPES[3]].map((type) => named(type as Owned)),
      defaultFor: [],
      tracks: own(4),
    },
    {
      id: 31,
      name: 'Lab types',
      description: '',
      trackId: 6,
      defaultTypeId: 6,
      ticketTypes: [named(TYPES[1] as Owned)],
      defaultFor: [],
      tracks: own(6),
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
    {
      id: 11,
      name: 'Ops rules',
      description: '',
      trackId: 4,
      isDefault: false,
      usedBy: [],
      rules: [],
    },
    {
      id: 12,
      name: 'Lab rules',
      description: '',
      trackId: 6,
      isDefault: false,
      usedBy: own(6),
      rules: [],
    },
  ];
  let next = 100;
  const calls: FakeSetsClient['calls'] = [];
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  const typesOf = (ids: number[]) => TYPES.filter((type) => ids.includes(type.id)).map(named);
  const reaches = (trackId: number | null) => (item: Owned) =>
    item.trackId === null || item.trackId === trackId;
  return {
    calls,
    ticketTypes: async (trackId) => TYPES.filter(reaches(trackId)).map(named),
    customFields: async (trackId) => FIELDS.filter(reaches(trackId)).map(named),
    typeSets: async () => structuredClone(typeSets.filter((s) => s.trackId === null)),
    typeSet: async (id) => {
      const set = typeSets.find((s) => s.id === id);
      if (!set) throw new ApiError(404, { error: 'not_found' });
      return structuredClone(set);
    },
    createTypeSet: async (body) => {
      log('createTypeSet', body);
      const made: TypeSet = {
        id: ++next,
        name: body.name,
        description: '',
        trackId: null,
        defaultTypeId: null,
        ticketTypes: typesOf(body.ticketTypeIds),
        defaultFor: [],
        tracks: [],
      };
      typeSets = [...typeSets, made];
      return structuredClone(made);
    },
    updateTypeSet: async (id, change) => {
      log('updateTypeSet', id, change);
      const set = typeSets.find((s) => s.id === id) as TypeSet;
      if (change.ticketTypeIds) set.ticketTypes = typesOf(change.ticketTypeIds);
      return structuredClone(set);
    },
    deleteTypeSet: async (id) => {
      log('deleteTypeSet', id);
      const set = typeSets.find((s) => s.id === id) as TypeSet;
      if (set.tracks.length > 0) throw new ApiError(409, { error: 'in_use', trackCount: 1 });
      typeSets = typeSets.filter((s) => s.id !== id);
    },
    ruleSets: async (owner) =>
      ruleSets
        .filter((s) => s.trackId === owner)
        .map(({ id, name, description, trackId, isDefault }) => ({
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
        trackId: body.trackId ?? null,
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
    assignRuleSet: async (trackId, setId) => {
      log('assignRuleSet', trackId, setId);
      const track = tracks.find((t) => t.id === trackId) as ScopeTrack;
      track.fieldRuleSetId = setId;
      for (const set of ruleSets) {
        set.usedBy = set.usedBy.filter((u) => u.id !== trackId);
        if (set.id === setId) set.usedBy.push(...own(trackId));
      }
    },
    track: async (id) => {
      const track = tracks.find((t) => t.id === id);
      if (!track) throw new ApiError(404, { error: 'not_found' });
      return structuredClone(track);
    },
    managedTracks: async () => structuredClone(options.runs ?? RUNS),
  };
}
