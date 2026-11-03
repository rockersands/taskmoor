import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { type TrackClient, type TrackListItem, trackClient } from './client';
import { trackHref } from './TrackLayout';

export interface TracksPageProps {
  client?: TrackClient;
}

/** Every track the person can see, to open or to find by name or key (ADR-114, ADR-116). */
export function TracksPage({ client = trackClient }: TracksPageProps) {
  const t = useT();
  const id = useId();
  const [tracks, setTracks] = useState<TrackListItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [words, setWords] = useState('');

  useEffect(() => {
    client.list().then(setTracks, () => setFailed(true));
  }, [client]);

  const wanted = words.trim().toLocaleLowerCase();
  const shown = tracks?.filter(
    (track) =>
      track.key.toLocaleLowerCase().includes(wanted) ||
      track.name.toLocaleLowerCase().includes(wanted),
  );

  return (
    <section aria-labelledby={`${id}-title`} className="tracks-page">
      <PageHeader titleId={`${id}-title`} title={t('tracks.title')} purpose={t('purpose.tracks')} />
      {failed && (
        <p className="form-error" role="alert">
          {t('tracks.failed')}
        </p>
      )}
      {tracks && tracks.length === 0 && (
        <EmptyState title={t('tracks.emptyTitle')}>{t('tracks.empty')}</EmptyState>
      )}
      {tracks && tracks.length > 0 && (
        <>
          <div className="form-field tracks-find">
            <label htmlFor={`${id}-find`} className="form-label">
              {t('tracks.find')}
            </label>
            <input
              id={`${id}-find`}
              type="search"
              value={words}
              onChange={(event) => setWords(event.target.value)}
            />
          </div>
          {shown?.length === 0 && <p className="page-note">{t('tracks.noMatch')}</p>}
          <ul className="tracks-list">
            {shown?.map((track) => (
              <li key={track.key} className="glass-card tracks-item">
                <a href={routeHref(trackHref(track.key))}>
                  <span className="tracks-item-key">{track.key}</span>
                  <span className="tracks-item-name">{track.name}</span>
                </a>
                {track.owner && (
                  <span className="tracks-item-owner">
                    {t('tracks.owner', { name: track.owner.name })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
