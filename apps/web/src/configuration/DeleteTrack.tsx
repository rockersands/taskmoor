import { ApiError } from '../api/client';
import { type Translate, useT } from '../i18n/I18nProvider';
import { DangerAction } from '../shell/DangerAction';
import type { ConfigurationClient, Track } from './client';
import { trackRefusal } from './NewTrackForm';

/** Where a deleted track waits until it is restored or its time is up (M1-101). */
export const TRASH_HREF = '#/admin/trash';

/** Why deleting a track was refused, in words (`DELETE /api/v1/tracks/:id`). */
export function deleteRefusal(t: Translate, track: Track, error: unknown): string {
  if (error instanceof ApiError && error.code === 'in_trash') {
    return t('admin.tracks.problem.inTrash', { key: track.key });
  }
  if (error instanceof ApiError && error.status === 404) {
    return t('admin.tracks.problem.gone', { key: track.key });
  }
  return trackRefusal(t, error);
}

/**
 * Where a track someone else deleted meanwhile is: in the trash (`409 in_trash`), or gone for good
 * or out of sight (404); null for a refusal of a track still there.
 */
export type TrackGone = 'trash' | 'gone' | null;

function goneOf(error: unknown): TrackGone {
  if (error instanceof ApiError && error.code === 'in_trash') return 'trash';
  return error instanceof ApiError && error.status === 404 ? 'gone' : null;
}

/**
 * Deleting a track (CORE-025, M1-101; T-322), for site and configuration administrators: a danger
 * action (ADR-114 D13) that says first what goes to the trash with the track and that it can be
 * restored from Trash. A refusal is said by the page; it keeps the question open unless the track
 * is no longer there, which the page shows by reading its list again.
 */
export function DeleteTrack({
  track,
  client,
  onDeleted,
  onProblem,
}: {
  track: Track;
  client: ConfigurationClient;
  onDeleted: () => void;
  onProblem: (text: string, gone: TrackGone) => void;
}) {
  const t = useT();
  return (
    <DangerAction
      label={t('admin.tracks.delete')}
      name={t('admin.tracks.deleteOf', { key: track.key })}
      outcome={t('admin.tracks.deleteOutcome', { key: track.key })}
      confirmLabel={t('admin.tracks.deleteOf', { key: track.key })}
      onConfirm={async () => {
        try {
          await client.deleteTrack(track.id);
        } catch (error) {
          onProblem(deleteRefusal(t, track, error), goneOf(error));
          throw error;
        }
        onDeleted();
      }}
    />
  );
}
