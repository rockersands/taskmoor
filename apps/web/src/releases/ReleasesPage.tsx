import { useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { type Release, type ReleaseClient, type ReleaseList, releaseClient } from './client';
import { dayText } from './crossTrackText';
import { ReleaseState } from './ReleaseState';

export interface ReleasesPageProps {
  trackKey: string;
  client?: ReleaseClient;
}

/**
 * A track's releases hub (M1-050; CORE-016): the upcoming releases in the track's order, then
 * the shipped ones and, folded away, the archived ones; each with its dates, its state (overdue
 * when its day has passed) and how many of its tickets are closed, linking to its page. The
 * track's administrators add releases here. A release in a release across tracks (PLN-007) says so,
 * and the page links to their list.
 */
export function ReleasesPage({ trackKey, client = releaseClient }: ReleasesPageProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [track, setTrack] = useState<{ id: number; key: string; name: string } | null>(null);
  const [list, setList] = useState<ReleaseList | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (trackId: number) =>
      client.list(trackId).then(
        (l) => setList(l),
        () => setFailed(true),
      ),
    [client],
  );
  useEffect(() => {
    let live = true;
    client.track(trackKey).then(
      (found) => {
        if (!live) return;
        setTrack(found);
        void load(found.id);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, trackKey, load]);

  if (failed) {
    return (
      <section className="page releases-page" aria-labelledby={`${id}-title`}>
        <PageHeader
          titleId={`${id}-title`}
          title={t('track.section.releases')}
          purpose={t('purpose.releases')}
        />
        <p className="board-problem" role="alert">
          {t('releases.notFound')}
        </p>
      </section>
    );
  }
  if (!track || !list) return <p className="report-loading">{t('reports.loading')}</p>;

  const upcoming = list.releases.filter((r) => !r.shipped && !r.archived);
  const shipped = list.releases.filter((r) => r.shipped && !r.archived);
  const archived = list.releases.filter((r) => r.archived);

  const add = async () => {
    const text = name.trim();
    if (text === '') return;
    setBusy(true);
    setProblem(null);
    const outcome = await client.create(track.id, {
      name: text,
      ...(date ? { releaseDate: date } : {}),
    });
    setBusy(false);
    if (!outcome.ok) {
      setProblem(
        outcome.code === 'name_taken' ? t('releases.create.taken') : t('releases.create.failed'),
      );
      return;
    }
    setName('');
    setDate('');
    await load(track.id);
  };

  const rows = (releases: Release[]) => (
    <ul className="release-list">
      {releases.map((r) => (
        <li key={r.id} className="release-row">
          <div className="release-row-head">
            <a href={routeHref(`#/releases/${r.id}`)} className="release-name">
              {r.name}
            </a>
            <ReleaseState release={r} />
            {r.crossTrack && (
              <a
                className="badge release-cross-track"
                href={routeHref(`#/cross-track-releases/${r.crossTrack.id}`)}
              >
                {t('releases.crossTrackLabel', { name: r.crossTrack.name })}
              </a>
            )}
          </div>
          <span className="board-meta">
            {r.shipped && r.shippedAt
              ? t('releases.shippedOn', {
                  date: dayText(intl, r.releaseDate ?? r.shippedAt.slice(0, 10)),
                })
              : r.releaseDate
                ? t('releases.dueOn', { date: dayText(intl, r.releaseDate) })
                : t('releases.noDate')}
          </span>
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
        </li>
      ))}
    </ul>
  );

  return (
    <section className="page releases-page" aria-labelledby={`${id}-title`}>
      <PageHeader
        titleId={`${id}-title`}
        title={t('releases.title', { name: track.name })}
        purpose={t('purpose.releases')}
        actions={
          <>
            <a className="button-quiet" href={routeHref('#/cross-track-releases')}>
              {t('crossTrack.title')}
            </a>
            <a
              className="button-quiet"
              href={routeHref(`#/tracks/${encodeURIComponent(track.key)}`)}
            >
              {t('releases.toSummary')}
            </a>
          </>
        }
      />
      {list.mayManage && (
        <form
          className="glass-card release-create"
          data-tutorial="release-new"
          aria-label={t('releases.create.label')}
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label className="form-field">
            <span className="form-label">{t('releases.create.name')}</span>
            <input
              type="text"
              value={name}
              maxLength={255}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="form-field">
            <span className="form-label">{t('releases.create.date')}</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <button type="submit" className="button-primary" disabled={busy || name.trim() === ''}>
            {t('releases.create.submit')}
          </button>
          {problem && (
            <p className="board-problem" role="alert">
              {problem}
            </p>
          )}
        </form>
      )}
      <section className="glass-card release-group" aria-labelledby={`${id}-upcoming`}>
        <h2 id={`${id}-upcoming`}>{t('releases.upcoming')}</h2>
        {upcoming.length === 0 ? (
          <EmptyState title={t('releases.noneUpcoming')}>
            {t(list.mayManage ? 'empty.releases.upcoming' : 'empty.releases.upcomingRead')}
          </EmptyState>
        ) : (
          rows(upcoming)
        )}
      </section>
      <section className="glass-card release-group" aria-labelledby={`${id}-shipped`}>
        <h2 id={`${id}-shipped`}>{t('releases.shipped')}</h2>
        {shipped.length === 0 ? (
          <EmptyState compact title={t('releases.noneShipped')}>
            {t('empty.releases.shipped')}
          </EmptyState>
        ) : (
          rows([...shipped].reverse())
        )}
      </section>
      {archived.length > 0 && (
        <details className="glass-card release-group">
          <summary>{t('releases.archived', { count: archived.length })}</summary>
          {rows(archived)}
        </details>
      )}
    </section>
  );
}
