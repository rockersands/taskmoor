import { ApiError } from '../api/client';
import type { SetChange, SetChoices, TrackSetsClient, TrackWithSets } from './trackSetsClient';

export const TRACKS: TrackWithSets[] = [
  {
    id: 3,
    key: 'SHOP',
    name: 'Shop',
    mode: 'shared',
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
    layoutSetId: 12,
    prioritySetId: null,
    visibilityPolicyId: 31,
    notificationPolicyId: 41,
  },
];

const shared: SetChoices = {
  layoutSets: [{ id: 11, name: 'Default layouts', isDefault: true, trackId: null }],
  prioritySets: [
    { id: 20, name: 'Default priority set', isDefault: true },
    { id: 21, name: 'Support priorities' },
  ],
  visibilityPolicies: [{ id: 30, name: 'Company levels', trackId: null }],
  notificationPolicies: [{ id: 40, name: 'Default notifications', trackId: null }],
};

/** Tracks and their choices in memory; OPS is local-mode, with sets of its own. */
export function fakeTrackSetsClient(
  tracks: TrackWithSets[] = TRACKS,
): TrackSetsClient & { saved: { trackId: number; change: SetChange }[] } {
  const saved: { trackId: number; change: SetChange }[] = [];
  return {
    saved,
    tracks: async () => structuredClone(tracks),
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
          }
        : shared,
    save: async (trackId, change) => {
      saved.push({ trackId, change });
      if (change.visibilityPolicyId === 30 && trackId === 4) {
        throw new ApiError(403, { error: 'forbidden' });
      }
    },
  };
}
