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
 * Deleting a track (CORE-025, M1-101; T-322), for site and configuration administrators: a danger
 * action (ADR-114 D13) that says first what goes to the trash with the track and that it can be
 * restored from Trash. A refusal keeps the question open and is said by the page.
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
  onProblem: (text: string) => void;
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
          onProblem(deleteRefusal(t, track, error));
          throw error;
        }
        onDeleted();
      }}
    />
  );
}
