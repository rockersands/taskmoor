import { useCallback, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { navigate, routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { CrossTrackState } from './CrossTrackState';
import { type CrossTrackClient, type CrossTrackRow, crossTrackClient } from './crossTrackClient';
import { useEndText } from './crossTrackText';
import { NewCrossTrackDialog } from './NewCrossTrackDialog';

export interface CrossTrackReleasesPageProps {
  client?: CrossTrackClient;
}

/**
 * Releases across tracks (T-089c; PLN-007; ADR-122 stage 4): those the person sees, Upcoming and
 * Shipped, each with its end, its state in words, how much of its work they see is closed, the
 * tracks they see and how many releases are hidden from them. Reached from a track's releases, a
 * release's page, Multi-track and a plan's Releases tab; it has no place in the sidebar.
 */
export function CrossTrackReleasesPage({ client = crossTrackClient }: CrossTrackReleasesPageProps) {
  const t = useT();
  const id = useId();
  const [upcoming, setUpcoming] = useState<CrossTrackRow[] | null>(null);
  const [shipped, setShipped] = useState<CrossTrackRow[] | null>(null);
  const [next, setNext] = useState<{ upcoming: string | null; shipped: string | null }>({
    upcoming: null,
    shipped: null,
  });
  const [failed, setFailed] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    Promise.all([client.list('upcoming'), client.list('shipped')]).then(
      ([u, s]) => {
        setUpcoming(u.releases);
        setShipped(s.releases);
        setNext({ upcoming: u.next, shipped: s.next });
      },
      () => setFailed(true),
    );
  }, [client]);
  useEffect(load, [load]);

  const more = async (state: 'upcoming' | 'shipped') => {
    const cursor = next[state];
    if (!cursor) return;
    setMoreFailed(false);
    try {
      const page = await client.list(state, cursor);
      const add = state === 'upcoming' ? setUpcoming : setShipped;
      add((rows) => [...(rows ?? []), ...page.releases]);
      setNext((n) => ({ ...n, [state]: page.next }));
    } catch {
      // The button stays, so the person can try again.
      setMoreFailed(true);
    }
  };

  const header = (
    <PageHeader
      titleId={`${id}-title`}
      title={t('crossTrack.title')}
      purpose={t('purpose.crossTracks')}
      about={t('crossTrack.about')}
      actions={
        <>
          <a className="button-quiet" href={routeHref('#/plans')}>
            {t('nav.plans')}
          </a>
          <button type="button" className="button-primary" onClick={() => setCreating(true)}>
            {t('crossTrack.new')}
          </button>
        </>
      }
    />
  );

  if (failed) {
    return (
      <section className="page cross-track-page" aria-labelledby={`${id}-title`}>
        {header}
        <p className="board-problem" role="alert">
          {t('crossTrack.failed')}
        </p>
      </section>
    );
  }
  if (!upcoming || !shipped) return <p className="report-loading">{t('reports.loading')}</p>;

  return (
    <section className="page cross-track-page" aria-labelledby={`${id}-title`}>
      {header}
      {moreFailed && (
        <p className="board-problem" role="alert">
          {t('crossTrack.moreFailed')}
        </p>
      )}
      <section className="glass-card release-group" aria-labelledby={`${id}-upcoming`}>
        <h2 id={`${id}-upcoming`}>{t('releases.upcoming')}</h2>
        {upcoming.length === 0 ? (
          <EmptyState title={t('crossTrack.noneUpcoming')}>
            {t('empty.crossTrack.upcoming')}
          </EmptyState>
        ) : (
          <CrossTrackRows rows={upcoming} />
        )}
        {next.upcoming && (
          <button type="button" className="button-secondary" onClick={() => void more('upcoming')}>
            {t('crossTrack.more')}
          </button>
        )}
      </section>
      <section className="glass-card release-group" aria-labelledby={`${id}-shipped`}>
        <h2 id={`${id}-shipped`}>{t('releases.shipped')}</h2>
        {shipped.length === 0 ? (
          <EmptyState compact title={t('crossTrack.noneShipped')}>
            {t('empty.crossTrack.shipped')}
          </EmptyState>
        ) : (
          <CrossTrackRows rows={shipped} />
        )}
        {next.shipped && (
          <button type="button" className="button-secondary" onClick={() => void more('shipped')}>
            {t('crossTrack.more')}
          </button>
        )}
      </section>
      {creating && (
        <NewCrossTrackDialog
          client={client}
          onClose={() => setCreating(false)}
          onMade={(made) => navigate(`#/cross-track-releases/${made}`)}
        />
      )}
    </section>
  );
}

/** Rows of the list; on a phone each is a card with its link a finger high. */
function CrossTrackRows({ rows }: { rows: CrossTrackRow[] }) {
  const t = useT();
  const endText = useEndText();
  return (
    <ul className="release-list">
      {rows.map((r) => (
        <li key={r.id} className="release-row cross-track-row">
          <div className="release-row-head">
            <a href={routeHref(`#/cross-track-releases/${r.id}`)} className="release-name">
              {r.name}
            </a>
            <CrossTrackState state={r.state} />
          </div>
          <span className="board-meta">{endText(r)}</span>
          <span className="release-progress">
            <span className="release-meter" aria-hidden="true">
              <span
                style={{
                  width: `${r.progress.tickets === 0 ? 0 : (r.progress.closed / r.progress.tickets) * 100}%`,
                }}
              />
            </span>
            <span className="board-meta">
              {t('releases.progress', { closed: r.progress.closed, count: r.progress.tickets })}
            </span>
          </span>
          <span className="board-meta cross-track-row-tracks">
            {r.tracks.map((x) => x.key).join(', ')}
            {r.hidden.releases > 0 && (
              <>
                {r.tracks.length > 0 && ' · '}
                {t('crossTrack.hiddenReleases', { count: r.hidden.releases })}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
