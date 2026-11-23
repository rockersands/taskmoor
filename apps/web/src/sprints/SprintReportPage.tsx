import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { ColumnChart } from '../reports/ColumnChart';
import { LineChart } from '../reports/LineChart';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import {
  estimateText,
  type ReportTicket,
  type SprintBurndown,
  type SprintClient,
  type SprintReport,
  sprintClient,
  type Velocity,
} from './client';

export interface SprintReportPageProps {
  boardId: number;
  sprintId: number;
  client?: SprintClient;
  /** Inside a page that has its own title: the report's title is a level lower. */
  embedded?: boolean;
}

/**
 * Nothing to add up: the board estimates with time or a number field and every value is zero.
 * Charts and totals would then draw empty and read as contradictions ('Completed 0' above two
 * completed tickets), so the report explains instead (TR-13), as the control chart does.
 */
export const noEstimates = (statistic: SprintReport['statistic']['statistic'], values: number[]) =>
  statistic !== 'ticketCount' && values.every((v) => v === 0);

/** Whether a velocity chart would draw only zeros: sprints there are, but no estimate in them. */
const velocityWithoutEstimates = (velocity: Velocity) =>
  velocity.sprints.length > 0 &&
  noEstimates(
    velocity.statistic.statistic,
    velocity.sprints.flatMap((x) => [x.committed, x.completed]),
  );

/** The explanation in place of empty charts: why there is nothing, and where estimates are set. */
export function NoEstimates() {
  const t = useT();
  return (
    <EmptyState title={t('sprints.charts.noEstimates.title')}>
      {t('sprints.charts.noEstimates')}
    </EmptyState>
  );
}

/** A board's velocity: committed and completed per sprint, and the average (RPT-001 (2)). */
function VelocityChart({ velocity }: { velocity: Velocity }) {
  const t = useT();
  const s = velocity.statistic.statistic;
  const format = (v: number) => estimateText(t, v, s);
  if (velocity.sprints.length === 0) {
    return <EmptyState compact title={t('sprints.charts.velocityNone')} />;
  }
  if (velocityWithoutEstimates(velocity)) return <NoEstimates />;
  return (
    <div className="chart-group">
      <ColumnChart
        title={t('sprints.charts.velocity')}
        summary={t('sprints.charts.velocitySummary', {
          count: velocity.sprints.length,
          average: format(velocity.average),
        })}
        categories={velocity.sprints.map((x) => ({ key: String(x.id), label: x.name }))}
        series={[
          {
            id: 'committed',
            label: t('sprints.charts.committed'),
            tone: 'two',
            values: velocity.sprints.map((x) => x.committed),
          },
          {
            id: 'completed',
            label: t('sprints.charts.completed'),
            tone: 'one',
            values: velocity.sprints.map((x) => x.completed),
          },
        ]}
        format={format}
        unit={s === 'originalEstimate' ? 3600 : 1}
        tableLabel={t('sprints.charts.table')}
        categoryHeader={t('sprints.charts.sprint')}
      />
      <p className="sprint-empty">
        {t('sprints.charts.velocityAverage', { average: format(velocity.average) })}
      </p>
    </div>
  );
}

/** The velocity chart alone, as a report of a track (ADR-116). */
export function VelocityReport({
  boardId,
  client = sprintClient,
}: {
  boardId: number;
  client?: SprintClient;
}) {
  const t = useT();
  const [velocity, setVelocity] = useState<Velocity | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    client.velocity(boardId).then(
      (v) => live && setVelocity(v),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, boardId]);
  if (failed) {
    return (
      <p className="board-problem" role="alert">
        {t('sprints.charts.failed')}
      </p>
    );
  }
  if (!velocity) return <p className="report-loading">{t('reports.loading')}</p>;
  return (
    <div className="glass-card reports-body">
      <VelocityChart velocity={velocity} />
    </div>
  );
}

/**
 * A sprint's report (M1-044; AGL-010 (2)): the tickets completed, not completed and removed,
 * those added after the start marked as scope change, estimates changed during the sprint, and
 * the totals by the board's estimation statistic. Above them (M1-060; RPT-001): the burndown
 * with its guideline, the burnup, and the board's velocity.
 */
export function SprintReportPage({
  boardId,
  sprintId,
  client = sprintClient,
  embedded = false,
}: SprintReportPageProps) {
  const t = useT();
  const id = useId();
  const intl = useIntl();
  const [report, setReport] = useState<SprintReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [burndown, setBurndown] = useState<SprintBurndown | null>(null);
  const [velocity, setVelocity] = useState<Velocity | null>(null);
  const [chartsFailed, setChartsFailed] = useState(false);

  useEffect(() => {
    client.report(sprintId).then(setReport, () => setFailed(true));
    client.burndown(sprintId).then(setBurndown, () => setChartsFailed(true));
    client.velocity(boardId).then(setVelocity, () => setChartsFailed(true));
  }, [client, sprintId, boardId]);

  const statistic = report?.statistic.statistic ?? 'originalEstimate';
  const est = (v: number | null | undefined) => estimateText(t, v, statistic);
  /** A chart value as the statistic reads; the remaining estimate is time. */
  const chartValue = (s: SprintBurndown['statistic']['statistic'], time: boolean) => (v: number) =>
    estimateText(t, v, time ? 'originalEstimate' : s);
  // Local dates, shown as they are (no time zone shift).
  const day = (date: string) =>
    intl.formatDate(new Date(`${date}T00:00:00Z`), {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });

  const empty =
    report !== null &&
    noEstimates(report.statistic.statistic, [
      ...Object.values(report.totals).filter((v): v is number => typeof v === 'number'),
      ...[...report.completed, ...report.notCompleted, ...report.removed].map(
        (x) => x.estimate ?? 0,
      ),
    ]);

  const charts = () => {
    if (!burndown && !velocity) return null;
    const out = [];
    // The burndown and the velocity both without estimates: one explanation across the row, not
    // the same card twice side by side with nothing saying which chart each replaces.
    const noneAtAll =
      burndown !== null && empty && (!velocity || velocityWithoutEstimates(velocity));
    if (noneAtAll) {
      out.push(<NoEstimates key="no-estimates" />);
    } else if (burndown && empty) {
      out.push(<NoEstimates key="burndown" />);
    } else if (burndown) {
      const s = burndown.statistic.statistic;
      const time = s === 'originalEstimate' || burndown.burnRemaining;
      const format = chartValue(s, time);
      const unit = time ? 3600 : 1;
      const byDate = new Map(burndown.days.map((d) => [d.date, d]));
      const labels = burndown.dates.map(day);
      const last = burndown.dates.indexOf(burndown.guideline.to.date);
      const span = last > 0 ? last : burndown.dates.length - 1;
      const guide = burndown.dates.map((_, i) =>
        i <= span ? burndown.guideline.from.value * (1 - i / Math.max(1, span)) : null,
      );
      const pick = (key: 'remaining' | 'scope' | 'completed') =>
        burndown.dates.map((d) => byDate.get(d)?.[key] ?? null);
      out.push(
        <LineChart
          key="burndown"
          title={t('sprints.charts.burndown')}
          summary={t('sprints.charts.burndownSummary', {
            start: format(burndown.start.remaining),
            remaining: format(burndown.end.remaining),
          })}
          xLabels={labels}
          series={[
            {
              id: 'remaining',
              label: t('sprints.charts.remaining'),
              tone: 'one',
              values: pick('remaining'),
            },
            { id: 'guideline', label: t('sprints.charts.guideline'), tone: 'guide', values: guide },
          ]}
          format={format}
          unit={unit}
          tableLabel={t('sprints.charts.table')}
          xHeader={t('sprints.charts.day')}
        />,
        <LineChart
          key="burnup"
          title={t('sprints.charts.burnup')}
          summary={t('sprints.charts.burnupSummary', {
            completed: format(burndown.end.completed),
            scope: format(burndown.end.scope),
          })}
          xLabels={labels}
          series={[
            {
              id: 'completed',
              label: t('sprints.charts.completed'),
              tone: 'one',
              values: pick('completed'),
            },
            { id: 'scope', label: t('sprints.charts.scope'), tone: 'two', values: pick('scope') },
          ]}
          format={format}
          unit={unit}
          tableLabel={t('sprints.charts.table')}
          xHeader={t('sprints.charts.day')}
        />,
      );
    }
    if (velocity && !noneAtAll) out.push(<VelocityChart key="velocity" velocity={velocity} />);
    return (
      <div className="sprint-charts">
        {out.map((chart) => (
          <div key={chart.key} className="glass-card sprint-chart">
            {chart}
          </div>
        ))}
      </div>
    );
  };

  // A table, so every value has its column and heading, the estimate's included (TR-11); keys
  // and summaries line up whatever the key's length (TR-22). In a narrow card each row folds
  // into two lines: key and summary, then status and estimate together (styles/boards.css).
  const group = (title: MessageId, list: ReportTicket[]) => (
    <section
      className="glass-card sprint-section sprint-report-group"
      aria-labelledby={`${id}-${title}`}
    >
      <h2 id={`${id}-${title}`}>{t(title)}</h2>
      {list.length === 0 ? (
        <EmptyState compact title={t('sprints.section.empty')} />
      ) : (
        <table className="data-table sprint-report-table">
          <thead>
            <tr>
              <th scope="col" className="sprint-report-key">
                {t('sprints.report.column.key')}
              </th>
              <th scope="col" className="sprint-report-summary">
                {t('sprints.report.column.summary')}
              </th>
              <th scope="col" className="sprint-report-status">
                {t('sprints.report.column.status')}
              </th>
              <th scope="col" className="sprint-report-estimate">
                {t('sprints.report.column.estimate')}
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((ticket) => (
              <tr key={ticket.id}>
                <td className="sprint-report-key">
                  <a href={routeHref(`#/tickets/${encodeURIComponent(ticket.key)}`)}>
                    {ticket.key}
                  </a>
                </td>
                <td className="sprint-report-summary">
                  {ticket.summary}
                  {ticket.addedAfterStart && (
                    <span className="sprint-scope-change">
                      {t('sprints.report.addedAfterStart')}
                    </span>
                  )}
                </td>
                <td className="sprint-report-status">{ticket.status.name}</td>
                <td className="sprint-report-estimate">
                  {ticket.estimateChanged
                    ? t('sprints.report.estimateChanged', {
                        from: est(ticket.estimateAtEntry),
                        to: est(ticket.estimate),
                      })
                    : est(ticket.estimate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );

  const title = report
    ? t('sprints.report.title', { name: report.sprint.name })
    : t('sprints.report.link');
  // Whether the sprint still runs or finished, and its dates, so a closed sprint's report never
  // reads like the running one's (S3-ST-5).
  const when = (() => {
    const sprint = report?.sprint;
    if (!sprint) return null;
    const date = (at: string) =>
      intl.formatDate(new Date(at), { month: 'short', day: 'numeric', year: 'numeric' });
    const start = sprint.startedAt ?? sprint.startAt;
    if (sprint.state === 'closed') {
      const completed = sprint.completedAt ?? sprint.endAt;
      if (!completed) return null;
      return start && sprint.endAt
        ? t('sprints.report.dates.closed', {
            completed: date(completed),
            start: date(start),
            end: date(sprint.endAt),
          })
        : t('sprints.report.dates.closedOnly', { completed: date(completed) });
    }
    // Only a started sprint has a report; one not started says nothing of its dates here.
    if (sprint.state !== 'active' || !start || !sprint.endAt) return null;
    return t('sprints.report.dates.active', { start: date(start), end: date(sprint.endAt) });
  })();
  // Inside a track the Backlog tab is right above: no pill repeats it (D7).
  const toBacklog = embedded ? null : (
    <a className="button-quiet" href={routeHref(`#/boards/${boardId}/backlog`)}>
      {t('sprints.report.toBacklog')}
    </a>
  );
  return (
    <section
      className={embedded ? 'sprint-report' : 'page sprint-report'}
      aria-labelledby={`${id}-title`}
    >
      {embedded ? (
        <div className="board-header">
          <h2 id={`${id}-title`} className="section-title">
            {title}
          </h2>
          {toBacklog}
        </div>
      ) : (
        <PageHeader
          titleId={`${id}-title`}
          title={title}
          purpose={t('purpose.sprintReport')}
          actions={toBacklog}
        />
      )}
      {when && <p className="report-note sprint-report-when">{when}</p>}
      {failed && (
        <p className="board-problem" role="alert">
          {t('sprints.report.failed')}
        </p>
      )}
      {chartsFailed && (
        <p className="board-problem" role="alert">
          {t('sprints.charts.failed')}
        </p>
      )}
      {charts()}
      {report && (
        <>
          {/* The totals sit on a card of their own, like the rest of the report (TR-14). */}
          {!empty && (
            <dl className="glass-card sprint-report-totals">
              <dt>{t('sprints.report.committed')}</dt>
              <dd>{est(report.totals.committed)}</dd>
              <dt>{t('sprints.report.added')}</dt>
              <dd>{est(report.totals.added)}</dd>
              <dt>{t('sprints.report.removedTotal')}</dt>
              <dd>{est(report.totals.removed)}</dd>
              <dt>{t('sprints.report.completedTotal')}</dt>
              <dd>{est(report.totals.completed)}</dd>
              {report.totals.remaining !== undefined && (
                <>
                  <dt>{t('sprints.report.remaining')}</dt>
                  <dd>{estimateText(t, report.totals.remaining, 'originalEstimate')}</dd>
                </>
              )}
            </dl>
          )}
          {group('sprints.report.completed', report.completed)}
          {group('sprints.report.notCompleted', report.notCompleted)}
          {group('sprints.report.removed', report.removed)}
        </>
      )}
    </section>
  );
}
