import type { TrackMode } from '../configuration/NewTrackForm';

/**
 * Which tracks a person may make, as `POST /api/v1/tracks` decides: shared configuration for site
 * and configuration administrators, their own configuration for those who hold Create tracks with
 * their own configuration. None means no way to make one is offered. The server still decides.
 */
export function newTrackModes(
  user: {
    isSiteAdmin: boolean;
    isConfigAdmin?: boolean;
    mayCreateLocalTracks?: boolean;
  } | null,
): TrackMode[] {
  if (!user) return [];
  return [
    ...(user.isSiteAdmin || user.isConfigAdmin ? (['shared'] as const) : []),
    ...(user.mayCreateLocalTracks ? (['local'] as const) : []),
  ];
}
