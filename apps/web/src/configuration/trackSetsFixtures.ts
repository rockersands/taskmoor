import { ApiError } from '../api/client';
import type { TypeChoice } from '../sets/client';
import type {
  SetChange,
  SetChoices,
  TrackSetsClient,
  TrackTypeSet,
  TrackWithSets,
} from './trackSetsClient';

export const TRACKS: TrackWithSets[] = [
  {
    id: 3,
    key: 'SHOP',
    name: 'Shop',
    mode: 'shared',
    accessPolicyId: 60,
    typeSetId: 50,
    layoutSetId: null,
    prioritySetId: 21,
    visibilityPolicyId: null,
    notificationPolicyId: null,
  },
  {
    id: 4,
    key: 'OPS',
    name: 'Operations',
    mode: 'local',
    accessPolicyId: 61,
    typeSetId: 53,
    layoutSetId: 12,
    prioritySetId: null,
    visibilityPolicyId: 31,
    notificationPolicyId: 41,
  },
];

const STANDARD = { id: 2, name: 'Standard' };
const OUTCOME = { id: 3, name: 'Outcome' };

/** The shared ticket types: four at the standard level, two at the outcome level. */
export const TICKET_TYPES: TypeChoice[] = [
  { id: 5, name: 'Bug', level: STANDARD },
  { id: 6, name: 'Task', level: STANDARD },
  { id: 7, name: 'Story', level: STANDARD },
  { id: 8, name: 'Epic', level: OUTCOME },
  { id: 9, name: 'Request', level: STANDARD },
  { id: 10, name: 'Initiative', level: OUTCOME },
];

/**
 * The shared type sets: SHOP uses Software types. Support types has no outcome-level type, so
 * SHOP's epics have nowhere to go there; Product types keeps a type at each of SHOP's levels.
 */
export const TYPE_SETS: TrackTypeSet[] = [
  { id: 50, name: 'Software types', ticketTypeIds: [5, 6, 7, 8] },
  { id: 51, name: 'Support types', ticketTypeIds: [6, 9] },
  { id: 52, name: 'Product types', ticketTypeIds: [6, 7, 10] },
];

const shared: SetChoices = {
  layoutSets: [{ id: 11, name: 'Default layouts', isDefault: true, trackId: null }],
  prioritySets: [
    { id: 20, name: 'Default priority set', isDefault: true },
    { id: 21, name: 'Support priorities' },
  ],
  visibilityPolicies: [{ id: 30, name: 'Company levels', trackId: null }],
  notificationPolicies: [{ id: 40, name: 'Default notifications', trackId: null }],
  accessPolicies: [
    { id: 60, name: 'Default access policy', isDefault: true },
    { id: 62, name: 'Contractors' },
  ],
  typeSets: TYPE_SETS,
  ticketTypes: TICKET_TYPES,
};

/** SHOP's tickets by type: three bugs, two tasks and an epic. */
const SHOP_TICKETS: Record<number, number> = { 5: 3, 6: 2, 8: 1 };

/**
 * Tracks and their choices in memory; OPS is local-mode, with sets of its own. A switch of SHOP's
 * type set is refused as the server refuses it: `type_in_use` while tickets have a type the new
 * set lacks and no mapping names it, `invalid_mapping` for a type of another level or not kept.
 */
export function fakeTrackSetsClient(
  tracks: TrackWithSets[] = TRACKS,
): TrackSetsClient & { saved: { trackId: number; change: SetChange }[] } {
  const saved: { trackId: number; change: SetChange }[] = [];
  const held = structuredClone(tracks);
  const tickets: Record<number, Record<number, number>> = { 3: { ...SHOP_TICKETS } };
  const levelOf = (typeId: number) => TICKET_TYPES.find((t) => t.id === typeId)?.level.id;
  const typesOf = (setId: number | null) =>
    TYPE_SETS.find((s) => s.id === setId)?.ticketTypeIds ?? [];
  /** The refusal of a switch of type set, or the tickets it moves. */
  const switchTypes = (track: TrackWithSets, change: SetChange) => {
    if (change.typeSetId === undefined || change.typeSetId === track.typeSetId) {
      if (change.ticketTypeMapping) throw new ApiError(400, { error: 'invalid_request' });
      return;
    }
    const kept = typesOf(change.typeSetId);
    const removed = typesOf(track.typeSetId).filter((t) => !kept.includes(t));
    const mapping = change.ticketTypeMapping ?? {};
    const counts = tickets[track.id] ?? {};
    const inUse = removed.filter((t) => (counts[t] ?? 0) > 0);
    const unmapped = inUse.filter((t) => mapping[String(t)] === undefined);
    for (const [from, to] of Object.entries(mapping)) {
      const problem = !removed.includes(Number(from))
        ? 'not_removed'
        : !kept.includes(to)
          ? 'not_kept'
          : levelOf(to) !== levelOf(Number(from))
            ? 'other_level'
            : null;
      if (problem) {
        throw new ApiError(400, {
          error: 'invalid_mapping',
          fromTypeId: Number(from),
          toTypeId: to,
          problem,
        });
      }
    }
    if (unmapped.length > 0) {
      throw new ApiError(409, {
        error: 'type_in_use',
        ticketTypeIds: unmapped,
        ticketCount: unmapped.reduce((n, t) => n + (counts[t] ?? 0), 0),
      });
    }
    for (const from of inUse) {
      const to = mapping[String(from)] as number;
      counts[to] = (counts[to] ?? 0) + (counts[from] ?? 0);
      counts[from] = 0;
    }
  };
  return {
    saved,
    tracks: async () => structuredClone(held),
    choices: async (track) =>
      track.mode === 'local'
        ? {
            layoutSets: [...shared.layoutSets, { id: 12, name: 'Ops forms', trackId: track.id }],
            prioritySets: shared.prioritySets,
            visibilityPolicies: [
              ...shared.visibilityPolicies,
              { id: 31, name: 'Ops levels', trackId: track.id },
            ],
            notificationPolicies: [
              ...shared.notificationPolicies,
              { id: 41, name: 'Ops notices', trackId: track.id },
            ],
            accessPolicies: [],
            typeSets: [],
            ticketTypes: [],
          }
        : structuredClone(shared),
    save: async (trackId, change) => {
      saved.push({ trackId, change });
      if (change.visibilityPolicyId === 30 && trackId === 4) {
        throw new ApiError(403, { error: 'forbidden' });
      }
      const track = held.find((t) => t.id === trackId);
      if (!track) throw new ApiError(404, { error: 'not_found' });
      if (track.mode === 'local' && (change.accessPolicyId ?? change.typeSetId) !== undefined) {
        throw new ApiError(400, { error: 'invalid_request' });
      }
      switchTypes(track, change);
      const { ticketTypeMapping: _mapping, ...rest } = change;
      Object.assign(track, rest);
    },
  };
}
