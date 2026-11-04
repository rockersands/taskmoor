import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { priorityName } from '../shell/priorityName';
import { typeName } from '../shell/seededNames';
import { type SummaryItem, type TrackClient, type TrackSummary, trackClient } from './client';

const OVERVIEW: Record<string, MessageId> = {
  open: 'summary.open',
  created: 'summary.created',
  closed: 'summary.closed',
  updated: 'summary.updated',
  due: 'summary.due',
};
const STAGES: Record<string, MessageId> = {
  new: 'search.stage.new',
  active: 'search.stage.active',
  closed: 'search.stage.closed',
};

/** The search page for a query. */
const searchHref = (query: string) =>
  routeHref(`#/search?${new URLSearchParams({ q: query }).toString()}`);

export interface TrackNumbersProps {
  trackKey: string;
  client?: TrackClient;
}

/**
 * A track's numbers (M1-064; RPT-006): its open, new, closed, updated and soon-due tickets, and the
 * open ones by stage, priority, type and assignee. Each number links to the search that finds
 * exactly those tickets, and is that search's count. They are the default Summary, and a widget of
 * a customized one (ADR-116).
 */
export function TrackNumbers({ trackKey, client = trackClient }: TrackNumbersProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [summary, setSummary] = useState<TrackSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    client.summary(trackKey).then(
      (s) => live && setSummary(s),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, trackKey]);

  if (failed) {
    return (
      <p className="board-problem" role="alert">
        {t('summary.numbersFailed')}
      </p>
    );
  }
  if (!summary) return <p className="report-loading">{t('reports.loading')}</p>;

  const number = (item: SummaryItem) =>
    item.exact ? intl.formatNumber(item.count) : t('summary.atLeast', { count: item.count });
  const section = (
    key: string,
    title: MessageId,
    items: SummaryItem[],
    label: (i: SummaryItem) => string,
  ) => {
    const max = Math.max(1, ...items.map((i) => i.count));
    return (
      <section className="glass-card summary-section" aria-labelledby={`${id}-${key}`}>
        <h2 id={`${id}-${key}`}>{t(title)}</h2>
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
      <dl className="report-stats">
        {summary.overview.map((item) => (
          <div key={item.id}>
            <dt>{t(OVERVIEW[item.id] ?? 'summary.open')}</dt>
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
        {section('priorities', 'summary.byPriority', summary.priorities, (i) =>
          i.name ? priorityName(t, i.name) : t('summary.noPriority'),
        )}
        {section('types', 'summary.byType', summary.types, (i) =>
          i.name ? typeName(t, i.name) : '',
        )}
        {section(
          'assignees',
          'summary.byAssignee',
          summary.assignees,
          (i) => i.name ?? t('summary.unassigned'),
        )}
      </div>
    </>
  );
}
