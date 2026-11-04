import { useCallback, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { PageHeader } from '../shell/PageHeader';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import { dayNumber, isoDay } from '../timeline/client';
import { CalendarView, monthOf, monthWeeks } from './CalendarView';
import { type CalendarClient, type CalendarData, calendarClient } from './client';

export interface CalendarPageProps {
  trackKey: string;
  client?: CalendarClient;
  /** Today, for the month shown first and the today mark. */
  now?: () => Date;
}

/**
 * A track's calendar (M1-049; AGL-017): a month of the track's tickets on their due and start
 * days, with its sprints and releases, drawn by `CalendarView`, which also moves them. Every move
 * is the ticket's own change, so its permission and history apply.
 */
export function CalendarPage({
  trackKey,
  client = calendarClient,
  now = () => new Date(),
}: CalendarPageProps) {
  const t = useT();
  const id = useId();
  const [month, setMonth] = useState(() => monthOf(dayNumber(now().toISOString().slice(0, 10))));
  const [data, setData] = useState<CalendarData | null>(null);
  const [failed, setFailed] = useState(false);
  const { first, last } = monthWeeks(month);

  const load = useCallback(() => {
    client.calendar(trackKey, isoDay(first), isoDay(last)).then(
      (d) => {
        setData(d);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [client, trackKey, first, last]);
  useEffect(load, [load]);
  // Its days can change in the ticket pop-up.
  useTicketChanges(load);

  if (failed) {
    return (
      <section className="page calendar-page" aria-labelledby={`${id}-title`}>
        <PageHeader
          titleId={`${id}-title`}
          title={t('track.section.calendar')}
          purpose={t('purpose.calendar')}
        />
        <p className="board-problem" role="alert">
          {t('calendar.notFound')}
        </p>
      </section>
    );
  }
  if (!data) return <p className="report-loading">{t('reports.loading')}</p>;

  return (
    <section className="page calendar-page" aria-labelledby={`${id}-title`}>
      <PageHeader
        titleId={`${id}-title`}
        title={t('calendar.title', { name: data.track.name })}
        purpose={t('purpose.calendar')}
        actions={
          <a
            className="button-quiet"
            href={routeHref(`#/tracks/${encodeURIComponent(data.track.key)}`)}
          >
            {t('releases.toSummary')}
          </a>
        }
      />
      <CalendarView
        data={data}
        month={month}
        onMonth={setMonth}
        move={client.move}
        reload={load}
        now={now}
        truncatedText={t('calendar.truncated')}
      />
    </section>
  );
}
