import { type ReactNode, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import type { Board } from '../boards/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { ColumnChart } from './ColumnChart';
import {
  type CumulativeFlow,
  type CycleParams,
  type CycleTime,
  type ReportClient,
  type ReportParams,
  reportClient,
  type TimeInStatus,
} from './client';
import { ScatterChart } from './ScatterChart';
import { StackedAreaChart } from './StackedAreaChart';

export const BOARD_REPORTS = [
  'cumulative-flow',
  'control-chart',
  'cycle-time',
  'time-in-status',
] as const;
export type BoardReport = (typeof BOARD_REPORTS)[number];

const TAB: Record<BoardReport, MessageId> = {
  'cumulative-flow': 'reports.tab.flow',
  'control-chart': 'reports.tab.control',
  'cycle-time': 'reports.tab.cycle',
  'time-in-status': 'reports.tab.time',
};
const PERIODS = ['14', '30', '90', '180', '365'] as const;
type Period = (typeof PERIODS)[number] | 'custom';
const HOUR = 3600;
const DAY = 86_400;

export interface BoardReportsPageProps {
  boardId: number;
  report: BoardReport;
  client?: ReportClient;
}

/**
 * A board's flow reports (M1-061; RPT-001): cumulative flow, the control chart, the cycle time
 * distribution and time in status, over a period of days and the board filters chosen. The
 * control chart and the distribution count the columns chosen as the work and average over
 * neighbouring tickets or over days.
 */
export function BoardReportsPage({
  boardId,
  report,
  client = reportClient,
}: BoardReportsPageProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [board, setBoard] = useState<Board | null>(null);
  const [period, setPeriod] = useState<Period>('30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filters, setFilters] = useState<string[]>([]);
  const [columns, setColumns] = useState<string[] | null>(null);
  const [average, setAverage] = useState<'tickets' | 'days'>('tickets');
  const [size, setSize] = useState('');
  const [flow, setFlow] = useState<CumulativeFlow | null>(null);
  const [cycle, setCycle] = useState<CycleTime | null>(null);
  const [times, setTimes] = useState<TimeInStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    client.board(boardId).then(setBoard, () => setFailed(true));
  }, [client, boardId]);

  useEffect(() => {
    let live = true;
    setFailed(false);
    const base: ReportParams = {
      ...(period === 'custom'
        ? { ...(from ? { from } : {}), ...(to ? { to } : {}) }
        : { days: Number(period) }),
      filters,
    };
    const fail = () => {
      if (live) setFailed(true);
    };
    if (report === 'cumulative-flow') {
      client.cumulativeFlow(boardId, base).then((r) => live && setFlow(r), fail);
    } else if (report === 'time-in-status') {
      client.timeInStatus(boardId, base).then((r) => live && setTimes(r), fail);
    } else {
      const n = Number(size);
      const params: CycleParams = {
        ...base,
        ...(columns ? { columns } : {}),
        average,
        ...(Number.isInteger(n) && n >= 1 ? { window: n } : {}),
      };
      client.cycleTime(boardId, params).then((r) => live && setCycle(r), fail);
    }
    return () => {
      live = false;
    };
  }, [client, boardId, report, period, from, to, filters, columns, average, size]);

  // Local dates as they are; instants on the report's time zone.
  const day = (date: string) =>
    intl.formatDate(new Date(`${date}T00:00:00Z`), {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  const moment = (zone: string) => (ms: number) =>
    intl.formatDate(new Date(ms), { month: 'short', day: 'numeric', timeZone: zone });
  /** Durations in hours, or in days once they run past three. */
  const durations = (max: number) => {
    const days = max >= 72 * HOUR;
    const unit = days ? DAY : HOUR;
    return {
      unit,
      format: (v: number) =>
        t(days ? 'reports.days' : 'reports.hours', {
          value: intl.formatNumber(v / unit, { maximumFractionDigits: 1 }),
        }),
    };
  };

  const stats = (c: CycleTime, format: (v: number) => string) => (
    <dl className="report-stats">
      {(
        [
          ['reports.stats.count', String(c.statistics.count)],
          ['reports.stats.average', format(c.statistics.average)],
          ['reports.stats.median', format(c.statistics.median)],
          ['reports.stats.p85', format(c.statistics.p85)],
          ['reports.stats.p95', format(c.statistics.p95)],
        ] as [MessageId, string][]
      ).map(([label, value]) => (
        <div key={label}>
          <dt>{t(label)}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );

  const flowView = (f: CumulativeFlow) => {
    const last = f.dates.length - 1;
    const total = f.columns.reduce((s, c) => s + (c.counts[last] ?? 0), 0);
    if (last < 0 || f.columns.every((c) => c.counts.every((v) => v === 0))) {
      return <p className="report-empty">{t('reports.flow.empty')}</p>;
    }
    const final = f.columns[f.columns.length - 1];
    const unmapped = f.unmapped[last] ?? 0;
    return (
      <>
        <StackedAreaChart
          title={t('reports.flow.title')}
          summary={t('reports.flow.summary', {
            days: f.dates.length,
            count: total,
            done: final?.counts[last] ?? 0,
            column: final?.name ?? '',
          })}
          xLabels={f.dates.map(day)}
          layers={f.columns.map((c) => ({ id: c.id, label: c.name, values: c.counts }))}
          format={(v) => intl.formatNumber(v)}
          tableLabel={t('reports.table')}
          xHeader={t('reports.day')}
        />
        {unmapped > 0 && (
          <p className="report-note">{t('reports.flow.unmapped', { count: unmapped })}</p>
        )}
      </>
    );
  };

  const controlView = (c: CycleTime) => {
    if (c.total === 0) return <p className="report-empty">{t('reports.control.empty')}</p>;
    const { unit, format } = durations(
      Math.max(...c.points.map((p) => Math.max(p.cycle, p.average + p.deviation))),
    );
    const zone = c.timeZone;
    return (
      <>
        {stats(c, format)}
        <ScatterChart
          title={t('reports.control.title')}
          summary={t('reports.control.summary', {
            count: c.statistics.count,
            median: format(c.statistics.median),
            average: format(c.statistics.average),
          })}
          points={c.points.map((p) => ({
            id: String(p.ticket.id),
            x: Date.parse(p.at),
            y: p.cycle,
            average: p.average,
            deviation: p.deviation,
            label: p.ticket.key,
            detail: p.ticket.summary,
            href: `#/tickets/${encodeURIComponent(p.ticket.key)}`,
          }))}
          from={Date.parse(c.start)}
          to={Date.parse(c.end)}
          formatX={moment(zone)}
          formatY={format}
          unit={unit}
          labels={{
            points: t('reports.control.points'),
            average: t('reports.control.average'),
            band: t('reports.control.band'),
            table: t('reports.table'),
            headers: [
              t('reports.control.ticket'),
              t('reports.control.finished'),
              t('reports.control.cycle'),
              t('reports.control.average'),
            ],
          }}
          note={
            c.points.length < c.total ? (
              <p className="report-note">
                {t('reports.control.newest', { shown: c.points.length, total: c.total })}
              </p>
            ) : undefined
          }
        />
      </>
    );
  };

  const cycleView = (c: CycleTime) => {
    if (c.total === 0) return <p className="report-empty">{t('reports.control.empty')}</p>;
    // Bins of hours read in hours, whatever their number.
    const { format } = durations(c.histogram.width >= DAY ? 72 * HOUR : 0);
    return (
      <>
        {stats(c, format)}
        <ColumnChart
          title={t('reports.cycle.title')}
          summary={t('reports.cycle.summary', {
            count: c.statistics.count,
            width: format(c.histogram.width),
            p85: format(c.statistics.p85),
          })}
          categories={c.histogram.counts.map((_, i) => ({
            key: String(i),
            label: t('reports.cycle.bin', {
              from: format(i * c.histogram.width),
              to: format((i + 1) * c.histogram.width),
            }),
          }))}
          series={[
            {
              id: 'tickets',
              label: t('reports.cycle.tickets'),
              tone: 'one',
              values: c.histogram.counts,
            },
          ]}
          format={(v) => intl.formatNumber(v)}
          tableLabel={t('reports.table')}
          categoryHeader={t('reports.cycle.range')}
        />
      </>
    );
  };

  const timeView = (r: TimeInStatus) => {
    if (r.statuses.length === 0) return <p className="report-empty">{t('reports.time.empty')}</p>;
    const { unit, format } = durations(Math.max(...r.statuses.map((s) => s.average)));
    const longest = r.statuses.reduce((a, b) => (b.average > a.average ? b : a));
    const columnName = (columnId: string | null) =>
      (columnId && board?.columns.find((c) => c.id === columnId)?.name) ||
      t('reports.time.noColumn');
    return (
      <>
        <ColumnChart
          title={t('reports.time.title')}
          summary={t('reports.time.summary', {
            count: r.statuses.length,
            status: longest.status.name,
            average: format(longest.average),
          })}
          categories={r.statuses.map((s) => ({ key: String(s.status.id), label: s.status.name }))}
          series={[
            {
              id: 'average',
              label: t('reports.time.average'),
              tone: 'one',
              values: r.statuses.map((s) => s.average),
            },
          ]}
          format={format}
          unit={unit}
          tableLabel={t('reports.table')}
          categoryHeader={t('reports.time.status')}
        />
        <div className="report-table">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('reports.time.status')}</th>
                <th scope="col">{t('reports.time.column')}</th>
                <th scope="col">{t('reports.time.tickets')}</th>
                <th scope="col">{t('reports.time.average')}</th>
                <th scope="col">{t('reports.time.total')}</th>
                <th scope="col">{t('reports.time.entries')}</th>
              </tr>
            </thead>
            <tbody>
              {r.statuses.map((s) => (
                <tr key={s.status.id}>
                  <th scope="row">{s.status.name}</th>
                  <td>{columnName(s.columnId)}</td>
                  <td>{intl.formatNumber(s.tickets)}</td>
                  <td>{format(s.average)}</td>
                  <td>{format(s.total)}</td>
                  <td>{intl.formatNumber(s.entries)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  };

  const current: { from: string; to: string } | null =
    report === 'cumulative-flow' ? flow : report === 'time-in-status' ? times : cycle;
  let body: ReactNode = <p className="report-empty">{t('reports.loading')}</p>;
  if (report === 'cumulative-flow' && flow) body = flowView(flow);
  else if (report === 'time-in-status' && times) body = timeView(times);
  else if (report === 'control-chart' && cycle) body = controlView(cycle);
  else if (report === 'cycle-time' && cycle) body = cycleView(cycle);

  const chosen = columns ?? cycle?.columns.filter((c) => c.chosen).map((c) => c.id) ?? [];
  const toggleColumn = (columnId: string, on: boolean) => {
    const ids = (board?.columns ?? []).map((c) => c.id);
    setColumns(ids.filter((c) => (c === columnId ? on : chosen.includes(c))));
  };
  const toggleFilter = (filterId: string, on: boolean) =>
    setFilters((list) => (on ? [...list, filterId] : list.filter((f) => f !== filterId)));

  return (
    <section className="reports-page" aria-labelledby={`${id}-title`}>
      <div className="board-header">
        <h1 id={`${id}-title`} className="page-title">
          {board ? t('reports.title', { name: board.name }) : t('reports.titleLoading')}
        </h1>
        <a className="board-settings-link" href={`#/boards/${boardId}`}>
          {t('reports.back')}
        </a>
      </div>
      <nav className="reports-tabs" aria-label={t('reports.tabs')}>
        {BOARD_REPORTS.map((r) => (
          <a
            key={r}
            href={`#/boards/${boardId}/reports/${r}`}
            aria-current={r === report ? 'page' : undefined}
          >
            {t(TAB[r])}
          </a>
        ))}
      </nav>
      <div className="reports-controls">
        <div className="form-field">
          <label htmlFor={`${id}-period`}>{t('reports.period')}</label>
          <select
            id={`${id}-period`}
            value={period}
            onChange={(e) => {
              const next = e.target.value as Period;
              if (next === 'custom' && current) {
                setFrom(current.from);
                setTo(current.to);
              }
              setPeriod(next);
            }}
          >
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {t('reports.period.days', { count: Number(p) })}
              </option>
            ))}
            <option value="custom">{t('reports.period.custom')}</option>
          </select>
        </div>
        {period === 'custom' && (
          <>
            <div className="form-field">
              <label htmlFor={`${id}-from`}>{t('reports.from')}</label>
              <input
                id={`${id}-from`}
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-to`}>{t('reports.to')}</label>
              <input
                id={`${id}-to`}
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </>
        )}
        {(report === 'control-chart' || report === 'cycle-time') && (
          <>
            <div className="form-field">
              <label htmlFor={`${id}-average`}>{t('reports.average')}</label>
              <select
                id={`${id}-average`}
                value={average}
                onChange={(e) => {
                  setAverage(e.target.value as 'tickets' | 'days');
                  setSize('');
                }}
              >
                <option value="tickets">{t('reports.average.tickets')}</option>
                <option value="days">{t('reports.average.days')}</option>
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-window`}>
                {t(average === 'tickets' ? 'reports.window.tickets' : 'reports.window.days')}
              </label>
              <input
                id={`${id}-window`}
                type="number"
                min={1}
                max={10000}
                inputMode="numeric"
                value={size}
                placeholder={cycle ? String(cycle.averaging.size) : ''}
                onChange={(e) => setSize(e.target.value)}
              />
            </div>
          </>
        )}
      </div>
      {board && (report === 'control-chart' || report === 'cycle-time') && (
        <fieldset className="reports-choices">
          <legend>{t('reports.columns')}</legend>
          <p className="report-note">{t('reports.columnsHint')}</p>
          {board.columns.map((c) => {
            const on = chosen.includes(c.id);
            return (
              <label key={c.id} className="reports-check">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={on && chosen.length === 1}
                  onChange={(e) => toggleColumn(c.id, e.target.checked)}
                />
                {c.name}
              </label>
            );
          })}
        </fieldset>
      )}
      {board && board.boardFilters.length > 0 && (
        <fieldset className="reports-choices">
          <legend>{t('reports.filters')}</legend>
          {board.boardFilters.map((f) => (
            <label key={f.id} className="reports-check">
              <input
                type="checkbox"
                checked={filters.includes(f.id)}
                onChange={(e) => toggleFilter(f.id, e.target.checked)}
              />
              {f.name}
            </label>
          ))}
        </fieldset>
      )}
      {failed ? (
        <p className="board-problem" role="alert">
          {t('reports.failed')}
        </p>
      ) : (
        <div className="reports-body">
          {current && (
            <p className="report-note">
              {t('reports.window', { from: day(current.from), to: day(current.to) })}
            </p>
          )}
          {body}
        </div>
      )}
    </section>
  );
}
