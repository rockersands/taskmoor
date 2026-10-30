import { type FormEvent, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import type { Board } from '../boards/client';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { estimateText } from '../sprints/client';
import { ColumnChart } from './ColumnChart';
import type { ReleaseReport, ReportClient, ScopeBurndown } from './client';
import { LineChart } from './LineChart';

export const SCOPE_REPORTS = ['release-burndown', 'outcome-burndown', 'release-report'] as const;
export type ScopeReportKind = (typeof SCOPE_REPORTS)[number];

export interface ScopeReportProps {
  board: Board;
  kind: ScopeReportKind;
  client: ReportClient;
}

/**
 * A Scrum board's release and outcome reports (M1-062; RPT-001): the release or outcome burndown
 * (the remaining work at each sprint, completed and added work per sprint, and a forecast at the
 * board's velocity) and the release report (scope and completed work by day, the planned date
 * and a forecast at the recent pace). Values follow the board's estimation statistic.
 */
export function ScopeReport({ board, kind, client }: ScopeReportProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const trackId = board.location.type === 'track' ? board.location.track.id : null;
  const [releases, setReleases] = useState<{ id: number; name: string }[] | null>(null);
  const [release, setRelease] = useState<number | null>(null);
  const [outcomeText, setOutcomeText] = useState('');
  const [outcome, setOutcome] = useState<string | null>(null);
  const [burndown, setBurndown] = useState<ScopeBurndown | null>(null);
  const [report, setReport] = useState<ReleaseReport | null>(null);
  const [failed, setFailed] = useState(false);
  const forRelease = kind !== 'outcome-burndown';

  useEffect(() => {
    if (!forRelease) return;
    if (trackId === null) {
      setReleases([]);
      return;
    }
    let live = true;
    client.releases(trackId).then(
      (list) => {
        if (!live) return;
        setReleases(list);
        setRelease((current) => current ?? list[0]?.id ?? null);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, trackId, forRelease]);

  useEffect(() => {
    let live = true;
    setFailed(false);
    setBurndown(null);
    setReport(null);
    const fail = () => {
      if (live) setFailed(true);
    };
    if (kind === 'outcome-burndown') {
      if (outcome !== null) {
        client.outcomeBurndown(board.id, outcome).then((r) => live && setBurndown(r), fail);
      }
    } else if (release !== null) {
      if (kind === 'release-burndown') {
        client.releaseBurndown(board.id, release).then((r) => live && setBurndown(r), fail);
      } else {
        client.releaseReport(board.id, release).then((r) => live && setReport(r), fail);
      }
    }
    return () => {
      live = false;
    };
  }, [client, board.id, kind, release, outcome]);

  const statistic = burndown?.statistic.statistic ?? report?.statistic.statistic ?? 'ticketCount';
  const time = statistic === 'originalEstimate';
  const value = (v: number) => estimateText(t, v, statistic);
  const day = (date: string) =>
    intl.formatDate(new Date(`${date}T00:00:00Z`), {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });

  const picker = forRelease ? (
    releases && releases.length === 0 ? (
      <p className="report-empty">{t('reports.scope.noReleases')}</p>
    ) : (
      <div className="reports-controls">
        <div className="form-field">
          <label htmlFor={`${id}-release`}>{t('reports.scope.release')}</label>
          <select
            id={`${id}-release`}
            value={release ?? ''}
            onChange={(e) => setRelease(Number(e.target.value))}
          >
            {(releases ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    )
  ) : (
    <form
      className="reports-controls"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const text = outcomeText.trim();
        if (text) setOutcome(text);
      }}
    >
      <div className="form-field">
        <label htmlFor={`${id}-outcome`}>{t('reports.scope.outcome')}</label>
        <input
          id={`${id}-outcome`}
          value={outcomeText}
          placeholder={t('reports.scope.outcomeHint')}
          onChange={(e) => setOutcomeText(e.target.value)}
        />
      </div>
      <button type="submit" className="button-primary">
        {t('reports.scope.show')}
      </button>
    </form>
  );

  const burndownView = (b: ScopeBurndown) => {
    if (b.sprints.length === 0) {
      return <p className="report-empty">{t('reports.scope.noSprints')}</p>;
    }
    const first = b.sprints[0];
    const points = [...b.sprints.map((s) => s.start), b.now.remaining];
    return (
      <>
        {b.outcome && (
          <p className="report-note">
            <a href={routeHref(`#/tickets/${encodeURIComponent(b.outcome.key)}`)}>
              {b.outcome.key}
            </a>{' '}
            {b.outcome.summary}
          </p>
        )}
        <p className="report-note">
          {t('reports.scope.summary', {
            remaining: value(b.now.remaining),
            scope: value(b.now.scope),
            completed: value(b.now.completed),
          })}{' '}
          {b.now.remaining === 0
            ? t('reports.scope.done')
            : b.forecast === null
              ? t('reports.scope.noForecast')
              : t('reports.scope.forecast', { velocity: value(b.velocity), count: b.forecast })}
        </p>
        <LineChart
          title={t('reports.scope.remainingTitle')}
          summary={t('reports.scope.remainingSummary', {
            start: value(first?.start ?? 0),
            now: value(b.now.remaining),
          })}
          xLabels={[...b.sprints.map((s) => s.name), t('reports.scope.now')]}
          series={[
            {
              id: 'remaining',
              label: t('reports.scope.remainingTitle'),
              tone: 'one',
              values: points,
            },
          ]}
          format={value}
          unit={time ? 3600 : 1}
          tableLabel={t('reports.table')}
          xHeader={t('reports.scope.moment')}
        />
        <ColumnChart
          title={t('reports.scope.sprintTitle')}
          summary={t('reports.scope.sprintSummary', { count: b.sprints.length })}
          categories={b.sprints.map((s) => ({ key: String(s.sprintId), label: s.name }))}
          series={[
            {
              id: 'completed',
              label: t('reports.scope.completed'),
              tone: 'one',
              values: b.sprints.map((s) => s.completed),
            },
            {
              id: 'added',
              label: t('reports.scope.added'),
              tone: 'two',
              values: b.sprints.map((s) => s.added),
            },
          ]}
          format={value}
          unit={time ? 3600 : 1}
          tableLabel={t('reports.table')}
          categoryHeader={t('reports.scope.sprint')}
        />
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard */}
        <section className="report-table" aria-label={t('reports.scope.table')} tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t('reports.scope.sprint')}</th>
                <th scope="col">{t('reports.scope.start')}</th>
                <th scope="col">{t('reports.scope.completed')}</th>
                <th scope="col">{t('reports.scope.added')}</th>
                <th scope="col">{t('reports.scope.removed')}</th>
                <th scope="col">{t('reports.scope.end')}</th>
              </tr>
            </thead>
            <tbody>
              {b.sprints.map((s) => (
                <tr key={s.sprintId}>
                  <th scope="row">{s.name}</th>
                  <td>{value(s.start)}</td>
                  <td>{value(s.completed)}</td>
                  <td>{value(s.added)}</td>
                  <td>{value(s.removed)}</td>
                  <td>{value(s.end)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </>
    );
  };

  const releaseView = (r: ReleaseReport) => {
    const last = r.days[r.days.length - 1];
    return (
      <>
        <p className="report-note">
          {r.release.shippedAt
            ? t('reports.release.shipped', { date: day(r.release.shippedAt.slice(0, 10)) })
            : r.release.releaseDate
              ? t('reports.release.planned', { date: day(r.release.releaseDate) })
              : t('reports.release.unplanned')}{' '}
          {r.forecast
            ? t('reports.release.forecast', { date: day(r.forecast) })
            : t('reports.release.noForecast')}
        </p>
        <LineChart
          title={t('reports.release.title')}
          summary={t('reports.release.summary', {
            completed: value(last?.completed ?? 0),
            scope: value(last?.scope ?? 0),
          })}
          xLabels={r.days.map((d) => day(d.date))}
          series={[
            {
              id: 'completed',
              label: t('reports.release.completed'),
              tone: 'one',
              values: r.days.map((d) => d.completed),
            },
            {
              id: 'scope',
              label: t('reports.release.scope'),
              tone: 'two',
              values: r.days.map((d) => d.scope),
            },
          ]}
          format={value}
          unit={time ? 3600 : 1}
          tableLabel={t('reports.table')}
          xHeader={t('reports.day')}
        />
      </>
    );
  };

  let body = null;
  if (failed) {
    body = (
      <p className="board-problem" role="alert">
        {kind === 'outcome-burndown' ? t('reports.scope.notFound') : t('reports.failed')}
      </p>
    );
  } else if (kind === 'outcome-burndown' && outcome === null) {
    body = <p className="report-empty">{t('reports.scope.pick')}</p>;
  } else if (burndown) body = burndownView(burndown);
  else if (report) body = releaseView(report);
  else if (!(forRelease && releases?.length === 0)) {
    body = <p className="report-empty">{t('reports.loading')}</p>;
  }

  return (
    <>
      {picker}
      {body && <div className="reports-body">{body}</div>}
    </>
  );
}
