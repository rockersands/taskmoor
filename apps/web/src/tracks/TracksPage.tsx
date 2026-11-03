import { useCallback, useEffect, useId, useState } from 'react';
import { type ConfigurationClient, configurationClient } from '../configuration/client';
import { useT } from '../i18n/I18nProvider';
import { currentRoute, navigate, onRouteChange, replaceRoute, routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { type TrackGroup, type TrackGroupClient, trackGroupClient } from '../trackgroups/client';
import { TrackArrangement } from '../trackgroups/TrackArrangement';
import { type TrackClient, type TrackListItem, trackClient } from './client';
import { NewTrackDialog } from './NewTrackDialog';
import { trackHref } from './TrackLayout';
import { newTrackModes } from './trackAccess';

export interface TracksPageProps {
  client?: TrackClient;
  /** Stories and tests pass their own backend for making a track. */
  creator?: ConfigurationClient;
  /** And for the person's groups of tracks. */
  groups?: TrackGroupClient;
}

/** The directory's address with the New track dialog open, as the command palette leads to it. */
export const NEW_TRACK_ROUTE = '#/tracks?new';
const asksForNew = (route: string) => new URLSearchParams(route.split('?')[1] ?? '').has('new');

/**
 * Every track the person can see, to open or to find by name or key (ADR-114, ADR-116), and a way
 * to make one for those the server allows (CORE-001). The person arranges them in groups of their
 * own, and sees the groups shared with them (CORE-034, ADR-121); a search lists matches plainly.
 */
export function TracksPage({
  client = trackClient,
  creator = configurationClient,
  groups: groupClient = trackGroupClient,
}: TracksPageProps) {
  const t = useT();
  const id = useId();
  const { session } = useSession();
  const modes = newTrackModes(session.status === 'signed-in' ? session.user : null);
  const [tracks, setTracks] = useState<TrackListItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [groups, setGroups] = useState<TrackGroup[] | null>(null);
  const [groupsFailed, setGroupsFailed] = useState(false);
  const [words, setWords] = useState('');
  const [creating, setCreating] = useState(() => asksForNew(currentRoute()));

  useEffect(() => {
    client.list().then(setTracks, () => setFailed(true));
  }, [client]);

  // Without the groups the tracks still show, in the directory's order.
  useEffect(() => {
    groupClient.layout().then(setGroups, () => {
      setGroups([]);
      setGroupsFailed(true);
    });
  }, [groupClient]);

  useEffect(() => onRouteChange(() => setCreating(asksForNew(currentRoute()))), []);

  const stopCreating = useCallback(() => {
    setCreating(false);
    if (asksForNew(currentRoute())) replaceRoute('#/tracks');
  }, []);

  const wanted = words.trim().toLocaleLowerCase();
  const shown = tracks?.filter(
    (track) =>
      track.key.toLocaleLowerCase().includes(wanted) ||
      track.name.toLocaleLowerCase().includes(wanted),
  );
  const newTrackButton = (
    <button type="button" className="button-primary" onClick={() => setCreating(true)}>
      {t('tracks.new')}
    </button>
  );

  return (
    <section aria-labelledby={`${id}-title`} className="tracks-page">
      <PageHeader
        titleId={`${id}-title`}
        title={t('tracks.title')}
        purpose={t('purpose.tracks')}
        {...(modes.length > 0 ? { actions: newTrackButton } : {})}
      />
      {failed && (
        <p className="form-error" role="alert">
          {t('tracks.failed')}
        </p>
      )}
      {tracks &&
        tracks.length === 0 &&
        (modes.length > 0 ? (
          <EmptyState title={t('tracks.emptyTitle')} action={newTrackButton}>
            {t('tracks.emptyMayCreate')}
          </EmptyState>
        ) : (
          <EmptyState title={t('tracks.emptyTitle')}>{t('tracks.empty')}</EmptyState>
        ))}
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
          {groupsFailed && (
            <p className="form-error" role="alert">
              {t('trackGroups.failed')}
            </p>
          )}
          {wanted === '' && groups !== null ? (
            <TrackArrangement
              tracks={tracks}
              groups={groups}
              client={groupClient}
              onGroups={setGroups}
            />
          ) : (
            <>
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
        </>
      )}
      {creating && modes.length > 0 && (
        <NewTrackDialog
          client={creator}
          modes={modes}
          onClose={stopCreating}
          onAdded={(track) => navigate(trackHref(track.key))}
        />
      )}
    </section>
  );
}
