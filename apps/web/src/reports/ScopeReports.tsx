import { type FormEvent, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import type { Board } from '../boards/client';
import { dayText, shippedDay } from '../i18n/days';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { estimateText } from '../sprints/client';
import { noEstimates } from '../sprints/SprintReportPage';
import type { TrackClient } from '../tracks/client';
import { ColumnChart } from './ColumnChart';
import {
  type OutcomeReport,
  openingRelease,
  type ReleaseReport,
  type ReportClient,
  type ReportRelease,
  type ScopeBurndown,
} from './client';
import { LineChart } from './LineChart';
import { ReportTable } from './ReportTable';

export const SCOPE_REPORTS = [
  'release-burndown',
  'outcome-burndown',
  'release-report',
  'outcome-report',
] as const;
export type ScopeReportKind = (typeof SCOPE_REPORTS)[number];

export interface ScopeReportProps {
  board: Board;
  kind: ScopeReportKind;
  client: ReportClient;
  /** The track's outcomes, for the outcome reports' picker (D25); a typed key without them. */
  outcomes?: TrackClient['outcomes'];
}

/** How many pages of outcomes the picker reads at most: a track's planning, not its history. */
const OUTCOME_PAGES = 10;

/**
 * A Scrum board's release and outcome reports (M1-062; RPT-001): the release or outcome burndown
 * (the remaining work at each sprint, completed and added work per sprint, and a forecast at the
 * board's velocity), the release report (scope and completed work by day, the planned date
 * and a forecast at the recent pace) and the outcome report (the same for an outcome, with its
 * tickets done, still open and without an estimate). Values follow the board's estimation
 * statistic.
 */
export function ScopeReport({ board, kind, client, outcomes }: ScopeReportProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const trackId = board.location.type === 'track' ? board.location.track.id : null;
  // Inside a track the outcomes are listed to pick from; elsewhere a key is typed.
  const trackKey = outcomes && board.location.type === 'track' ? board.location.track.key : null;
  const [outcomeList, setOutcomeList] = useState<{ key: string; summary: string }[] | null>(null);
  const [releases, setReleases] = useState<ReportRelease[] | null>(null);
  const [release, setRelease] = useState<number | null>(null);
  const [outcomeText, setOutcomeText] = useState('');
  const [outcome, setOutcome] = useState<string | null>(null);
  const [burndown, setBurndown] = useState<ScopeBurndown | null>(null);
  const [report, setReport] = useState<ReleaseReport | null>(null);
  const [outcomeReport, setOutcomeReport] = useState<OutcomeReport | null>(null);
  const [failed, setFailed] = useState(false);
  const forRelease = kind !== 'outcome-burndown' && kind !== 'outcome-report';

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
        // The next release to ship, else the one that shipped last (T-359).
        setRelease((current) => current ?? openingRelease(list)?.id ?? null);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, trackId, forRelease]);

  // The track's outcomes to pick from, like its releases (D25): open ones first, the first chosen.
  useEffect(() => {
    if (forRelease || trackKey === null || !outcomes) return;
    let live = true;
    (async () => {
      const list: { key: string; summary: string }[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < OUTCOME_PAGES; page++) {
        const read = await outcomes(trackKey, cursor);
        list.push(...read.outcomes.map((o) => ({ key: o.key, summary: o.summary })));
        if (!read.next) break;
        cursor = read.next;
      }
      return list;
    })().then(
      (list) => {
        if (!live) return;
        setOutcomeList(list);
        setOutcome((current) => current ?? list[0]?.key ?? null);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [outcomes, trackKey, forRelease]);

  useEffect(() => {
    let live = true;
    setFailed(false);
    setBurndown(null);
    setReport(null);
    setOutcomeReport(null);
    const fail = () => {
      if (live) setFailed(true);
    };
    if (kind === 'outcome-burndown') {
      if (outcome !== null) {
        client.outcomeBurndown(board.id, outcome).then((r) => live && setBurndown(r), fail);
      }
    } else if (kind === 'outcome-report') {
      if (outcome !== null) {
        client.outcomeReport(board.id, outcome).then((r) => live && setOutcomeReport(r), fail);
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

  const statistic =
    burndown?.statistic.statistic ??
    report?.statistic.statistic ??
    outcomeReport?.statistic.statistic ??
    'ticketCount';
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
      <EmptyState title={t('reports.scope.noReleases')}>{t('empty.reports.noReleases')}</EmptyState>
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
  ) : trackKey !== null ? (
    outcomeList && outcomeList.length === 0 ? (
      <EmptyState title={t('reports.scope.noOutcomes')}>
        {t('reports.scope.noOutcomesHint')}
      </EmptyState>
    ) : (
      <div className="reports-controls">
        <div className="form-field">
          <label htmlFor={`${id}-outcome`}>{t('reports.scope.outcome')}</label>
          <select
            id={`${id}-outcome`}
            value={outcome ?? ''}
            onChange={(e) => setOutcome(e.target.value)}
          >
            {(outcomeList ?? []).map((o) => (
              <option key={o.key} value={o.key}>
                {t('reports.scope.outcomeOption', { key: o.key, summary: o.summary })}
              </option>
            ))}
          </select>
        </div>
      </div>
    )
  ) : (
    // A board outside any track has no outcomes to list: its key is typed instead.
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
      return (
        <EmptyState title={t('reports.scope.noSprints')}>{t('empty.reports.noSprints')}</EmptyState>
      );
    }
    // Nothing estimated: empty charts and '0 remaining of 0' would contradict the tickets in
    // the release, so it says why instead (TR-13), as the sprint report does.
    if (noEstimates(b.statistic.statistic, [b.now.scope])) {
      return (
        <EmptyState title={t('sprints.charts.noEstimates.title')}>
          {t('reports.scope.noEstimates')}
        </EmptyState>
      );
    }
    const first = b.sprints[0];
    const points = [...b.sprints.map((s) => s.start), b.now.remaining];
    // Work done or added while no sprint ran has its own column, so the columns add up to the
    // sentence above them: done is everything completed, remaining what was added less that.
    const outside =
      b.outside && (b.outside.completed > 0 || b.outside.added > 0 || b.outside.removed > 0)
        ? b.outside
        : null;
    const columns = [
      ...b.sprints.map((s) => ({ key: String(s.sprintId), label: s.name, ...s })),
      ...(outside ? [{ key: 'outside', label: t('reports.scope.outside'), ...outside }] : []),
    ];
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
          summary={
            outside
              ? t('reports.scope.sprintSummaryOutside', {
                  count: b.sprints.length,
                  completed: value(outside.completed),
                  added: value(outside.added),
                })
              : t('reports.scope.sprintSummary', { count: b.sprints.length })
          }
          categories={columns.map((c) => ({ key: c.key, label: c.label }))}
          series={[
            {
              id: 'completed',
              label: t('reports.scope.completed'),
              tone: 'one',
              values: columns.map((c) => c.completed),
            },
            {
              id: 'added',
              label: t('reports.scope.added'),
              tone: 'two',
              values: columns.map((c) => c.added),
            },
          ]}
          format={value}
          unit={time ? 3600 : 1}
          // The table below holds these numbers and more: no second way to them (TR-32).
          categoryHeader={t('reports.scope.sprint')}
        />
        <ReportTable label={t('reports.scope.table')}>
          <table className="data-table">
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
              {outside && (
                <tr>
                  <th scope="row">{t('reports.scope.outside')}</th>
                  <td />
                  <td>{value(outside.completed)}</td>
                  <td>{value(outside.added)}</td>
                  <td>{value(outside.removed)}</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </ReportTable>
      </>
    );
  };

  const byDay = (days: ReleaseReport['days'], of: 'release' | 'outcome') => {
    const last = days[days.length - 1];
    return (
      <LineChart
        title={t(of === 'outcome' ? 'reports.outcome.chartTitle' : 'reports.release.title')}
        summary={t(of === 'outcome' ? 'reports.outcome.chartSummary' : 'reports.release.summary', {
          completed: value(last?.completed ?? 0),
          scope: value(last?.scope ?? 0),
        })}
        // The measure the lines add up, since the tiles above count tickets (outcome report).
        measure={t(`reports.measure.${statistic}`)}
        xLabels={days.map((d) => day(d.date))}
        // Scope first, so Completed is drawn over it and stays seen once it reaches the scope.
        series={[
          {
            id: 'scope',
            label: t(`reports.measure.scope.${statistic}`),
            tone: 'two',
            values: days.map((d) => d.scope),
          },
          {
            id: 'completed',
            label: t(`reports.measure.completed.${statistic}`),
            tone: 'one',
            values: days.map((d) => d.completed),
          },
        ]}
        format={value}
        unit={time ? 3600 : 1}
        tableLabel={t('reports.table')}
        xHeader={t('reports.day')}
      />
    );
  };

  const outcomeView = (r: OutcomeReport) => (
    <>
      <p className="report-note">
        <a href={routeHref(`#/tickets/${encodeURIComponent(r.outcome.key)}`)}>{r.outcome.key}</a>{' '}
        {r.outcome.summary}
      </p>
      <dl className="report-stats">
        <div>
          <dt>{t('reports.outcome.done')}</dt>
          <dd>{r.counts.done}</dd>
        </div>
        <div>
          <dt>{t('reports.outcome.open')}</dt>
          <dd>{r.counts.open}</dd>
        </div>
        <div>
          <dt>{t('reports.outcome.unestimated')}</dt>
          <dd>{r.counts.unestimated}</dd>
        </div>
      </dl>
      <p className="report-note">
        {r.forecast
          ? t('reports.release.forecast', { date: dayText(intl, r.forecast) })
          : t('reports.release.noForecast')}
      </p>
      {byDay(r.days, 'outcome')}
      {r.tickets.length === 0 ? (
        <EmptyState compact title={t('reports.outcome.empty')}>
          {t('empty.reports.outcome')}
        </EmptyState>
      ) : (
        <ReportTable label={t('reports.outcome.tickets')}>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('reports.outcome.ticket')}</th>
                <th scope="col">{t('reports.outcome.status')}</th>
                <th scope="col">{t('reports.outcome.value')}</th>
              </tr>
            </thead>
            <tbody>
              {r.tickets.map((x) => (
                <tr key={x.id}>
                  <th scope="row">
                    <a href={routeHref(`#/tickets/${encodeURIComponent(x.key)}`)}>{x.key}</a>{' '}
                    {x.summary}
                  </th>
                  <td>{x.done ? t('reports.outcome.isDone', { status: x.status }) : x.status}</td>
                  <td>{x.estimated ? value(x.value) : t('reports.outcome.noEstimate')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ReportTable>
      )}
    </>
  );

  // A shipped release: the day it shipped on, as its page and the Releases list say, and no
  // forecast, which only an open release has (TR-15).
  const releaseView = (r: ReleaseReport) => (
    <>
      <p className="report-note">
        {r.release.shippedAt ? (
          t('reports.release.shipped', {
            date: dayText(intl, shippedDay(r.release.releaseDate, r.release.shippedAt)),
          })
        ) : (
          <>
            {r.release.releaseDate
              ? t('reports.release.planned', { date: dayText(intl, r.release.releaseDate) })
              : t('reports.release.unplanned')}{' '}
            {r.forecast
              ? t('reports.release.forecast', { date: dayText(intl, r.forecast) })
              : t('reports.release.noForecast')}
          </>
        )}
      </p>
      {byDay(r.days, 'release')}
    </>
  );

  let body = null;
  if (failed) {
    body = (
      <p className="board-problem" role="alert">
        {forRelease || trackKey !== null ? t('reports.failed') : t('reports.scope.notFound')}
      </p>
    );
  } else if (!forRelease && outcome === null) {
    body =
      trackKey !== null ? (
        outcomeList === null ? (
          <p className="report-loading">{t('reports.loading')}</p>
        ) : null
      ) : (
        <EmptyState
          compact
          title={t(kind === 'outcome-report' ? 'reports.outcome.pick' : 'reports.scope.pick')}
        />
      );
  } else if (burndown) body = burndownView(burndown);
  else if (report) body = releaseView(report);
  else if (outcomeReport) body = outcomeView(outcomeReport);
  else if (!(forRelease && releases?.length === 0)) {
    body = <p className="report-loading">{t('reports.loading')}</p>;
  }

  return (
    <>
      {picker}
      {body && <div className="glass-card reports-body">{body}</div>}
    </>
  );
}
