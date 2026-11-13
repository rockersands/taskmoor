import { useCallback, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
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

/** A sprint's name without the track's name in front, when something is left after it. */
export function withoutTrackName(sprint: string, track: string): string {
  const name = track.trim();
  if (name === '' || !sprint.toLowerCase().startsWith(name.toLowerCase())) return sprint;
  const after = sprint.slice(name.length);
  // "Launch Sprint 1" loses "Launch"; "Launchpad 3" is another name, and keeps it.
  if (!/^[\s:·–—-]/.test(after)) return sprint;
  const rest = after.replace(/^[\s:·–—-]+/, '');
  return rest === '' ? sprint : rest;
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
          about={t('calendar.about')}
        />
        <p className="board-problem" role="alert">
          {t('calendar.notFound')}
        </p>
      </section>
    );
  }
  if (!data) return <p className="report-loading">{t('reports.loading')}</p>;
  // Inside a track its sprints need not repeat its name, so two of them tell apart (TR-18).
  const inTrack = {
    ...data,
    sprints: data.sprints.map((s) => ({ ...s, name: withoutTrackName(s.name, data.track.name) })),
  };

  return (
    <section className="page calendar-page" aria-labelledby={`${id}-title`}>
      {/* Titled by its section, the track named above it (D26); the tab bar leads to the rest (D7). */}
      <PageHeader
        titleId={`${id}-title`}
        title={t('track.section.calendar')}
        eyebrow={data.track.name}
        purpose={t('purpose.calendar')}
        about={t('calendar.about')}
      />
      <CalendarView
        data={inTrack}
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
