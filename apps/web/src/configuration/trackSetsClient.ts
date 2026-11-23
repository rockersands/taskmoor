import { api } from '../api/client';
import { everyTrack } from '../api/tracks';
import type { TypeChoice } from '../sets/client';

/** A set a track can use. `trackId` names a local-mode track's own. */
export interface TrackSet {
  id: number;
  name: string;
  trackId?: number | null;
  isDefault?: boolean;
}

/** A shared type set, with the ticket types it holds: the ones a track switching to it keeps. */
export interface TrackTypeSet extends TrackSet {
  ticketTypeIds: number[];
}

/** A track as far as this page uses it; null means the site's default, or none. */
export interface TrackWithSets {
  id: number;
  key: string;
  name: string;
  mode: 'shared' | 'local';
  /** A shared-mode track's are chosen here; a local-mode track keeps its own (T-322). */
  accessPolicyId: number | null;
  typeSetId: number | null;
  layoutSetId: number | null;
  prioritySetId: number | null;
  visibilityPolicyId: number | null;
  notificationPolicyId: number | null;
}

/** What saving may change (`PATCH /api/v1/tracks/:id`); only what changed is sent. */
export interface SetChange {
  layoutSetId?: number | null;
  prioritySetId?: number | null;
  visibilityPolicyId?: number | null;
  notificationPolicyId?: number | null;
  /** A shared-mode track only, and never none. */
  accessPolicyId?: number;
  typeSetId?: number;
  /** Each type the new type set lacks to the type its tickets take, at its level (CORE-005 (2)). */
  ticketTypeMapping?: Record<string, number>;
}

/** What can be chosen for a track: the shared sets, and a local-mode track's own. */
export interface SetChoices {
  layoutSets: TrackSet[];
  prioritySets: TrackSet[];
  visibilityPolicies: TrackSet[];
  notificationPolicies: TrackSet[];
  /** The shared access policies; none for a local-mode track, which keeps its own. */
  accessPolicies: TrackSet[];
  /** The shared type sets; none for a local-mode track, which keeps its own. */
  typeSets: TrackTypeSet[];
  /** The shared ticket types with their levels, for the mapping a type set switch may need. */
  ticketTypes: TypeChoice[];
}

/** The endpoints this page uses. Stories and tests pass their own. */
export interface TrackSetsClient {
  tracks: () => Promise<TrackWithSets[]>;
  choices: (track: TrackWithSets) => Promise<SetChoices>;
  save: (trackId: number, change: SetChange) => Promise<void>;
}

type SharedChoices = Pick<SetChoices, 'accessPolicies' | 'typeSets' | 'ticketTypes'>;

interface PolicyRead {
  id: number;
  name: string;
  isDefault: boolean;
  ownerTrackId: number | null;
}
interface TypeSetRead {
  id: number;
  name: string;
  trackId: number | null;
  ticketTypes: { id: number }[];
}
interface TypeRead {
  id: number;
  name: string;
  trackId?: number | null;
  level: { id: number; name: string };
}

/** The shared access policies, type sets and ticket types a shared-mode track chooses from. */
async function sharedChoices(): Promise<SharedChoices> {
  const [policies, typeSets, ticketTypes] = await Promise.all([
    api<{ policies: PolicyRead[] }>('/access-policies'),
    api<{ typeSets: TypeSetRead[] }>('/type-sets'),
    api<{ ticketTypes: TypeRead[] }>('/ticket-types'),
  ]);
  return {
    accessPolicies: policies.policies
      .filter((p) => p.ownerTrackId === null)
      .map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault })),
    typeSets: typeSets.typeSets
      .filter((s) => s.trackId === null)
      .map((s) => ({ id: s.id, name: s.name, ticketTypeIds: s.ticketTypes.map((t) => t.id) })),
    ticketTypes: ticketTypes.ticketTypes
      .filter((t) => (t.trackId ?? null) === null)
      .map((t) => ({ id: t.id, name: t.name, level: { id: t.level.id, name: t.level.name } })),
  };
}

const NO_SHARED_CHOICES: SharedChoices = { accessPolicies: [], typeSets: [], ticketTypes: [] };

export const trackSetsClient: TrackSetsClient = {
  tracks: () => everyTrack<TrackWithSets>(),
  choices: async (track) => {
    const own = track.mode === 'local' ? `?trackId=${track.id}` : '';
    const list = async (path: string, key: string, ownToo: boolean) => {
      const shared = (await api<Record<string, TrackSet[]>>(path))[key] ?? [];
      if (!ownToo || !own) return shared;
      return [...shared, ...((await api<Record<string, TrackSet[]>>(`${path}${own}`))[key] ?? [])];
    };
    const [layoutSets, prioritySets, visibilityPolicies, notificationPolicies, shared] =
      await Promise.all([
        // The layout sets of other local-mode tracks are in the list too, for those who may see them.
        list('/layout-sets', 'layoutSets', false).then((sets) =>
          sets.filter((s) => s.trackId == null || s.trackId === track.id),
        ),
        list('/priority-sets', 'prioritySets', false),
        list('/visibility-policies', 'visibilityPolicies', true),
        list('/notification-policies', 'notificationPolicies', true),
        track.mode === 'shared' ? sharedChoices() : NO_SHARED_CHOICES,
      ]);
    return { layoutSets, prioritySets, visibilityPolicies, notificationPolicies, ...shared };
  },
  save: async (trackId, change) => {
    await api<unknown>(`/tracks/${trackId}`, { method: 'PATCH', body: change });
  },
};
