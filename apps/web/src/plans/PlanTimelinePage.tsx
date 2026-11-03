import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { priorityName } from '../shell/priorityName';
import { typeName } from '../shell/seededNames';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import type { TimelineItem } from '../timeline/client';
import { type TimelineGroup, TimelineView } from '../timeline/TimelineView';
import type { PlanGroup } from './address';
import type { PlanTimeline, PlanTimelineItem } from './client';
import type { PlanSectionProps } from './PlanSummaryPage';

/**
 * A plan's Timeline (PLN-012): the first 10,000 of its tickets across tracks as bars, drawn by
 * `TimelineView` with roll-ups, dependencies and the sprints and releases of their tracks, grouped
 * on the page by track, assignee, status, type or priority. Rescheduling is each ticket's own
 * change, so its track's permission and history apply.
 */
export function PlanTimelinePage({
  id,
  filters,
  client,
  now,
  group,
}: PlanSectionProps & { group: PlanGroup | null }) {
  const t = useT();
  const [data, setData] = useState<PlanTimeline | null>(null);
  const [failed, setFailed] = useState(false);
  const filterKey = JSON.stringify(filters);

  // biome-ignore lint/correctness/useExhaustiveDependencies: filters change by their values
  const load = useCallback(() => {
    client.timeline(id, filters).then(
      (d) => {
        setData(d);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [client, id, filterKey]);
  useEffect(load, [load]);
  useTicketChanges(load);

  // Grouped again when the grouping or the data change; `t` is new on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: t reads the same catalogue each time
  const groupOf = useMemo(() => {
    if (!group || !data) return undefined;
    const tracks = new Map(data.tracks.map((x) => [x.id, x]));
    return (raw: TimelineItem): TimelineGroup => {
      const item = raw as PlanTimelineItem;
      switch (group) {
        case 'track': {
          const track = tracks.get(item.trackId);
          return {
            id: String(item.trackId),
            label: track ? t('plans.filter.trackOption', { key: track.key, name: track.name }) : '',
          };
        }
        case 'assignee':
          return item.assignee
            ? { id: `u${item.assignee.id}`, label: item.assignee.name }
            : { id: 'none', label: t('summary.unassigned') };
        case 'status':
          return { id: item.status.name, label: item.status.name };
        case 'type':
          return { id: item.type, label: typeName(t, item.type) };
        case 'priority':
          return item.priority
            ? { id: item.priority, label: priorityName(t, item.priority) }
            : { id: 'none', label: t('summary.noPriority') };
      }
    };
  }, [group, data]);

  if (failed) {
    return (
      <p className="board-problem" role="alert">
        {t('plans.timeline.failed')}
      </p>
    );
  }
  if (!data) return <p className="report-empty">{t('reports.loading')}</p>;
  if (data.query === null) return null;
  if (data.items.length === 0) return <p className="report-empty">{t('plans.empty')}</p>;

  return (
    <div className="timeline-page plan-timeline">
      <TimelineView
        data={data}
        reschedule={client.reschedule}
        reload={load}
        now={now}
        {...(groupOf ? { groupOf } : {})}
        truncatedText={t('plans.truncated', { count: data.items.length })}
      />
    </div>
  );
}
