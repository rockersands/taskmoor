import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { searchHref } from '../releases/client';
import { routeHref } from '../routing/router';
import { COMPACT_QUERY, useMediaQuery } from '../shell/useMediaQuery';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import { planHref } from './address';
import { CapacityDialog } from './CapacityDialog';
import type {
  CapacityCell,
  CapacityOf,
  CapacityWork,
  PeriodCapacity,
  PlanCapacity,
  PlanPeriod,
} from './client';
import type { PlanSectionProps } from './PlanSummaryPage';

/** How many periods the view shows at once. */
const PERIODS = 6;

/** One row of the view: a team, a member of one, unassigned work or everyone else's. */
interface Row {
  key: string;
  kind: 'team' | 'person' | 'unassigned' | 'others';
  id: number;
  name: string;
  meta: string | null;
  clause: string;
  capacity: CapacityOf | null;
  cells: (CapacityCell | CapacityWork)[];
  unscheduled: CapacityWork;
}

const isCell = (c: CapacityCell | CapacityWork): c is CapacityCell => 'load' in c;

/**
 * A plan's Capacity (T-089b; PLN-005, PLN-009; ADR-122 stage 3): for each of the plan's teams and
 * each of their members, the work due in each period against the capacity set for it, in the
 * plan's unit; then unassigned work and the work of people in none of the teams. Over capacity is
 * red and says so in words. Each count links to the search that finds exactly those tickets, as
 * the viewer sees them; a person's other work due then (outside the plan, filtered out or hidden
 * from the viewer) counts against their capacity as a number, never named. The plan's editors set
 * capacity per row in a dialog, for every period or one. On a phone each row is a card.
 */
export function PlanCapacityPage({ id, plan, filters, client, now }: PlanSectionProps) {
  const t = useT();
  const intl = useIntl();
  const headingId = useId();
  const compact = useMediaQuery(COMPACT_QUERY);
  const today = now().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [data, setData] = useState<PlanCapacity | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [status, setStatus] = useState('');
  const filterKey = JSON.stringify(filters);

  /** Counts requests: only the latest one's answer is drawn, however they come back. */
  const latest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: filters change by their values
  const load = useCallback(() => {
    const asked = ++latest.current;
    client.capacity(id, filters, from, PERIODS).then(
      (d) => {
        if (asked !== latest.current) return;
        setData(d);
        setFailed(false);
      },
      () => {
        if (asked === latest.current) setFailed(true);
      },
    );
  }, [client, id, filterKey, from]);
  useEffect(load, [load]);
  useTicketChanges(load);

  if (failed) {
    return (
      <p className="board-problem" role="alert">
        {t('plans.capacity.failed')}
      </p>
    );
  }
  if (!data) return <p className="report-empty">{t('reports.loading')}</p>;

  const date = (day: string, year = false) =>
    intl.formatDate(new Date(`${day}T00:00:00Z`), {
      month: 'short',
      day: 'numeric',
      ...(year ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });
  const periodLabel = (p: { start: string; end: string }, period: PlanPeriod) =>
    period.kind === 'month'
      ? intl.formatDate(new Date(`${p.start}T00:00:00Z`), {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : t('plans.capacity.range', { start: date(p.start), end: date(p.end) });
  const labels = data.periods.map((p) => periodLabel(p, data.period));
  const amount = (value: number) =>
    t(data.unit === 'hours' ? 'plans.capacity.hours' : 'plans.capacity.points', { value });
  const number = (value: number) => intl.formatNumber(value, { maximumFractionDigits: 2 });
  const tableName = t('plans.capacity.table');
  const first = data.periods[0];
  const last = data.periods.at(-1);

  const rows: Row[] = [];
  for (const team of data.teams) {
    rows.push({
      key: `team-${team.id}`,
      kind: 'team',
      id: team.id,
      name: team.name,
      meta: t('plans.capacity.teamMeta', { count: team.members.length }),
      clause: team.clause,
      capacity: team.capacity,
      cells: team.cells,
      unscheduled: team.unscheduled,
    });
    for (const m of team.members) {
      rows.push({
        key: `team-${team.id}-person-${m.id}`,
        kind: 'person',
        id: m.id,
        name: m.active ? m.name : t('plans.capacity.inactive', { name: m.name }),
        meta: null,
        clause: m.clause,
        capacity: m.capacity,
        cells: m.cells,
        unscheduled: m.unscheduled,
      });
    }
  }
  rows.push({
    key: 'unassigned',
    kind: 'unassigned',
    id: 0,
    name: t('plans.capacity.unassigned'),
    meta: null,
    clause: data.unassigned.clause,
    capacity: null,
    cells: data.unassigned.cells,
    unscheduled: data.unassigned.unscheduled,
  });
  rows.push({
    key: 'others',
    kind: 'others',
    id: 0,
    name: t('plans.capacity.others'),
    meta: null,
    clause: data.others.clause,
    capacity: null,
    cells: data.others.cells,
    unscheduled: data.others.unscheduled,
  });

  const link = (row: Row, clause: string, work: CapacityWork, period: string, due = true) => {
    const tickets = t('plans.capacity.tickets', { count: work.count });
    if (work.count === 0 || data.query === null) {
      return (
        <span className="capacity-count">
          {t(due ? 'plans.capacity.nothingDue' : 'plans.capacity.noneOpen')}
        </span>
      );
    }
    return (
      <a
        className="capacity-count"
        href={searchHref(`(${data.query}) AND ${row.clause} AND ${clause}`)}
        aria-label={t('plans.capacity.link', { tickets, who: row.name, period })}
      >
        {tickets}
      </a>
    );
  };

  const cellView = (row: Row, i: number) => {
    const work = row.cells[i] as CapacityCell | CapacityWork;
    const period = data.periods[i] as { clause: string };
    const capacity: PeriodCapacity | null = row.capacity?.periods[i] ?? null;
    const load = isCell(work) ? work.load : work.amount;
    const limit = capacity?.amount ?? null;
    const over = isCell(work) && work.over;
    return (
      <div className={over ? 'capacity-cell is-over' : 'capacity-cell'}>
        <span className="capacity-load">
          {row.capacity === null
            ? amount(load)
            : limit === null
              ? amount(load)
              : t('plans.capacity.loadOf', { load: number(load), capacity: amount(limit) })}
        </span>
        {limit !== null && limit >= 0 && (
          <span className="capacity-bar" aria-hidden="true">
            <span
              style={{
                width: `${limit === 0 ? (load > 0 ? 100 : 0) : Math.min(100, (load / limit) * 100)}%`,
              }}
            />
          </span>
        )}
        {over && (
          <strong className="capacity-over">
            {t('plans.capacity.over', {
              amount: amount(Math.round((load - (limit ?? 0)) * 100) / 100),
            })}
          </strong>
        )}
        {row.capacity !== null && limit === null && (
          <span className="capacity-muted">{t('plans.capacity.noCapacity')}</span>
        )}
        {capacity?.from === 'members' && (
          <span className="capacity-muted">{t('plans.capacity.fromMembers')}</span>
        )}
        {capacity?.note && <span className="capacity-note">{capacity.note}</span>}
        {link(row, period.clause, work, labels[i] ?? '')}
        {isCell(work) && work.elsewhere.count > 0 && (
          <span className="capacity-elsewhere">
            {t('plans.capacity.elsewhere', {
              amount: amount(work.elsewhere.amount),
              count: work.elsewhere.count,
            })}
          </span>
        )}
        {work.unestimated > 0 && (
          <span className="capacity-muted">
            {t('plans.capacity.unestimated', { count: work.unestimated })}
          </span>
        )}
      </div>
    );
  };

  const unscheduledView = (row: Row) => (
    <div className="capacity-cell">
      {row.unscheduled.count > 0 && (
        <span className="capacity-load">{amount(row.unscheduled.amount)}</span>
      )}
      {link(row, data.unscheduledClause, row.unscheduled, t('plans.capacity.unscheduled'), false)}
      {row.unscheduled.unestimated > 0 && (
        <span className="capacity-muted">
          {t('plans.capacity.unestimated', { count: row.unscheduled.unestimated })}
        </span>
      )}
    </div>
  );

  const setButton = (row: Row) =>
    data.editable && (row.kind === 'team' || row.kind === 'person') ? (
      <button
        type="button"
        className="button-secondary capacity-set"
        aria-label={t('plans.capacity.setFor', { name: row.name })}
        onClick={() => setEditing(row)}
      >
        {t('plans.capacity.set')}
      </button>
    ) : null;
  /** The period that holds today, marked in words as well. */
  const current = data.periods.findIndex((p) => p.start <= today && today <= p.end);
  const periodHead = (i: number) => (
    <>
      {labels[i]}
      {i === current && (
        <>
          {' '}
          <span className="capacity-now">{t('plans.capacity.now')}</span>
        </>
      )}
    </>
  );

  return (
    <section className="plan-capacity" aria-labelledby={headingId}>
      <div className="calendar-tools capacity-tools">
        <button type="button" className="button-secondary" onClick={() => setFrom(data.previous)}>
          {t('plans.capacity.earlier')}
        </button>
        <h2 id={headingId} aria-live="polite">
          {first && last
            ? t('plans.capacity.range', {
                start: date(first.start, true),
                end: date(last.end, true),
              })
            : null}
        </h2>
        <button type="button" className="button-secondary" onClick={() => setFrom(data.next)}>
          {t('plans.capacity.later')}
        </button>
        <button type="button" className="button-secondary" onClick={() => setFrom(today)}>
          {t('plans.capacity.current')}
        </button>
      </div>
      <p className="board-hint">
        {data.unit === 'hours'
          ? t('plans.capacity.hint.hours')
          : t('plans.capacity.hint.points', { field: data.pointsField?.name ?? '' })}{' '}
        {t('plans.capacity.hint.elsewhere')}
      </p>
      {(data.teams.length === 0 || (data.unit === 'points' && data.pointsField === null)) && (
        <ul className="plan-notices">
          {data.teams.length === 0 && (
            <li>
              {t('plans.capacity.noTeams')}{' '}
              {plan.editable && (
                <a href={routeHref(planHref(id, 'settings'))}>{t('plans.capacity.chooseTeams')}</a>
              )}
            </li>
          )}
          {data.unit === 'points' && data.pointsField === null && (
            <li>{t('plans.capacity.noPointsField')}</li>
          )}
        </ul>
      )}
      <p className="board-hint" role="status">
        {status}
      </p>
      {compact ? (
        <ul className="capacity-cards" aria-label={tableName}>
          {rows.map((row) => (
            <li key={row.key} className={`capacity-card glass-card is-${row.kind}`}>
              <div className="capacity-card-head">
                <h3 className="capacity-card-title">{row.name}</h3>
                {row.meta && <span className="capacity-muted">{row.meta}</span>}
                {setButton(row)}
              </div>
              <dl>
                {data.periods.map((p, i) => (
                  <div key={p.start} className={i === current ? 'is-current' : undefined}>
                    <dt>{periodHead(i)}</dt>
                    <dd>{cellView(row, i)}</dd>
                  </div>
                ))}
                <div>
                  <dt>{t('plans.capacity.unscheduled')}</dt>
                  <dd>{unscheduledView(row)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
        <section className="capacity-scroll glass-card" aria-label={tableName} tabIndex={0}>
          <table className="capacity-table">
            <thead>
              <tr>
                <th scope="col">{t('plans.capacity.who')}</th>
                {data.periods.map((p, i) => (
                  <th
                    scope="col"
                    key={p.start}
                    className={i === current ? 'is-current' : undefined}
                  >
                    {periodHead(i)}
                  </th>
                ))}
                <th scope="col">{t('plans.capacity.unscheduled')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className={`capacity-row is-${row.kind}`}>
                  <th scope="row">
                    <span className="capacity-name">{row.name}</span>
                    {row.meta && <span className="capacity-muted">{row.meta}</span>}
                    {setButton(row)}
                  </th>
                  {data.periods.map((p, i) => (
                    <td key={p.start}>{cellView(row, i)}</td>
                  ))}
                  <td>{unscheduledView(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {editing?.capacity && (
        <CapacityDialog
          subject={{
            kind: editing.kind === 'team' ? 'team' : 'person',
            id: editing.id,
            name: editing.name,
          }}
          unit={data.unit}
          periods={data.periods.map((p, i) => ({ start: p.start, label: labels[i] ?? p.start }))}
          capacity={editing.capacity}
          onClose={() => setEditing(null)}
          onSave={async (entries) => {
            // The unit and periods the amounts were typed for, refused once they change.
            const saved = await client.setCapacity(id, entries, {
              unit: data.unit,
              period: data.period,
            });
            if (saved === true) {
              setStatus(t('plans.capacity.saved', { name: editing.name }));
              setEditing(null);
              load();
            }
            return saved;
          }}
        />
      )}
    </section>
  );
}
