import { useEffect, useId, useMemo, useState } from 'react';
import type { Board } from '../boards/client';
import { DATE_FIELDS, WORK_STATISTICS } from '../dashboards/WidgetSettings';
import { WidgetView } from '../dashboards/WidgetView';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { FLOW_REPORTS, type FlowReport, FlowReportBody } from '../reports/BoardReportsPage';
import { type ReportClient, reportClient } from '../reports/client';
import { SCOPE_REPORTS, ScopeReport, type ScopeReportKind } from '../reports/ScopeReports';
import { navigate, routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { type Sprint, type SprintClient, sprintClient } from '../sprints/client';
import { SprintReportPage, VelocityReport } from '../sprints/SprintReportPage';
import {
  type StatisticKind,
  type StatisticSettings,
  type TrackClient,
  trackClient,
} from './client';
import { useTrackSections } from './trackSections';

const SPRINT_REPORTS = ['sprint-report', 'velocity'] as const;
type SprintReportKind = (typeof SPRINT_REPORTS)[number];

/** Reports of the track's tickets, over time and by field. */
const TICKET_REPORTS = [
  'created-vs-closed',
  'recently-created',
  'average-age',
  'time-to-close',
  'time-since',
  'pie',
  'ticket-statistics',
  'two-dimensional',
  'group-by',
] as const;
/** Reports of the time logged and still estimated (RPT-002). */
const TIME_REPORTS = [
  'time-tracking',
  'user-workload',
  'release-workload',
  'workload-pie',
] as const;
type TicketReportKind = (typeof TICKET_REPORTS)[number] | (typeof TIME_REPORTS)[number];

/** The widget kind each ticket report reads; the three workloads read one, set differently. */
const KIND: Record<TicketReportKind, StatisticKind> = {
  'created-vs-closed': 'created-vs-closed',
  'recently-created': 'recently-created',
  'average-age': 'average-age',
  'time-to-close': 'time-to-close',
  'time-since': 'time-since',
  pie: 'pie',
  'ticket-statistics': 'ticket-statistics',
  'two-dimensional': 'two-dimensional',
  'group-by': 'group-by',
  'time-tracking': 'time-tracking',
  'user-workload': 'workload',
  'release-workload': 'workload',
  'workload-pie': 'workload',
};

/** Every report of a track, grouped as its Statistics section shows them. */
export const TRACK_REPORTS = [
  ...FLOW_REPORTS,
  ...SPRINT_REPORTS,
  ...SCOPE_REPORTS,
  ...TICKET_REPORTS,
  ...TIME_REPORTS,
] as const;
export type TrackReport = (typeof TRACK_REPORTS)[number];

const GROUPS: { id: string; label: MessageId; reports: readonly TrackReport[] }[] = [
  { id: 'flow', label: 'statistics.group.flow', reports: FLOW_REPORTS },
  { id: 'sprints', label: 'statistics.group.sprints', reports: SPRINT_REPORTS },
  { id: 'releases', label: 'statistics.group.releases', reports: SCOPE_REPORTS },
  { id: 'tickets', label: 'statistics.group.tickets', reports: TICKET_REPORTS },
  { id: 'time', label: 'statistics.group.time', reports: TIME_REPORTS },
];

const NAMES: Record<TrackReport, MessageId> = {
  'cumulative-flow': 'reports.tab.flow',
  'control-chart': 'reports.tab.control',
  'cycle-time': 'reports.tab.cycle',
  'time-in-status': 'reports.tab.time',
  'sprint-report': 'sprints.report.link',
  velocity: 'sprints.charts.velocity',
  'release-burndown': 'reports.tab.releaseBurndown',
  'outcome-burndown': 'reports.tab.outcomeBurndown',
  'release-report': 'reports.tab.releaseReport',
  'outcome-report': 'reports.tab.outcomeReport',
  'created-vs-closed': 'dashboards.kind.created-vs-closed',
  'recently-created': 'dashboards.kind.recently-created',
  'average-age': 'dashboards.kind.average-age',
  'time-to-close': 'dashboards.kind.time-to-close',
  'time-since': 'dashboards.kind.time-since',
  pie: 'dashboards.kind.pie',
  'ticket-statistics': 'dashboards.kind.ticket-statistics',
  'two-dimensional': 'dashboards.kind.two-dimensional',
  'group-by': 'dashboards.kind.group-by',
  'time-tracking': 'dashboards.kind.time-tracking',
  'user-workload': 'statistics.report.userWorkload',
  'release-workload': 'statistics.report.releaseWorkload',
  'workload-pie': 'statistics.report.workloadPie',
};

const has = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

const reportHref = (trackKey: string, report: string) =>
  routeHref(`#/tracks/${encodeURIComponent(trackKey)}/statistics/${report}`);

/** The fields a report groups by, as the server's axes name them. */
const AXES: { id: string; label: MessageId }[] = [
  { id: 'status', label: 'statistics.axis.status' },
  { id: 'priority', label: 'statistics.axis.priority' },
  { id: 'type', label: 'statistics.axis.type' },
  { id: 'assignee', label: 'statistics.axis.assignee' },
  { id: 'requester', label: 'statistics.axis.requester' },
  { id: 'creator', label: 'statistics.axis.creator' },
  { id: 'closeReason', label: 'statistics.axis.closeReason' },
  { id: 'labels', label: 'statistics.axis.labels' },
  { id: 'targetRelease', label: 'statistics.axis.targetRelease' },
  { id: 'foundInRelease', label: 'statistics.axis.foundInRelease' },
  { id: 'area', label: 'statistics.axis.area' },
];
const DAYS = [14, 30, 90, 180, 365];
type Period = 'day' | 'week' | 'month';
type DateField = (typeof DATE_FIELDS)[number];
type WorkStatistic = (typeof WORK_STATISTICS)[number];

/** A report of the track's tickets, drawn like the dashboard widget of the same kind. */
function TicketReport({
  trackKey,
  trackId,
  report,
  client,
  reports,
}: {
  trackKey: string;
  trackId: number | null;
  report: TicketReportKind;
  client: TrackClient;
  reports: ReportClient;
}) {
  const t = useT();
  const id = useId();
  const kind = KIND[report];
  const [days, setDays] = useState(30);
  const [period, setPeriod] = useState<Period>('day');
  const [cumulative, setCumulative] = useState(false);
  const [dateField, setDateField] = useState<DateField>('created');
  const [field, setField] = useState(report === 'workload-pie' ? 'assignee' : 'status');
  const [x, setX] = useState('status');
  const [y, setY] = useState('priority');
  const [statistic, setStatistic] = useState<WorkStatistic>('remainingEstimate');
  const [open, setOpen] = useState(true);
  const [custom, setCustom] = useState<{ id: string; name: string }[]>([]);
  const [releases, setReleases] = useState<{ id: number; name: string }[] | null>(null);
  const [release, setRelease] = useState<number | null>(null);
  const byField = [
    'pie',
    'ticket-statistics',
    'two-dimensional',
    'group-by',
    'workload-pie',
  ].includes(report);
  const byRelease = report === 'time-tracking' || report === 'release-workload';
  const overTime = [
    'created-vs-closed',
    'recently-created',
    'average-age',
    'time-to-close',
    'time-since',
  ].includes(report);

  useEffect(() => {
    if (!byField) return;
    let live = true;
    client.groupFields(trackKey).then(
      (list) => live && setCustom(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [byField, client, trackKey]);

  useEffect(() => {
    if (!byRelease) return;
    if (trackId === null) {
      setReleases([]);
      return;
    }
    let live = true;
    reports.releases(trackId).then(
      (list) => {
        if (!live) return;
        setReleases(list);
        // A release's workload needs one; time tracking starts on the whole track.
        if (report === 'release-workload') setRelease((r) => r ?? list[0]?.id ?? null);
      },
      () => live && setReleases([]),
    );
    return () => {
      live = false;
    };
  }, [byRelease, reports, trackId, report]);

  const settings: StatisticSettings = useMemo(() => {
    switch (report) {
      case 'ticket-statistics':
      case 'pie':
      case 'group-by':
        return { field };
      case 'two-dimensional':
        return { x, y };
      case 'time-since':
        return { field: dateField, days, period, cumulative };
      case 'time-tracking':
        return release === null ? {} : { release };
      case 'user-workload':
        return { field: 'assignee', statistic: 'remainingEstimate', open: true };
      case 'release-workload':
        return {
          field: 'assignee',
          statistic: 'remainingEstimate',
          open: true,
          ...(release === null ? {} : { release }),
        };
      case 'workload-pie':
        return { field, statistic, open, view: 'pie' };
      default:
        return {
          days,
          period,
          ...(report === 'created-vs-closed' ? { cumulative } : {}),
        };
    }
  }, [report, days, period, cumulative, dateField, field, x, y, statistic, open, release]);
  const widgetClient = useMemo(
    () => ({ widget: () => client.statistics(trackKey, kind, settings) }),
    [client, trackKey, kind, settings],
  );

  const axis = (name: 'field' | 'x' | 'y', value: string, onChange: (next: string) => void) => (
    <div className="form-field">
      <label htmlFor={`${id}-${name}`}>{t(`dashboards.setting.${name}`)}</label>
      <select id={`${id}-${name}`} value={value} onChange={(e) => onChange(e.target.value)}>
        {AXES.map((a) => (
          <option key={a.id} value={a.id}>
            {t(a.label)}
          </option>
        ))}
        {custom.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </div>
  );
  const choice = <T extends string>(
    name: string,
    label: MessageId,
    value: T,
    options: readonly T[],
    text: (option: T) => string,
    onChange: (next: T) => void,
  ) => (
    <div className="form-field">
      <label htmlFor={`${id}-${name}`}>{t(label)}</label>
      <select id={`${id}-${name}`} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {text(o)}
          </option>
        ))}
      </select>
    </div>
  );

  if (report === 'release-workload' && releases?.length === 0) {
    return (
      <EmptyState title={t('statistics.noReleases.title')}>{t('statistics.noReleases')}</EmptyState>
    );
  }
  const waiting = report === 'release-workload' && release === null;

  return (
    <>
      <div className="reports-controls">
        {report === 'time-since' &&
          choice(
            'date',
            'dashboards.setting.dateField',
            dateField,
            DATE_FIELDS,
            (f) => t(`dashboards.dateField.${f}`),
            setDateField,
          )}
        {overTime && (
          <>
            {choice(
              'days',
              'reports.period',
              String(days),
              DAYS.map(String),
              (d) => t('reports.period.days', { count: Number(d) }),
              (d) => setDays(Number(d)),
            )}
            {choice(
              'period',
              'dashboards.setting.period',
              period,
              ['day', 'week', 'month'] as const,
              (p) => t(`dashboards.period.${p}`),
              setPeriod,
            )}
          </>
        )}
        {(report === 'created-vs-closed' || report === 'time-since') && (
          <label className="reports-check">
            <input
              type="checkbox"
              checked={cumulative}
              onChange={(e) => setCumulative(e.target.checked)}
            />
            {t('dashboards.setting.cumulative')}
          </label>
        )}
        {report === 'two-dimensional' ? (
          <>
            {axis('x', x, setX)}
            {axis('y', y, setY)}
          </>
        ) : (
          byField && axis('field', field, setField)
        )}
        {report === 'workload-pie' && (
          <>
            {choice(
              'statistic',
              'dashboards.setting.statistic',
              statistic,
              WORK_STATISTICS,
              (s) => t(`dashboards.statistic.${s}`),
              setStatistic,
            )}
            <label className="reports-check">
              <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
              {t('dashboards.setting.open')}
            </label>
          </>
        )}
        {byRelease && releases && releases.length > 0 && (
          <div className="form-field">
            <label htmlFor={`${id}-release`}>{t('reports.scope.release')}</label>
            <select
              id={`${id}-release`}
              value={release ?? ''}
              onChange={(e) => setRelease(e.target.value === '' ? null : Number(e.target.value))}
            >
              {report === 'time-tracking' && <option value="">{t('statistics.wholeTrack')}</option>}
              {releases.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {report === 'user-workload' || report === 'release-workload' ? (
        <p className="report-note">{t('statistics.workloadNote')}</p>
      ) : null}
      <div className="reports-body">
        {waiting ? (
          <p className="report-empty">{t('reports.loading')}</p>
        ) : (
          <WidgetView
            // Another report or other settings read the data again.
            key={JSON.stringify([report, settings])}
            dashboardId={0}
            widget={{
              id: report,
              kind,
              column: 0,
              title: t(NAMES[report]),
              config: { ...settings },
            }}
            client={widgetClient}
          />
        )}
      </div>
    </>
  );
}

/** A sprint's report in the track's tabs: the one asked for, else the running or latest sprint. */
function SprintReports({
  trackKey,
  board,
  sprintId,
  client,
}: {
  trackKey: string;
  board: Board;
  sprintId: number | null;
  client: SprintClient;
}) {
  const t = useT();
  const id = useId();
  const [sprints, setSprints] = useState<Sprint[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    client.sprints(board.id).then(
      (list) =>
        live &&
        setSprints(
          list.filter((s) => s.state !== 'future').sort((a, b) => b.sequence - a.sequence),
        ),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, board.id]);

  if (failed) {
    return (
      <p className="board-problem" role="alert">
        {t('sprints.report.failed')}
      </p>
    );
  }
  if (!sprints) return <p className="report-empty">{t('reports.loading')}</p>;
  const backlog = routeHref(`#/tracks/${encodeURIComponent(trackKey)}/backlog`);
  if (sprints.length === 0) {
    return (
      <EmptyState
        title={t('statistics.noSprints.title')}
        action={
          <a className="button-quiet" href={backlog}>
            {t('sprints.backlog.link')}
          </a>
        }
      >
        {t('statistics.noSprints')}
      </EmptyState>
    );
  }
  const asked = sprints.find((s) => s.id === sprintId);
  const chosen = asked ?? sprints.find((s) => s.state === 'active') ?? (sprints[0] as Sprint);
  return (
    <>
      <div className="reports-controls">
        <div className="form-field">
          <label htmlFor={`${id}-sprint`}>{t('statistics.sprint')}</label>
          <select
            id={`${id}-sprint`}
            value={chosen.id}
            onChange={(e) =>
              navigate(
                `#/tracks/${encodeURIComponent(trackKey)}/statistics/sprint-report/${e.target.value}`,
              )
            }
          >
            {sprints.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <SprintReportPage
        key={chosen.id}
        boardId={board.id}
        sprintId={chosen.id}
        client={client}
        embedded
        backlogHref={backlog}
      />
    </>
  );
}

export interface TrackStatisticsPageProps {
  trackKey: string;
  /** The track's one board (ADR-116). */
  board: Board;
  report: TrackReport;
  /** The sprint asked for in the address. */
  sprintId?: number | null;
  reports?: ReportClient;
  sprints?: SprintClient;
  client?: TrackClient;
}

/**
 * Every report of a track in one place (ADR-116; RPT-001, RPT-002, RPT-005): how the board's work
 * flows, its sprints, its releases and outcomes, its tickets, and the time logged and estimated on
 * them. All of it stays inside the track's tabs. A Kanban track does not list the reports that
 * follow sprints, as the server has none for it; an old link to one says what it needs instead of
 * failing.
 */
export function TrackStatisticsPage({
  trackKey,
  board,
  report,
  sprintId = null,
  reports = reportClient,
  sprints = sprintClient,
  client = trackClient,
}: TrackStatisticsPageProps) {
  const t = useT();
  const titleId = useId();
  const name = board.location.type === 'track' ? (board.location.track.name ?? trackKey) : trackKey;
  const isSprint = has<SprintReportKind>(SPRINT_REPORTS, report);
  const isScope = has<ScopeReportKind>(SCOPE_REPORTS, report);
  const trackId = board.location.type === 'track' ? board.location.track.id : null;
  const needsScrum = (isSprint || isScope) && board.kind !== 'scrum';
  const sections = useTrackSections();
  const hasSprints = board.kind === 'scrum' && sections?.sprints !== false;
  const groups = GROUPS.filter((g) => hasSprints || (g.id !== 'sprints' && g.id !== 'releases'));

  return (
    <section className="reports-page" aria-labelledby={titleId}>
      <PageHeader
        titleId={titleId}
        title={t('statistics.title', { name })}
        purpose={t('statistics.purpose')}
        about={t('statistics.about')}
      />
      <nav className="reports-tabs statistics-tabs" aria-label={t('reports.tabs')}>
        {groups.map((group) => (
          <fieldset key={group.id} className="statistics-tab-group">
            <legend>{t(group.label)}</legend>
            {group.reports.map((r) => (
              <a
                key={r}
                href={reportHref(trackKey, r)}
                aria-current={r === report ? 'page' : undefined}
              >
                {t(NAMES[r])}
              </a>
            ))}
          </fieldset>
        ))}
      </nav>
      {needsScrum ? (
        <EmptyState
          title={t('statistics.needsScrum.title', { report: t(NAMES[report]) })}
          action={
            board.mayConfigure ? (
              <a className="button-quiet" href={routeHref(`#/boards/${board.id}/settings`)}>
                {t('track.backlog.kanbanAction')}
              </a>
            ) : undefined
          }
        >
          {t('statistics.needsScrum')}
        </EmptyState>
      ) : has<FlowReport>(FLOW_REPORTS, report) ? (
        <FlowReportBody boardId={board.id} board={board} report={report} client={reports} />
      ) : isScope ? (
        <ScopeReport board={board} kind={report as ScopeReportKind} client={reports} />
      ) : report === 'sprint-report' ? (
        <SprintReports trackKey={trackKey} board={board} sprintId={sprintId} client={sprints} />
      ) : report === 'velocity' ? (
        <VelocityReport boardId={board.id} client={sprints} />
      ) : (
        <TicketReport
          trackKey={trackKey}
          trackId={trackId}
          report={report as TicketReportKind}
          client={client}
          reports={reports}
        />
      )}
    </section>
  );
}
