import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { CrossTrackState } from '../releases/CrossTrackState';
import type { Progress } from '../releases/crossTrackClient';
import { dayText, useEndText } from '../releases/crossTrackText';
import { ReleaseState } from '../releases/ReleaseState';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import type { PlanRelease, PlanReleases } from './client';
import { DownloadMenu } from './DownloadMenu';
import { fileName, saveBlob } from './download';
import type { PlanSectionProps } from './PlanSummaryPage';
import { releasesCsv } from './planExport';

/** Releases by their date, earliest first; those without one last, in the order they came. */
export function byDate(releases: readonly PlanRelease[]): PlanRelease[] {
  return [...releases].sort((a, b) =>
    a.releaseDate === b.releaseDate
      ? 0
      : a.releaseDate === null
        ? 1
        : b.releaseDate === null
          ? -1
          : a.releaseDate < b.releaseDate
            ? -1
            : 1,
  );
}

/**
 * A plan's Releases tab (T-089c; PLN-007; ADR-122 stage 4): the releases of the plan's tracks the
 * viewer browses, those of a release across tracks gathered under it first, then the rest by
 * track, each group in date order (no date last); a shipped release says when it shipped (PL-40). A release across tracks shows its own whole numbers, not the plan's share,
 * and what is hidden from the viewer only as a count. Only the track filter applies, and the page
 * says so; a ticket-level grant adds no row. On a phone each group is a card with a list inside.
 */
export function PlanReleasesPage({ id, plan, filters, client, now }: PlanSectionProps) {
  const t = useT();
  const intl = useIntl();
  const domId = useId();
  const endText = useEndText();
  const [data, setData] = useState<PlanReleases | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);

  // Only the answer to the latest request is drawn.
  const load = useCallback(() => {
    const asked = ++latest.current;
    client.releases(id, filters.track).then(
      (answer) => {
        if (asked !== latest.current) return;
        setData(answer);
        setFailed(false);
      },
      () => {
        if (asked === latest.current) setFailed(true);
      },
    );
  }, [client, id, filters.track]);
  useEffect(load, [load]);
  useTicketChanges(load);

  const otherFilters = Boolean(filters.assignee || filters.type || filters.stage);

  if (failed) {
    return (
      <p className="board-problem" role="alert">
        {t('plans.failed')}
      </p>
    );
  }
  if (!data) return <p className="report-loading">{t('reports.loading')}</p>;

  const share = (p: Progress) => t('releases.progress', { closed: p.closed, count: p.tickets });
  const rows = (releases: PlanRelease[]) => (
    <ul className="release-list">
      {byDate(releases).map((r) => (
        <li key={r.id} className="release-row">
          <div className="release-row-head">
            <a href={routeHref(`#/releases/${r.id}`)} className="release-name">
              {r.track
                ? t('crossTrack.linked.name', { track: r.track.name, name: r.name })
                : r.name}
            </a>
            <ReleaseState release={r} />
          </div>
          <span className="board-meta">
            {r.releaseDate
              ? t(r.shipped ? 'releases.shippedOn' : 'releases.dueOn', {
                  date: dayText(intl, r.releaseDate),
                })
              : t('releases.noDate')}
            {r.outOfStep && (
              <>
                {' '}
                <span className="badge badge-warning">{t('crossTrack.outOfStep')}</span>
              </>
            )}
          </span>
          <span className="board-meta">{share(r.progress)}</span>
        </li>
      ))}
    </ul>
  );

  const nothing = data.crossTrack.length === 0 && data.tracks.length === 0;
  return (
    <div className="plan-releases">
      <div className="plan-view-tools">
        <a className="button-quiet" href={routeHref('#/cross-track-releases')}>
          {t('crossTrack.title')}
        </a>
        <DownloadMenu
          items={[
            {
              key: 'csv',
              label: t('plans.download.csv'),
              make: async () => {
                const name = fileName(
                  plan.name,
                  'releases',
                  now().toISOString().slice(0, 10),
                  'csv',
                );
                saveBlob(name, new Blob([releasesCsv(t, data)], { type: 'text/csv' }));
                return name;
              },
            },
          ]}
        />
      </div>
      {otherFilters && <p className="board-hint">{t('plans.releases.filtersNote')}</p>}
      {nothing && (
        <EmptyState title={t('plans.releases.none')}>
          {t(plan.query === null ? 'empty.plans.releases.nothing' : 'empty.plans.releases')}
        </EmptyState>
      )}
      {data.crossTrack.map((group) => (
        <section
          key={group.id}
          className="glass-card release-group"
          aria-labelledby={`${domId}-c${group.id}`}
        >
          <div className="cross-track-group-head">
            <h2 id={`${domId}-c${group.id}`}>
              <a href={routeHref(`#/cross-track-releases/${group.id}`)}>{group.name}</a>
            </h2>
            <CrossTrackState state={group.state} />
            <span className="board-meta">{endText(group)}</span>
            <span className="board-meta">{share(group.progress)}</span>
          </div>
          {rows(group.releases)}
          {group.hidden.releases > 0 && (
            <p className="cross-track-hidden">
              {t('crossTrack.hidden', {
                releases: group.hidden.releases,
                open: group.hidden.open,
              })}
            </p>
          )}
        </section>
      ))}
      {data.tracks.map((group) => (
        <section
          key={group.track.id}
          className="glass-card release-group"
          aria-labelledby={`${domId}-t${group.track.id}`}
        >
          <h2 id={`${domId}-t${group.track.id}`}>{group.track.name}</h2>
          {rows(group.releases)}
        </section>
      ))}
      {data.truncated && <p className="board-hint">{t('plans.releases.truncated')}</p>}
    </div>
  );
}
