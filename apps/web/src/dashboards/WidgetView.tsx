import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { type Translate, useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { ColumnChart } from '../reports/ColumnChart';
import { DonutChart, MAX_SLICES } from '../reports/DonutChart';
import { LineChart } from '../reports/LineChart';
import { ReportTable } from '../reports/ReportTable';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { PriorityIcon, TypeIcon } from '../shell/TicketIcons';
import { estimateText } from '../sprints/client';
import { useTicketChangeCount } from '../tickets/view/ticketChanges';
import type { DashboardClient, Widget } from './client';

const H = 3600;
const DAY = 86_400;
const STATIC = new Set<Widget['kind']>(['introduction', 'quick-links', 'track-summary']);

interface Value {
  id: string | null;
  name: string | null;
  kind: 'value' | 'none' | 'other';
  total: number;
}
/** A group of grouped tickets: its value, done count, first tickets and the search for all. */
interface Group extends Value {
  closed: number;
  tickets: GroupedTicket[];
  /** The search that finds every ticket of the group; null for the rest gathered as other. */
  query?: string | null;
}
interface GroupedTicket {
  id: number;
  key: string;
  summary: string;
  status: string;
  closed: boolean;
  assignee: string | null;
}
interface TicketRow {
  id: number;
  key: string;
  summary: string;
  status: string;
  type?: string;
  typeIcon?: string | null;
  priority: string | null;
  priorityLevel?: number | null;
  assignee: string | null;
}

export interface WidgetViewProps {
  dashboardId: number;
  widget: Widget;
  client: Pick<DashboardClient, 'widget'>;
}

/** Durations in hours, or in days once they pass three. */
function durations(t: Translate, intl: ReturnType<typeof useIntl>, max: number) {
  const days = max >= 72 * H;
  const unit = days ? DAY : H;
  return {
    unit,
    format: (v: number) =>
      t(days ? 'reports.days' : 'reports.hours', {
        value: intl.formatNumber(v / unit, { maximumFractionDigits: 1 }),
      }),
  };
}

/** The fields a pie can count by whose names the catalogue holds. */
const FIELD_NAMES: Record<string, MessageId> = {
  status: 'statistics.axis.status',
  priority: 'statistics.axis.priority',
  type: 'statistics.axis.type',
  track: 'statistics.axis.track',
  assignee: 'statistics.axis.assignee',
  requester: 'statistics.axis.requester',
  creator: 'statistics.axis.creator',
  closeReason: 'statistics.axis.closeReason',
  labels: 'statistics.axis.labels',
  targetRelease: 'statistics.axis.targetRelease',
  foundInRelease: 'statistics.axis.foundInRelease',
  area: 'statistics.axis.area',
};

/** A share of a whole as a bar in a fixed track, so its length follows the share. */
function ShareBar({ share }: { share: number }) {
  return (
    <span className="widget-share-track" aria-hidden="true">
      <span
        className="widget-share-bar"
        style={{ width: `${Math.round(Math.min(1, Math.max(0, share)) * 1000) / 10}%` }}
      />
    </span>
  );
}

/**
 * The title a widget shows: its own, or its kind's. An untitled pie names what it counts, such as
 * 'Tickets by Status', rather than the shape it is drawn as (PL-35).
 */
export function widgetTitle(t: Translate, widget: Widget): string {
  if (widget.title) return widget.title;
  const field = widget.kind === 'pie' ? widget.config.field : undefined;
  const name = typeof field === 'string' ? FIELD_NAMES[field] : undefined;
  if (name) return t('dashboards.title.byField', { field: t(name) });
  return t(`dashboards.kind.${widget.kind}` as MessageId);
}

/**
 * One widget's content (M1-064; RPT-005): its data read as the viewer, drawn by kind with the
 * report charts, or the reason it cannot show anything.
 */
export function WidgetView({ dashboardId, widget, client }: WidgetViewProps) {
  const t = useT();
  const intl = useIntl();
  const [data, setData] = useState<unknown>(undefined);
  const [failed, setFailed] = useState<'query' | 'other' | null>(null);
  const changes = useTicketChangeCount();

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again after an edit in the pop-up
  useEffect(() => {
    if (STATIC.has(widget.kind)) return;
    let live = true;
    setFailed(null);
    client.widget(dashboardId, widget.id).then(
      (d) => live && setData(d),
      (error) => {
        if (live)
          setFailed(
            error instanceof ApiError && error.code === 'invalid_query' ? 'query' : 'other',
          );
      },
    );
    return () => {
      live = false;
    };
  }, [client, dashboardId, widget.id, widget.kind, changes]);

  const title = widgetTitle(t, widget);
  const config = widget.config;
  const period = (config.period as 'day' | 'week' | 'month' | undefined) ?? 'day';
  const periodLabel = (date: string) =>
    intl.formatDate(
      new Date(`${date}T00:00:00Z`),
      period === 'month'
        ? { month: 'short', year: 'numeric', timeZone: 'UTC' }
        : { month: 'short', day: 'numeric', timeZone: 'UTC' },
    );
  const count = (v: number) => intl.formatNumber(v);
  const percent = (v: number) =>
    intl.formatNumber(v, { style: 'percent', maximumFractionDigits: 0 });
  const valueName = (v: Value) =>
    v.kind === 'none'
      ? t('dashboards.value.none')
      : v.kind === 'other'
        ? t('dashboards.value.other')
        : (v.name ?? v.id ?? '');
  /** The name of the field a table counts by, heading its first column (not 'Value'). */
  const fieldHeader = (d: {
    field?: string | undefined;
    fieldName?: string | null | undefined;
  }) => {
    const known = d.field ? FIELD_NAMES[d.field] : undefined;
    return known ? t(known) : (d.fieldName ?? t('dashboards.widget.value'));
  };

  if (widget.kind === 'introduction') {
    const text = String(config.text ?? '');
    return (
      <div className="widget-text">
        {text
          .split(/\n{2,}/)
          .filter((p) => p.trim() !== '')
          .map((p) => (
            <p key={p}>{p}</p>
          ))}
      </div>
    );
  }
  if (widget.kind === 'quick-links') {
    const links = (config.links as { label: string; url: string }[] | undefined) ?? [];
    return links.length === 0 ? (
      <EmptyState compact title={t('dashboards.widget.noLinks')} />
    ) : (
      <ul className="widget-links">
        {links.map((l) => (
          <li key={`${l.label}-${l.url}`}>
            <a
              href={l.url}
              {...(l.url.startsWith('#') ? {} : { rel: 'noopener noreferrer', target: '_blank' })}
            >
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    );
  }
  if (failed) {
    return (
      <p className="board-problem" role="alert">
        {t(failed === 'query' ? 'dashboards.widget.badQuery' : 'dashboards.widget.failed')}
      </p>
    );
  }
  if (data === undefined) return <p className="report-loading">{t('reports.loading')}</p>;
  if (data === null) return <EmptyState compact title={t('dashboards.widget.noData')} />;
  const unavailable = (data as { unavailable?: string } | null)?.unavailable;
  if (unavailable) {
    return (
      <p className="report-empty">{t(`dashboards.unavailable.${unavailable}` as MessageId)}</p>
    );
  }

  switch (widget.kind) {
    case 'search-results':
    case 'assigned-to-me':
    case 'followed-tickets': {
      const d = data as { tickets: TicketRow[]; total: { count: number; exact: boolean } };
      if (d.tickets.length === 0)
        return <EmptyState compact title={t('dashboards.widget.noTickets')} />;
      return (
        <>
          <ul className="widget-tickets">
            {d.tickets.map((x) => (
              <li key={x.id}>
                <span className="widget-ticket-key">
                  <span className="ticket-icons">
                    {x.type && <TypeIcon name={x.type} icon={x.typeIcon} />}
                    {x.priority && <PriorityIcon name={x.priority} level={x.priorityLevel} />}
                  </span>
                  <a href={routeHref(`#/tickets/${encodeURIComponent(x.key)}`)}>{x.key}</a>
                </span>
                <span className="widget-ticket-summary">{x.summary}</span>
                <span className="widget-ticket-status">{x.status}</span>
              </li>
            ))}
          </ul>
          <p className="report-note">
            {t('dashboards.widget.shown', { shown: d.tickets.length, total: d.total.count })}
          </p>
        </>
      );
    }
    case 'created-vs-closed': {
      const d = data as {
        periods: string[];
        created: number[];
        closed: number[];
        cumulative: boolean;
      };
      return (
        <LineChart
          title={title}
          summary={t('dashboards.widget.cvcSummary', {
            created: d.created.reduce((s, v) => (d.cumulative ? v : s + v), 0),
            closed: d.closed.reduce((s, v) => (d.cumulative ? v : s + v), 0),
          })}
          xLabels={d.periods.map(periodLabel)}
          series={[
            {
              id: 'created',
              label: t('dashboards.widget.created'),
              tone: 'two',
              values: d.created,
            },
            { id: 'closed', label: t('dashboards.widget.closed'), tone: 'one', values: d.closed },
          ]}
          format={count}
          tableLabel={t('reports.table')}
          xHeader={t('dashboards.widget.period')}
        />
      );
    }
    case 'recently-created': {
      const d = data as { periods: string[]; created: number[] };
      return (
        <ColumnChart
          title={title}
          summary={t('dashboards.widget.recentSummary', {
            count: d.created.reduce((s, v) => s + v, 0),
          })}
          categories={d.periods.map((p) => ({ key: p, label: periodLabel(p) }))}
          series={[
            {
              id: 'created',
              label: t('dashboards.widget.created'),
              tone: 'one',
              values: d.created,
            },
          ]}
          format={count}
          tableLabel={t('reports.table')}
          categoryHeader={t('dashboards.widget.period')}
        />
      );
    }
    case 'average-age':
    case 'time-to-close': {
      const d = data as {
        periods: string[];
        age?: number[];
        average?: number[];
        closed?: number[];
      };
      // Nothing closed in the range: a line on 0h would read as closing taking no time.
      if (widget.kind === 'time-to-close' && d.closed?.every((c) => c === 0)) {
        return (
          <EmptyState compact title={t('dashboards.widget.noneClosed')}>
            {t('empty.reports.period')}
          </EmptyState>
        );
      }
      const values = d.age ?? d.average ?? [];
      const { unit, format } = durations(t, intl, Math.max(0, ...values));
      return (
        <LineChart
          title={title}
          summary={t(
            widget.kind === 'average-age'
              ? 'dashboards.widget.ageSummary'
              : 'dashboards.widget.closeSummary',
            { value: format(values[values.length - 1] ?? 0) },
          )}
          xLabels={d.periods.map(periodLabel)}
          series={[
            {
              id: 'value',
              label: t(
                widget.kind === 'average-age'
                  ? 'dashboards.widget.averageAge'
                  : 'dashboards.widget.averageTime',
              ),
              tone: 'one',
              values,
            },
          ]}
          format={format}
          unit={unit}
          tableLabel={t('reports.table')}
          xHeader={t('dashboards.widget.period')}
        />
      );
    }
    case 'pie': {
      const d = data as {
        field?: string;
        fieldName?: string | null;
        values: Value[];
        total: number;
      };
      const sorted = [...d.values].sort((a, b) => b.total - a.total);
      const slices =
        sorted.length <= MAX_SLICES
          ? sorted.map((v) => ({ id: v.id ?? v.kind, label: valueName(v), value: v.total }))
          : [
              ...sorted.slice(0, MAX_SLICES - 1).map((v) => ({
                id: v.id ?? v.kind,
                label: valueName(v),
                value: v.total,
              })),
              {
                id: '*rest',
                label: t('dashboards.value.other'),
                value: sorted.slice(MAX_SLICES - 1).reduce((s, v) => s + v.total, 0),
              },
            ];
      return (
        <DonutChart
          title={title}
          summary={t('dashboards.widget.pieSummary', { count: d.total })}
          slices={slices}
          format={count}
          formatShare={percent}
          formatEntry={(v, s) =>
            t('dashboards.widget.slice', { value: count(v), share: percent(s) })
          }
          tableLabel={t('reports.table')}
          headers={[fieldHeader(d), t('dashboards.widget.tickets'), t('dashboards.widget.share')]}
        />
      );
    }
    case 'ticket-statistics': {
      const d = data as {
        field?: string;
        fieldName?: string | null;
        values: Value[];
        total: number;
      };
      return (
        <ReportTable label={title}>
          <table className="report-numbers">
            <thead>
              <tr>
                <th scope="col">{fieldHeader(d)}</th>
                <th scope="col">{t('dashboards.widget.tickets')}</th>
                <th scope="col">{t('dashboards.widget.share')}</th>
              </tr>
            </thead>
            <tbody>
              {d.values.map((v) => (
                <tr key={`${v.kind}-${v.id}`}>
                  <th scope="row">{valueName(v)}</th>
                  <td>{count(v.total)}</td>
                  <td>
                    <span className="widget-share">
                      <ShareBar share={d.total === 0 ? 0 : v.total / d.total} />
                      {percent(d.total === 0 ? 0 : v.total / d.total)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t('dashboards.widget.total')}</th>
                <td>{count(d.total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </ReportTable>
      );
    }
    case 'two-dimensional': {
      const d = data as {
        fields?: { x: string; y: string };
        fieldNames?: { x: string | null; y: string | null };
        x: Value[];
        y: Value[];
        cells: number[][];
        total: number;
      };
      return (
        // Past the card's edge the table scrolls with a fade on the side that has more (D2, TR-12).
        <ReportTable label={title}>
          <table className="report-numbers report-two-dimensional">
            <thead>
              <tr>
                {/* The corner heads the rows with their field, inside the header band (S3-ST-8). */}
                <th scope="col">
                  {fieldHeader({ field: d.fields?.x, fieldName: d.fieldNames?.x })}
                </th>
                {d.y.map((v) => (
                  <th key={`${v.kind}-${v.id}`} scope="col">
                    {valueName(v)}
                  </th>
                ))}
                <th scope="col">{t('dashboards.widget.total')}</th>
              </tr>
            </thead>
            <tbody>
              {d.x.map((row, i) => (
                <tr key={`${row.kind}-${row.id}`}>
                  <th scope="row">{valueName(row)}</th>
                  {d.y.map((col, j) => (
                    <td key={`${col.kind}-${col.id}`}>{count(d.cells[i]?.[j] ?? 0)}</td>
                  ))}
                  <td>{count(row.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t('dashboards.widget.total')}</th>
                {d.y.map((col) => (
                  <td key={`${col.kind}-${col.id}`}>{count(col.total)}</td>
                ))}
                <td>{count(d.total)}</td>
              </tr>
            </tfoot>
          </table>
        </ReportTable>
      );
    }
    case 'sprint-burndown': {
      const d = data as {
        sprint: { name: string };
        statistic: { statistic: 'ticketCount' | 'originalEstimate' | 'field' };
        burnRemaining: boolean;
        dates: string[];
        guideline: { from: { value: number }; to: { date: string } };
        days: { date: string; remaining: number }[];
        end: { remaining: number };
        start: { remaining: number };
      };
      const time = d.statistic.statistic === 'originalEstimate' || d.burnRemaining;
      const format = (v: number) =>
        estimateText(t, v, time ? 'originalEstimate' : d.statistic.statistic);
      const byDate = new Map(d.days.map((x) => [x.date, x.remaining]));
      const last = d.dates.indexOf(d.guideline.to.date);
      const span = last > 0 ? last : d.dates.length - 1;
      return (
        <>
          <p className="report-note">{d.sprint.name}</p>
          <LineChart
            title={t('dashboards.widget.burndownOf', { sprint: d.sprint.name })}
            summary={t('sprints.charts.burndownSummary', {
              start: format(d.start.remaining),
              remaining: format(d.end.remaining),
            })}
            xLabels={d.dates.map(periodLabel)}
            series={[
              {
                id: 'remaining',
                label: t('sprints.charts.remaining'),
                tone: 'one',
                values: d.dates.map((x) => byDate.get(x) ?? null),
              },
              {
                id: 'guideline',
                label: t('sprints.charts.guideline'),
                tone: 'guide',
                values: d.dates.map((_, i) =>
                  i <= span ? d.guideline.from.value * (1 - i / Math.max(1, span)) : null,
                ),
              },
            ]}
            format={format}
            unit={time ? H : 1}
            tableLabel={t('reports.table')}
            xHeader={t('sprints.charts.day')}
          />
        </>
      );
    }
    case 'sprint-health': {
      const d = data as {
        sprint: { name: string };
        statistic: { statistic: 'ticketCount' | 'originalEstimate' | 'field' };
        elapsed: number;
        completed: number;
        scopeChange: number;
        remaining: number;
      };
      const signed = (v: number) =>
        intl.formatNumber(v, {
          style: 'percent',
          maximumFractionDigits: 0,
          signDisplay: 'exceptZero',
        });
      return (
        <>
          <p className="report-note">{d.sprint.name}</p>
          <dl className="report-stats">
            <div>
              <dt>{t('dashboards.health.elapsed')}</dt>
              <dd>{percent(d.elapsed)}</dd>
            </div>
            <div>
              <dt>{t('dashboards.health.completed')}</dt>
              <dd>{percent(d.completed)}</dd>
            </div>
            <div>
              <dt>{t('dashboards.health.scopeChange')}</dt>
              <dd>{signed(d.scopeChange)}</dd>
            </div>
            <div>
              <dt>{t('dashboards.health.remaining')}</dt>
              <dd>{estimateText(t, d.remaining, d.statistic.statistic)}</dd>
            </div>
          </dl>
        </>
      );
    }
    case 'days-remaining': {
      const d = data as { sprint: { name: string }; daysRemaining: number };
      return (
        <div className="widget-big">
          <strong>{count(d.daysRemaining)}</strong>
          <span>
            {t('dashboards.widget.daysRemaining', {
              count: d.daysRemaining,
              sprint: d.sprint.name,
            })}
          </span>
        </div>
      );
    }
    case 'average-time-in-status': {
      const d = data as { statuses: { status: { id: number; name: string }; average: number }[] };
      if (d.statuses.length === 0) return <EmptyState compact title={t('reports.time.empty')} />;
      const { unit, format } = durations(t, intl, Math.max(0, ...d.statuses.map((s) => s.average)));
      return (
        <ColumnChart
          title={title}
          summary={t('dashboards.widget.statusSummary', { count: d.statuses.length })}
          categories={d.statuses.map((s) => ({ key: String(s.status.id), label: s.status.name }))}
          series={[
            {
              id: 'average',
              label: t('reports.time.average'),
              tone: 'one',
              values: d.statuses.map((s) => s.average),
            },
          ]}
          format={format}
          unit={unit}
          tableLabel={t('reports.table')}
          categoryHeader={t('reports.time.status')}
        />
      );
    }
    case 'time-since': {
      const d = data as {
        field: string;
        periods: string[];
        counts: number[];
        cumulative: boolean;
      };
      const fieldName = t(`dashboards.dateField.${d.field}` as MessageId);
      const shown = d.cumulative ? (d.counts.at(-1) ?? 0) : d.counts.reduce((s, v) => s + v, 0);
      const series = [{ id: 'tickets', label: fieldName, tone: 'one' as const, values: d.counts }];
      const summary = t('dashboards.widget.sinceSummary', { count: shown, field: fieldName });
      return d.cumulative ? (
        <LineChart
          title={title}
          summary={summary}
          xLabels={d.periods.map(periodLabel)}
          series={series}
          format={count}
          tableLabel={t('reports.table')}
          xHeader={t('dashboards.widget.period')}
        />
      ) : (
        <ColumnChart
          title={title}
          summary={summary}
          categories={d.periods.map((p) => ({ key: p, label: periodLabel(p) }))}
          series={series}
          format={count}
          tableLabel={t('reports.table')}
          categoryHeader={t('dashboards.widget.period')}
        />
      );
    }
    case 'group-by': {
      const d = data as { values: Group[]; total: number; closed: number };
      if (d.total === 0) return <EmptyState compact title={t('dashboards.widget.noTickets')} />;
      return (
        <ul className="widget-groups" aria-label={title}>
          {d.values.map((v) => (
            <li key={`${v.kind}-${v.id}`}>
              <p className="widget-group-head">
                <strong>{valueName(v)}</strong>
                <span className="widget-share">
                  <ShareBar share={v.total === 0 ? 0 : v.closed / v.total} />
                  {t('dashboards.widget.groupDone', {
                    closed: count(v.closed),
                    total: count(v.total),
                  })}
                </span>
              </p>
              {v.tickets.length > 0 && (
                <ul className="widget-tickets">
                  {v.tickets.map((x) => (
                    <li key={x.id}>
                      <span className="widget-ticket-key">
                        <a href={routeHref(`#/tickets/${encodeURIComponent(x.key)}`)}>{x.key}</a>
                      </span>
                      <span className="widget-ticket-summary">{x.summary}</span>
                      <span className="widget-ticket-status">{x.status}</span>
                    </li>
                  ))}
                </ul>
              )}
              {v.tickets.length < v.total && v.kind !== 'other' && (
                // The rest of a long group is a search away, never out of reach (S3-ST-2).
                <p className="report-note widget-group-more">
                  {t('dashboards.widget.shown', { shown: v.tickets.length, total: v.total })}
                  {v.query && (
                    <>
                      {' '}
                      <a
                        href={routeHref(
                          `#/search?${new URLSearchParams({ q: v.query }).toString()}`,
                        )}
                      >
                        {t('dashboards.widget.groupAll', { total: v.total })}
                      </a>
                    </>
                  )}
                </p>
              )}
            </li>
          ))}
        </ul>
      );
    }
    case 'workload': {
      const d = data as {
        field?: string;
        fieldName?: string | null;
        statistic: 'remainingEstimate' | 'originalEstimate' | 'timeSpent';
        values: (Value & { seconds: number; unestimated: number })[];
        total: number;
        seconds: number;
        unestimated: number;
      };
      const hours = (v: number) =>
        t('reports.hours', { value: intl.formatNumber(v / H, { maximumFractionDigits: 1 }) });
      const statistic = t(`dashboards.statistic.${d.statistic}` as MessageId);
      if (d.total === 0) {
        // A release's open tickets: say why there are none, such as a release that shipped (S3-ST-9).
        return typeof config.release === 'number' && config.open === true ? (
          <EmptyState compact title={t('dashboards.widget.noOpenInRelease.title')}>
            {t('dashboards.widget.noOpenInRelease')}
          </EmptyState>
        ) : (
          <EmptyState compact title={t('dashboards.widget.noTickets')} />
        );
      }
      if (config.view === 'pie') {
        const sorted = [...d.values]
          .filter((v) => v.seconds > 0)
          .sort((a, b) => b.seconds - a.seconds);
        const slice = (v: (typeof sorted)[number]) => ({
          id: v.id ?? v.kind,
          label: valueName(v),
          value: v.seconds,
        });
        const slices =
          sorted.length <= MAX_SLICES
            ? sorted.map(slice)
            : [
                ...sorted.slice(0, MAX_SLICES - 1).map(slice),
                {
                  id: '*rest',
                  label: t('dashboards.value.other'),
                  value: sorted.slice(MAX_SLICES - 1).reduce((s, v) => s + v.seconds, 0),
                },
              ];
        return slices.length === 0 ? (
          <EmptyState
            compact
            // The measure in the sentence's own case, not the option's label (second sweep).
            title={t('dashboards.widget.noTime', { statistic: d.statistic })}
          />
        ) : (
          <DonutChart
            title={title}
            summary={t('dashboards.widget.workSummary', {
              statistic,
              value: hours(d.seconds),
              count: d.total,
            })}
            slices={slices}
            format={hours}
            formatShare={percent}
            formatEntry={(v, s) =>
              t('dashboards.widget.slice', { value: hours(v), share: percent(s) })
            }
            tableLabel={t('reports.table')}
            headers={[fieldHeader(d), statistic, t('dashboards.widget.share')]}
          />
        );
      }
      return (
        <ReportTable label={title}>
          <table className="report-numbers">
            <thead>
              <tr>
                <th scope="col">{fieldHeader(d)}</th>
                <th scope="col">{t('dashboards.widget.tickets')}</th>
                <th scope="col">{statistic}</th>
                <th scope="col">{t('dashboards.widget.unestimated')}</th>
              </tr>
            </thead>
            <tbody>
              {d.values.map((v) => (
                <tr key={`${v.kind}-${v.id}`}>
                  <th scope="row">{valueName(v)}</th>
                  <td>{count(v.total)}</td>
                  <td>{hours(v.seconds)}</td>
                  <td>{count(v.unestimated)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t('dashboards.widget.total')}</th>
                <td>{count(d.total)}</td>
                <td>{hours(d.seconds)}</td>
                <td>{count(d.unestimated)}</td>
              </tr>
            </tfoot>
          </table>
        </ReportTable>
      );
    }
    case 'time-tracking': {
      const d = data as {
        tickets: number;
        estimated: number;
        original: number;
        remaining: number;
        spent: number;
        rows: (GroupedTicket & {
          original: number | null;
          remaining: number | null;
          spent: number;
        })[];
      };
      const hours = (v: number | null) =>
        v === null
          ? t('dashboards.value.none')
          : t('reports.hours', { value: intl.formatNumber(v / H, { maximumFractionDigits: 1 }) });
      // Nothing estimated and nothing logged: no totals of zero, no verdict on them (S3-ST-1).
      if (d.estimated === 0 && d.spent === 0 && d.remaining === 0) {
        return (
          <EmptyState compact title={t('dashboards.time.empty.title')}>
            {t('dashboards.time.empty')}
          </EmptyState>
        );
      }
      // Ahead when the estimate is more than the time spent and still to spend.
      const ahead = d.original - d.spent - d.remaining;
      return (
        <>
          <dl className="report-stats report-stats-time">
            <div>
              <dt>{t('dashboards.time.original')}</dt>
              <dd>{hours(d.original)}</dd>
            </div>
            <div>
              <dt>{t('dashboards.time.spent')}</dt>
              <dd>{hours(d.spent)}</dd>
            </div>
            <div>
              <dt>{t('dashboards.time.remaining')}</dt>
              <dd>{hours(d.remaining)}</dd>
            </div>
            <div className="report-stats-verdict">
              <dt>{t('dashboards.time.accuracy')}</dt>
              <dd>
                {d.estimated === 0
                  ? // With no original estimate there is nothing to be on, under or over (S3-ST-1).
                    t('dashboards.time.nothingToCompare')
                  : ahead === 0
                    ? t('dashboards.time.onEstimate')
                    : t(ahead > 0 ? 'dashboards.time.under' : 'dashboards.time.over', {
                        value: hours(Math.abs(ahead)),
                      })}
              </dd>
            </div>
          </dl>
          <p className="report-note">
            {t('dashboards.time.estimated', { estimated: d.estimated, tickets: d.tickets })}
          </p>
          {d.rows.length > 0 && (
            <ReportTable label={title}>
              <table className="report-numbers">
                <thead>
                  <tr>
                    <th scope="col">{t('dashboards.widget.ticket')}</th>
                    <th scope="col">{t('dashboards.time.original')}</th>
                    <th scope="col">{t('dashboards.time.spent')}</th>
                    <th scope="col">{t('dashboards.time.remaining')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.id}>
                      <th scope="row">
                        <a href={routeHref(`#/tickets/${encodeURIComponent(r.key)}`)}>{r.key}</a>{' '}
                        <span className="widget-ticket-summary">{r.summary}</span>
                      </th>
                      <td>{hours(r.original)}</td>
                      <td>{hours(r.spent)}</td>
                      <td>{hours(r.remaining)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ReportTable>
          )}
        </>
      );
    }
    default:
      return null;
  }
}
