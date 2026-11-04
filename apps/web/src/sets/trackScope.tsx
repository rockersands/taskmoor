import { useEffect, useState } from 'react';
import { useAdminAccess } from '../admin/access';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { useSessionExpiry } from '../session/useSessionExpiry';

/** A track as the pages of its own sets read it (`GET /api/v1/tracks/:id`). */
export interface ScopeTrack {
  id: number;
  key: string;
  name: string;
  mode: 'shared' | 'local';
  archived: boolean;
  typeSetId: number | null;
  fieldRuleSetId: number | null;
  layoutSetId: number | null;
}

/** A track the person runs (`GET /api/v1/me/managed-tracks`). */
export interface RunTrack {
  id: number;
  key: string;
  name: string;
  mode: 'shared' | 'local';
}

/** The reads that tell a page whose sets it shows. Stories and tests pass their own. */
export interface TrackScopeClient {
  track: (id: number) => Promise<ScopeTrack>;
  /** The tracks the person runs, archived ones aside. */
  managedTracks: () => Promise<RunTrack[]>;
}

export const trackScopeClient: TrackScopeClient = {
  track: async (id) => (await api<{ track: ScopeTrack }>(`/tracks/${id}`)).track,
  managedTracks: async () => (await api<{ tracks: RunTrack[] }>('/me/managed-tracks')).tracks,
};

/** A track's own configuration pages, beside its Manage page (T-163a). */
export const ownLayoutsHref = (trackId: number) => `#/manage/tracks/${trackId}/layouts`;
export const ownSetsHref = (trackId: number) => `#/manage/tracks/${trackId}/configuration-sets`;
export const manageTrackHref = (trackId: number) => `#/manage/tracks/${trackId}`;

/**
 * Whose sets a page of sets shows (T-163a, ADR-114 section 8):
 *
 * - `all`: every set, for site and configuration administrators.
 * - `track`: the sets a local-mode track owns, on that track's own page, for whoever runs it and
 *   for administrators.
 * - `choose`: someone who runs tracks but is no administrator, on the shared page: the local-mode
 *   tracks they run, each leading to its own page. They never see a shared set there.
 * - `shared` and `archived`: the track's own page, for a track that owns no sets, or cannot change
 *   them now. `notYours`: a track the person does not run. `none`: no administrator at all.
 *
 * It decides what the page offers; the server decides every read and change.
 */
export type SetScope =
  | { status: 'waiting' }
  | { status: 'all' }
  | { status: 'track'; track: ScopeTrack }
  | { status: 'choose'; tracks: RunTrack[] }
  | { status: 'shared'; track: ScopeTrack }
  | { status: 'archived'; track: ScopeTrack }
  | { status: 'notYours' }
  | { status: 'none' }
  | { status: 'failed' };

export function useSetScope(trackId: number | null, client: TrackScopeClient): SetScope {
  const access = useAdminAccess();
  const expired = useSessionExpiry();
  const [read, setRead] = useState<SetScope>({ status: 'waiting' });
  const admin = access === 'site' || access === 'setup';
  const reads = access !== null && access !== 'none' && (trackId !== null || !admin);
  useEffect(() => {
    if (!reads) return;
    let live = true;
    setRead({ status: 'waiting' });
    const work = async (): Promise<SetScope> => {
      // Someone who is no administrator sees only the tracks they run.
      const runs = admin ? null : await client.managedTracks();
      if (trackId === null) {
        return { status: 'choose', tracks: (runs ?? []).filter((t) => t.mode === 'local') };
      }
      if (runs && !runs.some((t) => t.id === trackId)) return { status: 'notYours' };
      const track = await client.track(trackId);
      if (track.mode !== 'local') return { status: 'shared', track };
      if (track.archived) return { status: 'archived', track };
      return { status: 'track', track };
    };
    work().then(
      (scope) => {
        if (live) setRead(scope);
      },
      (error: unknown) => {
        if (!live || expired(error)) return;
        const refused = error instanceof ApiError && (error.status === 403 || error.status === 404);
        setRead({ status: refused ? 'notYours' : 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [reads, admin, trackId, client, expired]);
  if (access === null) return { status: 'waiting' };
  if (access === 'none') return { status: 'none' };
  if (!reads) return { status: 'all' };
  return read;
}

/** The words of a page's notes about its scope; each page says them about its own sets. */
export interface ScopeWords {
  /** Above the list of tracks someone runs. */
  chooseIntro: string;
  /** When none of the tracks they run has its own configuration. */
  chooseNone: string;
  /** The link to one track's page. */
  chooseOpen: (track: RunTrack) => string;
  /** A track in shared mode owns none of these sets. */
  shared: (track: ScopeTrack) => string;
  /** Nobody administers anything here: the page's refusal. */
  none: string;
  failed: string;
}

/**
 * What a page of sets shows when it shows no sets: the tracks to choose from, or why not. Null
 * when the page shows its sets.
 */
export function ScopeNote({
  scope,
  words,
  hrefOf,
}: {
  scope: SetScope;
  words: ScopeWords;
  hrefOf: (trackId: number) => string;
}) {
  const t = useT();
  switch (scope.status) {
    case 'waiting':
      return <p className="page-note">{t('ownSets.loading')}</p>;
    case 'none':
      return <p className="page-note">{words.none}</p>;
    case 'notYours':
      return <p className="page-note">{t('ownSets.notYours')}</p>;
    case 'failed':
      return (
        <p role="alert" className="form-error">
          {words.failed}
        </p>
      );
    case 'shared':
      return <p className="page-note">{words.shared(scope.track)}</p>;
    case 'archived':
      return <p className="page-note">{t('ownSets.archived', { key: scope.track.key })}</p>;
    case 'choose':
      return scope.tracks.length === 0 ? (
        <p className="page-note">{words.chooseNone}</p>
      ) : (
        <div className="glass-card admin-panel">
          <p className="page-note">{words.chooseIntro}</p>
          <ul className="link-list">
            {scope.tracks.map((track) => (
              <li key={track.id}>
                <a href={routeHref(hrefOf(track.id))}>{words.chooseOpen(track)}</a>
              </li>
            ))}
          </ul>
        </div>
      );
    default:
      return null;
  }
}

/** The line under the title of a track's own page: which track, and the way back to it. */
export function TrackScopeLine({ track, intro }: { track: ScopeTrack; intro: string }) {
  const t = useT();
  return (
    <p className="page-note">
      {intro}{' '}
      <a href={routeHref(manageTrackHref(track.id))}>
        {t('ownSets.backToTrack', { key: track.key })}
      </a>
    </p>
  );
}
