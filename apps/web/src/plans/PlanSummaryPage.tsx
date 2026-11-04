import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { searchHref } from '../releases/client';
import { EmptyState } from '../shell/EmptyState';
import type { Plan, PlanClient, PlanCount, PlanFilters, PlanSummary } from './client';

export interface PlanSectionProps {
  id: number;
  plan: Plan;
  filters: PlanFilters;
  client: PlanClient;
  now: () => Date;
}

const OVERVIEW: Record<string, MessageId> = {
  open: 'plans.summary.open',
  overdue: 'plans.summary.overdue',
  dueSoon: 'plans.summary.dueSoon',
  unscheduled: 'plans.summary.unscheduled',
  closedRecently: 'plans.summary.closedRecently',
};
const STAGES: Record<string, MessageId> = {
  new: 'search.stage.new',
  active: 'search.stage.active',
  closed: 'search.stage.closed',
};

/**
 * A plan's Summary (PLN-012): how many of its tickets there are, open, overdue, due within 7 days,
 * open without dates and closed in the last 7 days; then by stage, by track and the ten people with
 * most open tickets. Each number links to the search that finds exactly those tickets, and is that
 * search's count, as the person may see them.
 */
export function PlanSummaryPage({ id, filters, client }: PlanSectionProps) {
  const t = useT();
  const intl = useIntl();
  const sectionId = useId();
  const [summary, setSummary] = useState<PlanSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const filterKey = JSON.stringify(filters);

  // biome-ignore lint/correctness/useExhaustiveDependencies: filters change by their values
  useEffect(() => {
    let live = true;
    setFailed(false);
    client.summary(id, filters).then(
      (s) => live && setSummary(s),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, id, filterKey]);

  if (failed) {
    return (
      <p className="board-problem" role="alert">
        {t('plans.summary.failed')}
      </p>
    );
  }
  if (!summary) return <p className="report-loading">{t('reports.loading')}</p>;
  if (summary.query === null) return null;

  const number = (item: PlanCount) => intl.formatNumber(item.count);
  const section = (
    key: string,
    title: MessageId,
    items: PlanCount[],
    label: (i: PlanCount) => string,
  ) => {
    const max = Math.max(1, ...items.map((i) => i.count));
    return (
      <section className="glass-card summary-section" aria-labelledby={`${sectionId}-${key}`}>
        <h2 id={`${sectionId}-${key}`}>{t(title)}</h2>
        {items.length === 0 ? (
          <EmptyState compact title={t('summary.nothingOpen')} />
        ) : (
          <ul className="summary-list">
            {items.map((item) => (
              <li key={item.id}>
                <a
                  href={searchHref(item.query)}
                  aria-label={t('summary.linkLabel', { label: label(item), count: number(item) })}
                >
                  <span className="summary-label">{label(item)}</span>{' '}
                  <span className="summary-count">{number(item)}</span>
                </a>
                <span className="summary-bar" aria-hidden="true">
                  <span style={{ width: `${(item.count / max) * 100}%` }} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  };

  return (
    <>
      <p className="plan-total">
        <a href={searchHref(summary.total.query)}>
          {t('plans.summary.total', { count: summary.total.count })}
        </a>
      </p>
      <dl className="report-stats">
        {summary.overview.map((item) => (
          <div key={item.id}>
            <dt>{t(OVERVIEW[item.id] ?? 'plans.summary.open')}</dt>
            <dd>
              <a href={searchHref(item.query)}>{number(item)}</a>
            </dd>
          </div>
        ))}
      </dl>
      <div className="summary-sections">
        {section('stages', 'summary.byStage', summary.stages, (i) =>
          t(STAGES[i.id] ?? 'search.stage.new'),
        )}
        {section('tracks', 'plans.summary.byTrack', summary.tracks, (i) => i.name ?? '')}
        {section(
          'assignees',
          'plans.summary.byAssignee',
          summary.assignees,
          (i) => i.name ?? t('summary.unassigned'),
        )}
      </div>
    </>
  );
}
