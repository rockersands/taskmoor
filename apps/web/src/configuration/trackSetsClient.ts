import { api } from '../api/client';

/** A set a track can use. `trackId` names a local-mode track's own. */
export interface TrackSet {
  id: number;
  name: string;
  trackId?: number | null;
  isDefault?: boolean;
}

/** A track as far as this page uses it; null means the site's default, or none. */
export interface TrackWithSets {
  id: number;
  key: string;
  name: string;
  mode: 'shared' | 'local';
  layoutSetId: number | null;
  prioritySetId: number | null;
  visibilityPolicyId: number | null;
  notificationPolicyId: number | null;
}

export type SetChange = Partial<
  Pick<
    TrackWithSets,
    'layoutSetId' | 'prioritySetId' | 'visibilityPolicyId' | 'notificationPolicyId'
  >
>;

/** What can be chosen for a track: the shared sets, and a local-mode track's own. */
export interface SetChoices {
  layoutSets: TrackSet[];
  prioritySets: TrackSet[];
  visibilityPolicies: TrackSet[];
  notificationPolicies: TrackSet[];
}

/** The endpoints this page uses. Stories and tests pass their own. */
export interface TrackSetsClient {
  tracks: () => Promise<TrackWithSets[]>;
  choices: (track: TrackWithSets) => Promise<SetChoices>;
  save: (trackId: number, change: SetChange) => Promise<void>;
}

export const trackSetsClient: TrackSetsClient = {
  tracks: async () => (await api<{ tracks: TrackWithSets[] }>('/tracks?limit=500')).tracks,
  choices: async (track) => {
    const own = track.mode === 'local' ? `?trackId=${track.id}` : '';
    const list = async (path: string, key: string, ownToo: boolean) => {
      const shared = (await api<Record<string, TrackSet[]>>(path))[key] ?? [];
      if (!ownToo || !own) return shared;
      return [...shared, ...((await api<Record<string, TrackSet[]>>(`${path}${own}`))[key] ?? [])];
    };
    const [layoutSets, prioritySets, visibilityPolicies, notificationPolicies] = await Promise.all([
      // The layout sets of other local-mode tracks are in the list too, for those who may see them.
      list('/layout-sets', 'layoutSets', false).then((sets) =>
        sets.filter((s) => s.trackId == null || s.trackId === track.id),
      ),
      list('/priority-sets', 'prioritySets', false),
      list('/visibility-policies', 'visibilityPolicies', true),
      list('/notification-policies', 'notificationPolicies', true),
    ]);
    return { layoutSets, prioritySets, visibilityPolicies, notificationPolicies };
  },
  save: async (trackId, change) => {
    await api<unknown>(`/tracks/${trackId}`, { method: 'PATCH', body: change });
  },
};
