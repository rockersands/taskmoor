import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import {
  estimateText,
  type ReportTicket,
  type SprintClient,
  type SprintReport,
  sprintClient,
} from './client';

export interface SprintReportPageProps {
  boardId: number;
  sprintId: number;
  client?: SprintClient;
}

/**
 * A sprint's report (M1-044; AGL-010 (2)): the tickets completed, not completed and removed,
 * those added after the start marked as scope change, estimates changed during the sprint, and
 * the totals by the board's estimation statistic.
 */
export function SprintReportPage({
  boardId,
  sprintId,
  client = sprintClient,
}: SprintReportPageProps) {
  const t = useT();
  const id = useId();
  const [report, setReport] = useState<SprintReport | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    client.report(sprintId).then(setReport, () => setFailed(true));
  }, [client, sprintId]);

  const statistic = report?.statistic.statistic ?? 'originalEstimate';
  const est = (v: number | null | undefined) => estimateText(t, v, statistic);

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
