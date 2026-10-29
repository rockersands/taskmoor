import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { ColumnChart } from '../reports/ColumnChart';
import { LineChart } from '../reports/LineChart';
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

  const charts = () => {
    if (!burndown && !velocity) return null;
    const out = [];
    if (burndown) {
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
    if (velocity) {
      const s = velocity.statistic.statistic;
      const format = chartValue(s, s === 'originalEstimate');
      out.push(
        velocity.sprints.length === 0 ? (
          <p key="velocity" className="sprint-empty">
            {t('sprints.charts.velocityNone')}
          </p>
        ) : (
          <div key="velocity" className="chart-group">
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
        ),
      );
    }
    return <div className="sprint-charts">{out}</div>;
  };

  const group = (title: MessageId, list: ReportTicket[]) => (
    <section className="sprint-section" aria-labelledby={`${id}-${title}`}>
      <h2 id={`${id}-${title}`}>{t(title)}</h2>
      {list.length === 0 ? (
        <p className="sprint-empty">{t('sprints.section.empty')}</p>
      ) : (
        <ul className="sprint-tickets">
          {list.map((ticket) => (
            <li key={ticket.id} className="sprint-ticket">
              <a href={`#/tickets/${encodeURIComponent(ticket.key)}`} className="sprint-ticket-key">
                {ticket.key}
              </a>
              <span className="sprint-ticket-summary">
                {ticket.summary}
                {ticket.addedAfterStart && (
                  <span className="sprint-scope-change">{t('sprints.report.addedAfterStart')}</span>
                )}
              </span>
              <span className="sprint-ticket-status">{ticket.status.name}</span>
              <span className="sprint-ticket-estimate">
                {ticket.estimateChanged
                  ? t('sprints.report.estimateChanged', {
                      from: est(ticket.estimateAtEntry),
                      to: est(ticket.estimate),
                    })
                  : est(ticket.estimate)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <section className="backlog-page" aria-labelledby={`${id}-title`}>
      <div className="board-header">
        <h1 id={`${id}-title`} className="page-title">
          {report
            ? t('sprints.report.title', { name: report.sprint.name })
            : t('sprints.report.link')}
        </h1>
        <a href={`#/boards/${boardId}/backlog`}>{t('sprints.report.toBacklog')}</a>
      </div>
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
          <dl className="sprint-report-totals">
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
          {group('sprints.report.completed', report.completed)}
          {group('sprints.report.notCompleted', report.notCompleted)}
          {group('sprints.report.removed', report.removed)}
        </>
      )}
    </section>
  );
}
