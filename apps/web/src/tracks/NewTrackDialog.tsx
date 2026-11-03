import { useEffect, useId, useState } from 'react';
import type { ConfigurationClient, Track } from '../configuration/client';
import { NewTrackForm, type TrackMode, trackRefusal } from '../configuration/NewTrackForm';
import { useT } from '../i18n/I18nProvider';
import { ModalDialog } from '../shell/ModalDialog';

export interface NewTrackDialogProps {
  client: ConfigurationClient;
  modes: readonly TrackMode[];
  onClose: () => void;
  /** The track is made. */
  onAdded: (track: Track) => void;
}

/** Making a track from the Tracks directory (CORE-001), with the form Administration uses. */
export function NewTrackDialog({ client, modes, onClose, onAdded }: NewTrackDialogProps) {
  const t = useT();
  const titleId = useId();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const mayCopy = modes.includes('shared');

  // Only a shared track can be copied, and only those who may make one may read the whole list.
  useEffect(() => {
    if (!mayCopy) return;
    let live = true;
    client.tracks().then(
      (list) => {
        if (live) setTracks(list);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, mayCopy]);

  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={titleId}
      closeLabel={t('tracks.new.close')}
      focusFirstField
    >
      <h2 id={titleId} className="section-title">
        {t('tracks.new')}
      </h2>
      <p className="page-note">{t('tracks.new.intro')}</p>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      <NewTrackForm
        client={client}
        tracks={tracks}
        modes={modes}
        label={t('tracks.new.create')}
        onAdded={(track) => onAdded(track)}
        onProblem={(error) => setProblem(trackRefusal(t, error))}
        actions={
          <button type="button" className="button-quiet" onClick={onClose}>
            {t('tracks.new.cancel')}
          </button>
        }
      />
    </ModalDialog>
  );
}
