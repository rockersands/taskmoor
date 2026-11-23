import { ApiError } from '../api/client';
import type { Level, TicketType } from '../tickettypes/client';
import type { Named, RuleSet, SetsClient, TypeChoice, TypeSet } from './client';
import type { RunTrack, ScopeTrack } from './trackScope';

export interface FakeSetsClient extends SetsClient {
  calls: { action: string; args: unknown[] }[];
}

type Owned = Named & { trackId: number | null };
/** The three built-in levels, top first. */
const LEVELS: Level[] = [
  { id: 3, kind: 'outcome', rank: 1, name: 'Outcome', description: '' },
  { id: 2, kind: 'standard', rank: 0, name: 'Standard', description: '' },
  { id: 1, kind: 'subticket', rank: -1, name: 'Subticket', description: '' },
];
const STANDARD = { id: 2, name: 'Standard' };
type FakeType = TypeChoice & Owned & { description: string; icon: string | null };
const TYPES: FakeType[] = [
  { id: 5, name: 'Bug', trackId: null, level: STANDARD, description: '', icon: null },
  { id: 6, name: 'Task', trackId: null, level: STANDARD, description: '', icon: null },
  { id: 7, name: 'Story', trackId: null, level: STANDARD, description: '', icon: null },
  {
    id: 9,
    name: 'Runbook',
    trackId: 4,
    level: STANDARD,
    description: 'What to do when an alarm goes off.',
    icon: 'chore',
  },
];
/** Tickets per type in each track: SHOP has bugs and tasks, OPS runbooks. */
const TICKETS: Readonly<Record<number, Readonly<Record<number, number>>>> = {
  3: { 5: 7, 6: 2 },
  4: { 9: 3 },
};
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
 * owns a type set and an unused rule set; LAB owns a type set and the rule set it uses. SHOP has
 * seven bugs and two tasks, so its type set drops neither without saying where their tickets go.
 * OPS owns the ticket type Runbook (T-322), which its type set holds and three tickets have.
 */
export function fakeSetsClient(options: { runs?: RunTrack[] } = {}): FakeSetsClient {
  const tracks = structuredClone(SETS_TRACKS);
  let types = structuredClone(TYPES);
  const typeView = (type: FakeType): TicketType => {
    const level = LEVELS.find((l) => l.id === type.level.id) as Level;
    return {
      id: type.id,
      name: type.name,
      description: type.description,
      icon: type.icon,
      level: { id: level.id, rank: level.rank, name: level.name },
      trackId: type.trackId,
    };
  };
  const findType = (id: number) => {
    const type = types.find((t) => t.id === id);
    if (!type) throw new ApiError(404, { error: 'not_found' });
    return type;
  };
  const nameTaken = (name: string, trackId: number | null, id?: number) =>
    types.some(
      (t) => t.id !== id && t.trackId === trackId && t.name.toLowerCase() === name.toLowerCase(),
    );
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
      ticketTypes: types.filter((type) => type.trackId === null).map(named),
      defaultFor: ['software'],
      tracks: [{ id: 3, key: 'SHOP', name: 'Shop' }],
    },
    {
      id: 30,
      name: 'Operations types',
      description: '',
      trackId: 4,
      defaultTypeId: 5,
      ticketTypes: [types[0], types[3]].map((type) => named(type as Owned)),
      defaultFor: [],
      tracks: own(4),
    },
    {
      id: 31,
      name: 'Lab types',
      description: '',
      trackId: 6,
      defaultTypeId: 6,
      ticketTypes: [named(types[1] as Owned)],
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
  // In the order asked for, as the set keeps them.
  const typesOf = (ids: number[]) =>
    ids.map((id) => named(types.find((type) => type.id === id) as Owned));
  /** A set as read: its types under the names they have now. */
  const fresh = (set: TypeSet): TypeSet =>
    structuredClone({ ...set, ticketTypes: typesOf(set.ticketTypes.map((type) => type.id)) });
  const reaches = (trackId: number | null) => (item: Owned) =>
    item.trackId === null || item.trackId === trackId;
  /** A kind of track has one default set: a set that takes it over takes it from the others. */
  const takeDefaults = (setId: number, kinds: string[]) => {
    for (const other of typeSets) {
      if (other.id !== setId) other.defaultFor = other.defaultFor.filter((k) => !kinds.includes(k));
    }
  };
  return {
    calls,
    ticketTypes: async (trackId) =>
      types.filter(reaches(trackId)).map(({ id, name, level }) => ({ id, name, level })),
    customFields: async (trackId) => FIELDS.filter(reaches(trackId)).map(named),
    typeSets: async () => typeSets.filter((s) => s.trackId === null).map(fresh),
    typeSet: async (id) => {
      const set = typeSets.find((s) => s.id === id);
      if (!set) throw new ApiError(404, { error: 'not_found' });
      return fresh(set);
    },
    createTypeSet: async (body) => {
      log('createTypeSet', body);
      const made: TypeSet = {
        id: ++next,
        name: body.name,
        description: '',
        trackId: null,
        defaultTypeId: body.defaultTypeId ?? null,
        ticketTypes: typesOf(body.ticketTypeIds),
        defaultFor: body.defaultFor ?? [],
        tracks: [],
      };
      takeDefaults(made.id, made.defaultFor);
      typeSets = [...typeSets, made];
      return structuredClone(made);
    },
    updateTypeSet: async (id, change) => {
      log('updateTypeSet', id, change);
      const set = typeSets.find((s) => s.id === id) as TypeSet;
      const kept = change.ticketTypeIds ?? set.ticketTypes.map((type) => type.id);
      const defaultTypeId =
        change.defaultTypeId !== undefined ? change.defaultTypeId : set.defaultTypeId;
      if (defaultTypeId !== null && !kept.includes(defaultTypeId)) {
        throw new ApiError(400, { error: 'invalid_request', detail: 'defaultTypeId' });
      }
      if (change.defaultFor && set.defaultFor.some((k) => !change.defaultFor?.includes(k))) {
        throw new ApiError(409, { error: 'default_required' });
      }
      // Tickets of a dropped type take the type the mapping names, or the change waits.
      const dropped = set.ticketTypes.map((type) => type.id).filter((t) => !kept.includes(t));
      const counts = (typeId: number) =>
        set.tracks.reduce((n, track) => n + (TICKETS[track.id]?.[typeId] ?? 0), 0);
      const unmapped = dropped.filter(
        (t) => counts(t) > 0 && change.ticketTypeMapping?.[String(t)] === undefined,
      );
      if (unmapped.length > 0) {
        throw new ApiError(409, {
          error: 'type_in_use',
          ticketTypeIds: unmapped,
          ticketCount: unmapped.reduce((n, t) => n + counts(t), 0),
        });
      }
      for (const [from, to] of Object.entries(change.ticketTypeMapping ?? {})) {
        const level = (typeId: number) => types.find((type) => type.id === typeId)?.level.id;
        if (!kept.includes(to) || level(to) !== level(Number(from))) {
          throw new ApiError(400, {
            error: 'invalid_mapping',
            fromTypeId: Number(from),
            toTypeId: to,
            problem: kept.includes(to) ? 'other_level' : 'not_kept',
          });
        }
      }
      set.ticketTypes = typesOf(kept);
      set.defaultTypeId = defaultTypeId;
      if (change.defaultFor) {
        takeDefaults(id, change.defaultFor);
        set.defaultFor = [...change.defaultFor];
      }
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
    levels: async () => structuredClone(LEVELS),
    ownTypes: async (trackId) => types.filter((t) => t.trackId === trackId).map(typeView),
    createType: async (body) => {
      log('createType', body);
      if (nameTaken(body.name, body.trackId)) throw new ApiError(409, { error: 'name_taken' });
      const level = LEVELS.find((l) => l.id === body.levelId);
      if (!level) throw new ApiError(400, { error: 'invalid_request', detail: 'levelId' });
      const made: FakeType = {
        id: ++next,
        name: body.name,
        trackId: body.trackId,
        level: { id: level.id, name: level.name },
        description: body.description ?? '',
        icon: body.icon ?? null,
      };
      types = [...types, made];
      return typeView(made);
    },
    updateType: async (id, change) => {
      log('updateType', id, change);
      const type = findType(id);
      if (change.name !== undefined && nameTaken(change.name, type.trackId, id)) {
        throw new ApiError(409, { error: 'name_taken' });
      }
      if (change.name !== undefined) type.name = change.name;
      if (change.description !== undefined) type.description = change.description;
      if (change.icon !== undefined) type.icon = change.icon;
      if (change.levelId !== undefined) {
        const level = LEVELS.find((l) => l.id === change.levelId) as Level;
        type.level = { id: level.id, name: level.name };
      }
      return typeView(type);
    },
    deleteType: async (id) => {
      log('deleteType', id);
      const type = findType(id);
      const holding = typeSets.filter((s) => s.ticketTypes.some((member) => member.id === id));
      if (holding.length > 0) {
        throw new ApiError(409, {
          error: 'in_type_sets',
          typeSets: holding.map(({ id: setId, name }) => ({ id: setId, name })),
        });
      }
      const tickets = tracks.reduce((n, track) => n + (TICKETS[track.id]?.[id] ?? 0), 0);
      if (tickets > 0) throw new ApiError(409, { error: 'has_tickets', ticketCount: tickets });
      types = types.filter((t) => t !== type);
    },
  };
}
