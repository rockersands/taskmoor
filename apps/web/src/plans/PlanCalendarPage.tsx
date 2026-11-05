import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarView, monthOf, monthWeeks } from '../calendar/CalendarView';
import { useT } from '../i18n/I18nProvider';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import { dayNumber, isoDay } from '../timeline/client';
import type { PlanCalendar } from './client';
import type { PlanSectionProps } from './PlanSummaryPage';

/**
 * A plan's Calendar (PLN-012): a month of its tickets across tracks on their due and start days,
 * with their tracks' sprints and releases, drawn by `CalendarView`; at most 10,000 tickets, and it
 * says so. Moving one is the ticket's own change, so its track's permission and history apply.
 */
export function PlanCalendarPage({ id, filters, client, now }: PlanSectionProps) {
  const t = useT();
  const [month, setMonth] = useState(() => monthOf(dayNumber(now().toISOString().slice(0, 10))));
  const [data, setData] = useState<PlanCalendar | null>(null);
  const [failed, setFailed] = useState(false);
  const { first, last } = monthWeeks(month);
  const filterKey = JSON.stringify(filters);

  /** Counts requests: only the latest one's answer is drawn, however they come back. */
  const latest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: filters change by their values
  const load = useCallback(() => {
    const asked = ++latest.current;
    client.calendar(id, filters, isoDay(first), isoDay(last)).then(
      (d) => {
        if (asked !== latest.current) return;
        setData(d);
        setFailed(false);
      },
      () => {
        if (asked === latest.current) setFailed(true);
      },
    );
  }, [client, id, filterKey, first, last]);
  useEffect(load, [load]);
  useTicketChanges(load);

  if (failed) {
    return (
      <p className="board-problem" role="alert">
        {t('plans.calendar.failed')}
      </p>
    );
  }
  if (!data) return <p className="report-loading">{t('reports.loading')}</p>;
  if (data.query === null) return null;

  return (
    <div className="calendar-page plan-calendar">
      <CalendarView
        data={data}
        month={month}
        onMonth={setMonth}
        move={client.move}
        reload={load}
        now={now}
        truncatedText={t('plans.truncated', { count: data.tickets.length })}
      />
    </div>
  );
}
