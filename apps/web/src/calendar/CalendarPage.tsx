import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { PageHeader } from '../shell/PageHeader';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import { dayNumber, isoDay, localDay } from '../timeline/client';
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
  const [month, setMonth] = useState(() => monthOf(dayNumber(localDay(now()))));
  const [data, setData] = useState<CalendarData | null>(null);
  const [failed, setFailed] = useState(false);
  const { first, last } = monthWeeks(month);

  /**
   * Counts readings: only the latest one's answer is drawn, however they come back. A move to a
   * month not drawn asks for the old weeks and the new month's at once (T-229), and the old ones
   * must not cover the new.
   */
  const latest = useRef(0);
  const load = useCallback(() => {
    const asked = ++latest.current;
    client.calendar(trackKey, isoDay(first), isoDay(last)).then(
      (d) => {
        if (asked !== latest.current) return;
        setData(d);
        setFailed(false);
      },
      () => {
        if (asked === latest.current) setFailed(true);
      },
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
