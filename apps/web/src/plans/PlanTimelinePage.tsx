import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { dayText } from '../releases/crossTrackText';
import { EmptyState } from '../shell/EmptyState';
import { priorityName } from '../shell/priorityName';
import { typeName } from '../shell/seededNames';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import { dayNumber, type TimelineItem } from '../timeline/client';
import { DependencyList } from '../timeline/DependencyList';
import { dependenciesOf } from '../timeline/dependencies';
import { type TimelineGroup, TimelineView } from '../timeline/TimelineView';
import type { PlanGroup, PlanZoom } from './address';
import type { PlanTimeline, PlanTimelineItem } from './client';
import { DownloadMenu } from './DownloadMenu';
import { fileName, saveBlob } from './download';
import type { PlanSectionProps } from './PlanSummaryPage';
import { timelineCsv } from './planExport';
import { IMAGE_ROWS, imageRows, svgToPng, timelineSvg, viewWords } from './planImage';

/**
 * A plan's Timeline (PLN-012): the first 10,000 of its tickets across tracks as bars, drawn by
 * `TimelineView` with roll-ups, dependencies and the sprints and releases of their tracks, grouped
 * on the page by track, assignee, status, type or priority. Rescheduling is each ticket's own
 * change, so its track's permission and history apply.
 *
 * Dependencies (PLN-006): lines between listed tickets, a badge beside each blocked bar that
 * counts its blockers and says when one is late, and the same as a list below the timeline
 * (`DependencyList`), which a button beside the zoom reaches at once. Blockers the timeline does
 * not list are only counted, never named.
 *
 * Its files (PLN-014) read the Timeline again for the file, as CSV or as an image of up to 400 rows.
 */
export function PlanTimelinePage({
  id,
  plan,
  filters,
  client,
  now,
  group,
  position,
  onPosition,
}: PlanSectionProps & { group: PlanGroup | null }) {
  const t = useT();
  const intl = useIntl();
  const [data, setData] = useState<PlanTimeline | null>(null);
  const [failed, setFailed] = useState(false);
  const filterKey = JSON.stringify(filters);
  const listId = useId();

  /** Counts requests: only the latest one's answer is drawn, however they come back. */
  const latest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: filters change by their values
  const load = useCallback(() => {
    const asked = ++latest.current;
    client.timeline(id, filters).then(
      (d) => {
        if (asked !== latest.current) return;
        setData(d);
        setFailed(false);
      },
      () => {
        if (asked === latest.current) setFailed(true);
      },
    );
  }, [client, id, filterKey]);
  useEffect(load, [load]);
  useTicketChanges(load);

  /** How a timeline's tickets group, on the page and in a file read for it. */
  const groupFor = (answer: PlanTimeline) => {
    const tracks = new Map(answer.tracks.map((x) => [x.id, x]));
    return (raw: TimelineItem): TimelineGroup => {
      const item = raw as PlanTimelineItem;
      switch (group as PlanGroup) {
        case 'track': {
          const track = tracks.get(item.trackId);
          return {
            id: String(item.trackId),
            label: !track
              ? ''
              : track.name === null
                ? track.key
                : t('plans.filter.trackOption', { key: track.key, name: track.name }),
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
  };
  // Grouped again when the grouping or the data change; `t` is new on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: t reads the same catalogue each time
  const groupOf = useMemo(() => (!group || !data ? undefined : groupFor(data)), [group, data]);
  const imageTotal = useMemo(() => (data ? imageRows(data, groupOf).total : 0), [data, groupOf]);
  const dependencies = useMemo(
    () => (data ? dependenciesOf(data.items, data.links, data.blockersElsewhere) : new Map()),
    [data],
  );

  if (failed) {
    return (
      <p className="board-problem" role="alert">
        {t('plans.timeline.failed')}
      </p>
    );
  }
  if (!data) return <p className="report-loading">{t('reports.loading')}</p>;
  if (data.query === null) return null;
  if (data.items.length === 0) {
    return <EmptyState title={t('plans.empty')}>{t('empty.planTickets.body')}</EmptyState>;
  }

  const today = now().toISOString().slice(0, 10);
  const dated = (view: string, extension: string) => fileName(plan.name, view, today, extension);
  const notes = [
    ...(data.truncated ? [t('plans.download.first', { count: data.items.length })] : []),
    ...(imageTotal > IMAGE_ROWS
      ? [t('plans.image.capped', { rows: IMAGE_ROWS, total: imageTotal })]
      : []),
  ];
  const download = (
    <DownloadMenu
      notes={notes}
      items={[
        {
          key: 'csv',
          label: t('plans.download.csv'),
          make: async () => {
            const fresh = await client.timeline(id, filters, true);
            const name = dated('timeline', 'csv');
            saveBlob(name, new Blob([timelineCsv(t, fresh)], { type: 'text/csv' }));
            return name;
          },
        },
        {
          key: 'image',
          label: t('plans.download.image'),
          failed: t('plans.download.imageFailed'),
          make: async () => {
            const fresh = await client.timeline(id, filters, true);
            const image = timelineSvg({
              t,
              plan: plan.name,
              view: viewWords(t, filters, group, fresh.items),
              madeOn: t('plans.image.made', { day: dayText(intl, today) }),
              today: dayNumber(today),
              data: fresh,
              ...(group ? { groupOf: groupFor(fresh) } : {}),
              dependencies: dependenciesOf(fresh.items, fresh.links, fresh.blockersElsewhere),
              hiddenSources: plan.hiddenSources,
              monthText: (day) =>
                intl.formatDate(new Date(day * 86_400_000), {
                  month: 'short',
                  year: 'numeric',
                  timeZone: 'UTC',
                }),
            });
            const name = dated('timeline', 'png');
            saveBlob(name, await svgToPng(image));
            return name;
          },
        },
      ]}
    />
  );

  return (
    <div className="timeline-page plan-timeline">
      <TimelineView
        {...(onPosition
          ? {
              zoom: position?.zoom ?? 'weeks',
              onZoom: (zoom: PlanZoom) => onPosition({ zoom: zoom === 'weeks' ? undefined : zoom }),
            }
          : {})}
        data={data}
        reschedule={client.reschedule}
        reload={load}
        now={now}
        {...(groupOf ? { groupOf } : {})}
        truncatedText={t('plans.truncated', { count: data.items.length })}
        dependencies={dependencies}
        tools={
          <>
            <button
              type="button"
              className="button-secondary"
              onClick={() => document.getElementById(listId)?.focus()}
            >
              {t('dependencies.goTo')}
            </button>
            {download}
          </>
        }
      />
      <DependencyList dependencies={dependencies} headingId={listId} />
    </div>
  );
}
