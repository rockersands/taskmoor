import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useCsvSeparator } from '../account/csvStyle';
import { useT } from '../i18n/I18nProvider';
import { dayText } from '../releases/crossTrackText';
import { EmptyState } from '../shell/EmptyState';
import { priorityName } from '../shell/priorityName';
import { typeName } from '../shell/seededNames';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import { CriticalPathList } from '../timeline/CriticalPathList';
import { dayNumber, localDay, type TimelineItem } from '../timeline/client';
import { slackMap } from '../timeline/critical';
import { DependencyList } from '../timeline/DependencyList';
import { dependenciesOf } from '../timeline/dependencies';
import { type TimelineGroup, TimelineView } from '../timeline/TimelineView';
import type { PlanGroup, PlanZoom } from './address';
import type { PlanCriticalPath, PlanTimeline, PlanTimelineItem } from './client';
import { DownloadMenu } from './DownloadMenu';
import { csvBlob, fileName, saveBlob } from './download';
import { draftCalls } from './drafting';
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
 *
 * The critical path (PLN-011; ADR-122 stage 9): a toggle among the tools, kept in the address
 * (`critical=1`), reads the path over the whole plan the viewer is shown; the bars it lists are
 * marked, the path is given in words below (`CriticalPathList`), and the CSV and the image carry
 * it while it is on.
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
  scenario,
  scenarios,
  onDrafted,
}: PlanSectionProps & { group: PlanGroup | null }) {
  const t = useT();
  // Commas or semicolons, as the person's spreadsheet opens them (T-263).
  const csvSeparator = useCsvSeparator();
  const intl = useIntl();
  const [data, setData] = useState<PlanTimeline | null>(null);
  const [failed, setFailed] = useState(false);
  const filterKey = JSON.stringify(filters);
  const listId = useId();
  const pathId = useId();
  // The critical path's toggle: in the address when the page keeps the view's position there.
  const [criticalHere, setCriticalHere] = useState(false);
  const criticalOn = client.criticalPath
    ? onPosition
      ? position?.critical === '1'
      : criticalHere
    : false;
  const setCritical = (on: boolean) => {
    if (onPosition) onPosition({ critical: on ? '1' : undefined });
    else setCriticalHere(on);
  };
  const [path, setPath] = useState<PlanCriticalPath | null>(null);
  const [pathFailed, setPathFailed] = useState(false);

  /** Counts requests: only the latest one's answer is drawn, however they come back. */
  const latest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: filters change by their values
  const load = useCallback(() => {
    const asked = ++latest.current;
    client.timeline(id, filters, false, scenario?.id).then(
      (d) => {
        if (asked !== latest.current) return;
        setData(d);
        setFailed(false);
      },
      () => {
        if (asked === latest.current) setFailed(true);
      },
    );
  }, [client, id, filterKey, scenario?.id]);
  useEffect(load, [load]);

  /** Counts reads of the path, as `latest` does the timeline's. */
  const pathLatest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: filters change by their values
  const loadPath = useCallback(() => {
    const asked = ++pathLatest.current;
    if (!criticalOn || !client.criticalPath) {
      setPath(null);
      setPathFailed(false);
      return;
    }
    client.criticalPath(id, filters, scenario?.id).then(
      (answer) => {
        if (asked !== pathLatest.current) return;
        setPath(answer);
        setPathFailed(false);
      },
      () => {
        if (asked === pathLatest.current) setPathFailed(true);
      },
    );
  }, [client, id, filterKey, scenario?.id, criticalOn]);
  useEffect(loadPath, [loadPath]);
  const reloadAll = useCallback(() => {
    load();
    loadPath();
  }, [load, loadPath]);
  useTicketChanges(reloadAll);
  const slack = useMemo(() => (path ? slackMap(path.listed) : null), [path]);
  /** The path read fresh for a file, while it is on. */
  const freshSlack = async () =>
    criticalOn && client.criticalPath
      ? slackMap((await client.criticalPath(id, filters, scenario?.id)).listed)
      : undefined;

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

  const today = localDay(now());
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
            const fresh = await client.timeline(id, filters, true, scenario?.id);
            const critical = await freshSlack();
            const name = dated('timeline', 'csv');
            saveBlob(name, csvBlob(timelineCsv(t, fresh, undefined, critical, csvSeparator)));
            return name;
          },
        },
        {
          key: 'image',
          label: t('plans.download.image'),
          failed: t('plans.download.imageFailed'),
          make: async () => {
            const fresh = await client.timeline(id, filters, true, scenario?.id);
            const critical = await freshSlack();
            const image = timelineSvg({
              t,
              // An image made in a scenario says so in its title (ADR-122 stage 6).
              plan: scenario
                ? t('plans.image.inScenario', { plan: plan.name, scenario: scenario.name })
                : plan.name,
              view: viewWords(t, filters, group, fresh.items),
              madeOn: t('plans.image.made', { day: dayText(intl, today) }),
              today: dayNumber(today),
              data: fresh,
              ...(group ? { groupOf: groupFor(fresh) } : {}),
              dependencies: dependenciesOf(fresh.items, fresh.links, fresh.blockersElsewhere),
              hiddenSources: plan.hiddenSources,
              ...(critical ? { critical } : {}),
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

  // In a scenario a change is a draft in it (ADR-122 stage 6), never the ticket's own.
  const drafts =
    scenario && scenarios
      ? draftCalls(
          id,
          scenario,
          scenarios,
          (key) => data.items.find((i) => i.key === key)?.id,
          onDrafted,
        )
      : null;

  return (
    <div className="timeline-page plan-timeline">
      <TimelineView
        {...(drafts && scenario ? { draft: { scenario: scenario.name, undo: drafts.undo } } : {})}
        {...(onPosition
          ? {
              zoom: position?.zoom ?? 'weeks',
              onZoom: (zoom: PlanZoom) => onPosition({ zoom: zoom === 'weeks' ? undefined : zoom }),
            }
          : {})}
        data={data}
        reschedule={drafts?.reschedule ?? client.reschedule}
        reload={reloadAll}
        now={now}
        {...(groupOf ? { groupOf } : {})}
        truncatedText={t('plans.truncated', { count: data.items.length })}
        dependencies={dependencies}
        {...(client.criticalPath
          ? { critical: { on: criticalOn, onToggle: setCritical, slack } }
          : {})}
        tools={
          <>
            {criticalOn && (
              <button
                type="button"
                className="button-secondary"
                onClick={() => document.getElementById(pathId)?.focus()}
              >
                {t('critical.goTo')}
              </button>
            )}
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
      {criticalOn && <CriticalPathList path={path} failed={pathFailed} headingId={pathId} />}
      <DependencyList
        dependencies={dependencies}
        headingId={listId}
        linkTypes={data?.linkTypes ?? []}
      />
    </div>
  );
}
