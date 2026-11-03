import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { type ManagedTrack, type TrackPeopleClient, trackPeopleClient } from './client';

export interface ManagedTracksPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: TrackPeopleClient;
}

/** The tracks the signed-in person runs, each leading to its Manage page (IAM-030). */
export function ManagedTracksPage({ client = trackPeopleClient }: ManagedTracksPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const titleId = useId();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'failed' } | { status: 'loaded'; tracks: ManagedTrack[] }
  >({ status: 'loading' });

  useEffect(() => {
    let live = true;
    client.managedTracks().then(
      (tracks) => {
        if (live) setState({ status: 'loaded', tracks });
      },
      (error: unknown) => {
        if (live && !expired(error)) setState({ status: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [client, expired]);

  return (
    <section aria-labelledby={titleId} className="admin-page people-page">
      <h1 id={titleId} className="page-title">
        {t('trackPeople.listTitle')}
      </h1>
      <p className="page-note">{t('trackPeople.listIntro')}</p>
      {state.status === 'loading' && (
        <p role="status" className="page-note">
          {t('trackPeople.loading')}
        </p>
      )}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('trackPeople.failed')}
        </p>
      )}
      {state.status === 'loaded' && state.tracks.length === 0 && (
        <p className="page-note">{t('trackPeople.listEmpty')}</p>
      )}
      {state.status === 'loaded' && state.tracks.length > 0 && (
        <ul className="people-list">
          {state.tracks.map((track) => (
            <li key={track.id} className="people-item">
              <div className="people-main">
                <p className="people-name">
                  {track.key} · {track.name}
                </p>
              </div>
              <div className="people-actions">
                <a
                  className="button-secondary people-action"
                  href={routeHref(`#/manage/tracks/${track.id}`)}
                  aria-label={t('trackPeople.manageOf', { key: track.key })}
                >
                  {t('trackPeople.manage')}
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
