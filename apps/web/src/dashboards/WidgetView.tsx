import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { type Translate, useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { ColumnChart } from '../reports/ColumnChart';
import { DonutChart, MAX_SLICES } from '../reports/DonutChart';
import { LineChart } from '../reports/LineChart';
import { routeHref } from '../routing/router';
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

/** The title a widget shows: its own, or its kind's. */
export function widgetTitle(t: Translate, widget: Widget): string {
  return widget.title || t(`dashboards.kind.${widget.kind}` as MessageId);
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
      <p className="report-empty">{t('dashboards.widget.noLinks')}</p>
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
  if (data === undefined) return <p className="report-empty">{t('reports.loading')}</p>;
  if (data === null) return <p className="report-empty">{t('dashboards.widget.noData')}</p>;
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
        return <p className="report-empty">{t('dashboards.widget.noTickets')}</p>;
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
      const d = data as { periods: string[]; age?: number[]; average?: number[] };
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
      const d = data as { values: Value[]; total: number };
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
          headers={[
            t('dashboards.widget.value'),
            t('dashboards.widget.tickets'),
            t('dashboards.widget.share'),
          ]}
        />
      );
    }
    case 'ticket-statistics': {
      const d = data as { values: Value[]; total: number };
      return (
        <section className="report-table" aria-label={title}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t('dashboards.widget.value')}</th>
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
                      <span
                        className="widget-share-bar"
                        style={{ width: `${d.total === 0 ? 0 : (v.total / d.total) * 100}%` }}
                        aria-hidden="true"
                      />
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
        </section>
      );
    }
    case 'two-dimensional': {
      const d = data as { x: Value[]; y: Value[]; cells: number[][]; total: number };
      return (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
        <section className="report-table" aria-label={title} tabIndex={0}>
          <table>
            <thead>
              <tr>
                <td />
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
        </section>
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
      if (d.statuses.length === 0) return <p className="report-empty">{t('reports.time.empty')}</p>;
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
    default:
      return null;
  }
}
